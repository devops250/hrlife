import cron from 'node-cron';
import { query } from '../database/client';
import { logger } from '../utils/logger';
import { isBusinessHours } from '../config/schedule';
import { getNextStage } from './stages';
import { enqueueForFollowup, getQueuedFollowups } from './queue';
import { generateFirstMessages, generateFirstMessage } from '../conversation/first-message';
import { uazapi } from '../whatsapp/uazapi.client';
import { logEvent, logError } from '../database/events.repo';
import { incrementMetric } from '../monitoring/metrics';
import { moveDealToStage } from '../crm/rdstation.service';
import { env } from '../config/env';
import { UazapiClient, NotOnWhatsAppError, WhatsAppDisconnectedError } from '../whatsapp/uazapi.client';
import { findLeadByPhone, type Lead } from '../database/leads.repo';

const BATCH_SIZE = 10;
const DELAY_BETWEEN_SENDS_MS = 2000;
const MAX_QUEUE_PER_CYCLE = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let isRunning = false;

async function acquireLock(): Promise<boolean> {
  try {
    const { redisClient } = await import('../config/redis');
    const result = await redisClient.set('followup:lock', '1', { NX: true, EX: 290 });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    const { redisClient } = await import('../config/redis');
    await redisClient.del('followup:lock');
  } catch { /* best effort */ }
}

export async function reactivatePausedLeads(): Promise<number> {
  let count = 0;
  const pausedResult = await query(
    `SELECT * FROM leads
     WHERE status = 'paused'
       AND last_manual_message IS NOT NULL
       AND last_manual_message < NOW() - INTERVAL '30 minutes'`,
  );

  for (const lead of pausedResult.rows as Lead[]) {
    await query(
      "UPDATE leads SET status = 'active', has_lead_replied = true, followup_status = 0, last_manual_message = NULL, updated_at = NOW() WHERE phone = $1",
      [lead.phone],
    );
    await logEvent('lead_auto_resumed', lead.phone, { reason: '30min sem resposta manual' });
    logger.info('Lead reativado automaticamente (30min sem resposta manual)', { phone: lead.phone });
    count++;
  }

  return count;
}

/**
 * Retry de primeira mensagem para leads criados durante downtime do WhatsApp.
 * Busca leads das últimas 12h que nunca receberam mensagem (last_ia_message IS NULL).
 */
async function retryPendingFirstMessages(): Promise<number> {
  const result = await query(
    `SELECT phone, name, source FROM leads
     WHERE created_at > NOW() - INTERVAL '12 hours'
       AND last_ia_message IS NULL
       AND status = 'active'
       AND source != 'whatsapp'
     LIMIT 5`,
  );

  let retried = 0;
  for (const lead of result.rows as Array<{ phone: string; name: string | null; source: string }>) {
    try {
      const [greeting, details] = generateFirstMessages(lead.name || 'Olá');
      await uazapi.sendText(lead.phone, greeting);
      await sleep(DELAY_BETWEEN_SENDS_MS);
      await uazapi.sendText(lead.phone, details);
      await query('UPDATE leads SET last_ia_message = NOW(), updated_at = NOW() WHERE phone = $1', [lead.phone]);
      await query('INSERT INTO followup_log (phone, stage, message) VALUES ($1, 0, $2)', [lead.phone, `${greeting}\n\n${details}`]);
      await logEvent('first_message_sent', lead.phone, { source: lead.source, retry: true });
      logger.info('Primeira mensagem reenviada (retry)', { phone: lead.phone });
      retried++;
      await sleep(DELAY_BETWEEN_SENDS_MS);
    } catch (error) {
      if (error instanceof NotOnWhatsAppError) {
        await query("UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1", [lead.phone]);
        await logEvent('lead_invalid_phone', lead.phone, { source: lead.source, retry: true });
      } else if (error instanceof WhatsAppDisconnectedError) {
        logger.warn('WhatsApp ainda desconectado durante retry — parando', { phone: lead.phone });
        break;
      } else {
        logger.error('Retry primeira mensagem falhou', { phone: lead.phone, error });
      }
    }
  }
  return retried;
}

