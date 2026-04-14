/**
 * Lead Pipeline — Ponto único de entrada para todos os leads.
 *
 * Resolve:
 * - Deduplicação (idempotência por phone + janela de tempo)
 * - Race conditions (lock Redis por phone)
 * - Lógica duplicada em 4 handlers
 * - Retry coordenado de CRM sync
 * - Estado consistente entre DB, RD Station e Calendar
 */

import { redisClient } from '../config/redis';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import { findLeadByPhone, createLead, updateLeadName, updateLeadIaMessage, updateLeadData, type Lead } from '../database/leads.repo';
import { query } from '../database/client';
import { logEvent, logError } from '../database/events.repo';
import { uazapi, NotOnWhatsAppError } from '../whatsapp/uazapi.client';
import { generateFirstMessage } from '../conversation/first-message';
import { syncLeadCreated, syncLeadBasic } from '../crm/sync';
import { incrementMetric } from '../monitoring/metrics';
import { syncOutgoingMessage } from '../chatwoot/sync';
import { notifyNewLead, notifyProblem } from '../monitoring/alerts';

export interface IncomingLead {
  phone: string;
  name?: string;
  email?: string;
  source: 'whatsapp' | 'pluga' | 'meta_form' | 'meta_lead';
  extraData?: Record<string, string>;
}

export interface PipelineResult {
  success: boolean;
  isNew: boolean;
  isDuplicate: boolean;
  phone: string;
  error?: string;
}

/**
 * Processa chegada de lead — idempotente, com lock e retry.
 * Chamado por TODOS os handlers (WhatsApp, Pluga, Form, Meta).
 */
export async function processIncomingLead(input: IncomingLead): Promise<PipelineResult> {
  const phone = normalizePhone(input.phone);

  if (!phone) {
    logger.warn('Lead pipeline: phone inválido rejeitado', { rawPhone: input.phone, source: input.source });
    return { success: false, isNew: false, isDuplicate: false, phone: input.phone ?? '', error: 'telefone_invalido' };
  }

  // 1. Deduplicação — ignorar se já processou nos últimos 5 min
  const dedupeKey = `pipeline_dedupe:${phone}:${input.source}`;
  const isDuplicate = await redisClient.get(dedupeKey);
  if (isDuplicate) {
    logger.info('Pipeline: duplicata ignorada', { phone, source: input.source });
    return { success: true, isNew: false, isDuplicate: true, phone };
  }

  // 2. Lock — evitar race condition se 2 webhooks chegam juntos
  const lockKey = `pipeline_lock:${phone}`;
  const locked = await redisClient.set(lockKey, '1', { NX: true, EX: 30 });
  if (!locked) {
    logger.info('Pipeline: processamento já em andamento', { phone });
    return { success: true, isNew: false, isDuplicate: true, phone };
  }

  try {
    // 3. Marcar como processado (dedup)
    await redisClient.set(dedupeKey, '1', { EX: 300 });

    await logEvent('webhook_received', phone, {
      source: input.source,
      nome: input.name,
      email: input.email,
    });
    incrementMetric('webhooksReceived');

    // 4. Buscar ou criar lead
    let lead = await findLeadByPhone(phone);
    let isNew = false;

    if (!lead) {
      lead = await createLead(phone, input.name, input.source === 'whatsapp' ? 'whatsapp' : 'meta_form');
      isNew = true;
      logger.info('Pipeline: novo lead', { phone, name: input.name, source: input.source });
      await logEvent('lead_created', phone, { source: input.source });
    } else if (input.name && !lead.name) {
      await updateLeadName(phone, input.name);
    }

    // Salvar campos extras (ex: filhos) se fornecidos
    if (input.extraData?.filhos) {
      await updateLeadData(phone, { filhos: input.extraData.filhos });
    }

    // 5. Notificar Gabriel (assíncrono, não bloqueia)
    if (isNew) {
      notifyNewLead(phone, input.name || '', input.source).catch(() => {});
    }

    // 6. Enviar primeira mensagem (apenas para leads de formulário, não WhatsApp direto)
    if (input.source !== 'whatsapp') {
      try {
        const firstMessage = generateFirstMessage(input.name || 'Olá');
        await uazapi.sendText(phone, firstMessage);
        await updateLeadIaMessage(phone);
        await logEvent('first_message_sent', phone, { source: input.source });
        logger.info('Pipeline: primeira mensagem enviada', { phone, source: input.source });

        // Espelhar no Chatwoot (assíncrono)
        syncOutgoingMessage(phone, firstMessage).catch((err) =>
          logger.warn('Chatwoot sync falhou', { phone, error: err }),
        );
      } catch (sendError) {
        if (sendError instanceof NotOnWhatsAppError) {
          await query("UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1", [phone]);
          await logEvent('lead_invalid_phone', phone, { source: input.source });
          notifyProblem('Lead com número inválido no WhatsApp', {
            phone,
            nome: input.name || '',
            fonte: input.source,
          }).catch(() => {});
          logger.warn('Pipeline: número inválido', { phone });
          return { success: false, isNew, isDuplicate: false, phone, error: 'not_on_whatsapp' };
        }
        throw sendError;
      }
    }

    // 7. CRM Sync — com retry (3 tentativas, backoff)
    await syncWithRetry(phone, lead, isNew, input.source);

    return { success: true, isNew, isDuplicate: false, phone };
  } catch (error) {
    logger.error('Pipeline: erro no processamento', { phone, source: input.source, error });
    await logError(phone, { pipeline: true, source: input.source }, error);
    return { success: false, isNew: false, isDuplicate: false, phone, error: String(error) };
  } finally {
    await redisClient.del(lockKey);
  }
}

/**
 * CRM Sync com retry — 3 tentativas com backoff exponencial.
 */
async function syncWithRetry(phone: string, lead: Lead, isNew: boolean, source: string): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (isNew || !lead.rd_contact_id) {
        if (source === 'whatsapp') {
          await syncLeadBasic(phone);
        } else {
          await syncLeadCreated(lead);
        }
      }
      return; // sucesso
    } catch (error) {
      logger.warn(`CRM sync tentativa ${attempt}/${maxRetries} falhou`, { phone, error: String(error) });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 2000)); // backoff: 2s, 4s
      } else {
        logger.error('CRM sync falhou após 3 tentativas', { phone, source, error: String(error) });
        await logError(phone, { crm_sync_exhausted: true, attempts: maxRetries }, error);
        notifyProblem('CRM sync falhou após 3 tentativas', { phone, fonte: source }).catch(() => {});
      }
    }
  }
}