export async function processFollowups(): Promise<void> {
  if (isRunning) {
    logger.warn('Follow-up scheduler já está rodando (memory lock), pulando');
    return;
  }

  const hasLock = await acquireLock();
  if (!hasLock) {
    logger.warn('Follow-up scheduler já está rodando (redis lock), pulando');
    return;
  }

  isRunning = true;

  const startTime = Date.now();
  let sent = 0;
  let queued = 0;
  let skipped = 0;

  try {
    logger.info('Follow-up scheduler iniciado');

    // Circuit breaker: verificar se WhatsApp está desconectado
    const { redisClient: cbClient } = await import('../config/redis');
    const waDisconnected = await cbClient.get('whatsapp_disconnected');
    if (waDisconnected) {
      logger.warn('WhatsApp desconectado (circuit breaker ativo) — scheduler pausado até reconexão');
      return;
    }

    // 0. Reativar leads pausados há 30+ min (Rodrigo não respondeu mais)
    const reactivated = await reactivatePausedLeads();

    // 0.5 Retry de primeira mensagem para leads criados durante downtime
    const retried = await retryPendingFirstMessages();

    // 1. Processar fila noturna primeiro (se estiver em horário comercial)
    if (isBusinessHours()) {
      const queuedItems = await getQueuedFollowups(MAX_QUEUE_PER_CYCLE);
      for (const item of queuedItems) {
        try {
          // Re-check: lead pode ter sido agendado/respondido enquanto estava na fila
          const freshLead = await findLeadByPhone(item.phone);
          if (!freshLead || freshLead.scheduled || freshLead.has_lead_replied || freshLead.status !== 'active') {
            logger.info('Follow-up da fila pulado (lead mudou de status)', { phone: item.phone, status: freshLead?.status });
            skipped++;
            continue;
          }

          await uazapi.sendText(item.phone, item.message);
          await query(
            'UPDATE leads SET followup_status = $1, last_ia_message = NOW(), updated_at = NOW() WHERE phone = $2',
            [item.stage, item.phone],
          );
          await query(
            'INSERT INTO followup_log (phone, stage, message) VALUES ($1, $2, $3)',
            [item.phone, item.stage, item.message],
          );
          await logEvent('followup_sent', item.phone, { stage: item.stage, source: 'queue' });
          incrementMetric('followupsSent');
          sent++;
          await sleep(DELAY_BETWEEN_SENDS_MS);
        } catch (error) {
          logger.error('Erro ao enviar follow-up da fila', { phone: item.phone, error });
          await query(
            'INSERT INTO followup_log (phone, stage, message, success) VALUES ($1, $2, $3, false)',
            [item.phone, item.stage, item.message],
          );
        }
      }
      if (queuedItems.length > 0) {
        logger.info(`Fila noturna processada: ${sent} enviados de ${queuedItems.length}`);
      }
    }

    // 2. Buscar leads elegíveis para follow-up (excluir agendados)
    const result = await query(
      `SELECT * FROM leads
       WHERE status = 'active'
         AND has_lead_replied = false
         AND scheduled = false
         AND followup_status < 4
         AND last_ia_message IS NOT NULL
       ORDER BY last_ia_message ASC
       LIMIT $1`,
      [BATCH_SIZE],
    );

    const leads: Lead[] = result.rows;

    for (const lead of leads) {
      // Re-buscar lead do banco para garantir dados atualizados
      const freshLead = await findLeadByPhone(lead.phone);
      if (!freshLead || freshLead.status !== 'active' || freshLead.has_lead_replied || freshLead.scheduled) {
        skipped++;
        continue;
      }

      const next = await getNextStage(freshLead);
      if (!next) {
        skipped++;
        continue;
      }

      // Fora do horário comercial → enfileirar + atualizar status (evita re-enqueue)
      if (!isBusinessHours()) {
        await enqueueForFollowup(lead.phone, next.stage, next.message);
        await query(
          'UPDATE leads SET followup_status = $1, last_ia_message = NOW(), updated_at = NOW() WHERE phone = $2',
          [next.stage, lead.phone],
        );
        queued++;
        continue;
      }

      try {
        await uazapi.sendText(lead.phone, next.message);
        await query(
          'UPDATE leads SET followup_status = $1, last_ia_message = NOW(), updated_at = NOW() WHERE phone = $2',
          [next.stage, lead.phone],
        );
        await query(
          'INSERT INTO followup_log (phone, stage, message) VALUES ($1, $2, $3)',
          [lead.phone, next.stage, next.message],
        );
        await logEvent('followup_sent', lead.phone, { stage: next.stage });
        incrementMetric('followupsSent');
        sent++;
        await sleep(DELAY_BETWEEN_SENDS_MS);
      } catch (error) {
        if (error instanceof WhatsAppDisconnectedError) {
          // Instância desconectada — ativar circuit breaker e parar o ciclo
          const { redisClient: rc } = await import('../config/redis');
          await rc.set('whatsapp_disconnected', '1', { EX: 600 }); // 10min TTL
          logger.warn('WhatsApp desconectado — circuit breaker ativado por 10min', { phone: lead.phone });
          break;
        } else if (error instanceof NotOnWhatsAppError) {
          // Número inválido — pausar lead para não ficar tentando
          await query(
            "UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1",
            [lead.phone],
          );
          await logEvent('lead_invalid_phone', lead.phone, { stage: next.stage });
          logger.warn('Lead com número inválido no WhatsApp, marcado como invalid_phone', { phone: lead.phone });
        } else {
          logger.error('Erro ao enviar follow-up', { phone: lead.phone, error });
          await query(
            'INSERT INTO followup_log (phone, stage, message, success) VALUES ($1, $2, $3, false)',
            [lead.phone, next.stage, next.message],
          );
          await logError(lead.phone, { followup: true, stage: next.stage }, error);
        }
      }
    }

    // 3. Mover leads esgotados (status=4, sem resposta, não agendados) para "Sem Retorno"
    let closed = 0;
    const exhaustedResult = await query(
      `SELECT * FROM leads
       WHERE status = 'active'
         AND has_lead_replied = false
         AND scheduled = false
         AND followup_status >= 4
         AND last_ia_message IS NOT NULL
         AND last_ia_message < NOW() - INTERVAL '24 hours'
       LIMIT $1`,
      [BATCH_SIZE],
    );

    for (const lead of exhaustedResult.rows as Lead[]) {
      try {
        await query(
          "UPDATE leads SET status = 'exhausted', updated_at = NOW() WHERE phone = $1",
          [lead.phone],
        );

        if (lead.rd_deal_id) {
          await moveDealToStage(lead.rd_deal_id, env.RD_STAGE_SEM_RETORNO);
        }

        await logEvent('followup_exhausted', lead.phone, {
          rd_deal_id: lead.rd_deal_id,
          stage: 'sem_retorno',
        });
        closed++;
        logger.info('Lead esgotou follow-ups, movido para Sem Retorno', { phone: lead.phone });
      } catch (error) {
        logger.error('Erro ao encerrar lead esgotado', { phone: lead.phone, error });
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info('Follow-up scheduler finalizado', {
      elapsed_ms: elapsed,
      leads_checked: leads.length,
      sent,
      queued,
      skipped,
      closed,
      reactivated,
      retried,
    });
  } catch (error) {
    logger.error('Erro no follow-up scheduler', { error });
    await logError(undefined, { scheduler: 'followup' }, error);
  } finally {
    isRunning = false;
    await releaseLock();
  }
}

export function startFollowupScheduler(): void {
  cron.schedule('*/5 * * * *', () => {
    processFollowups().catch((err) => {
      logger.error('Erro fatal no follow-up scheduler', { error: err });
    });
  });
  logger.info('Follow-up scheduler registrado (a cada 5 minutos)');
}
