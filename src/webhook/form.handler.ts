import { Request, Response } from 'express';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import { findLeadByPhone, createLead, updateLeadName, updateLeadIaMessage } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { uazapi } from '../whatsapp/uazapi.client';
import { generateFirstMessage } from '../conversation/first-message';
import { syncLeadCreated } from '../crm/sync';
import { syncOutgoingMessage } from '../chatwoot/sync';
import { incrementMetric } from '../monitoring/metrics';
import { notifyNewLead, notifyProblem } from '../monitoring/alerts';
import { NotOnWhatsAppError } from '../whatsapp/uazapi.client';
import { query } from '../database/client';

// Mapeamento flexível de campos — Meta Lead Ads pode usar vários formatos
const NAME_FIELDS = ['nome', 'name', 'full_name', 'nome_completo', 'first_name'];
const PHONE_FIELDS = ['telefone', 'phone', 'celular', 'whatsapp', 'mobile', 'phone_number'];
const EMAIL_FIELDS = ['email', 'e-mail', 'email_address'];

function extractField(body: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = body[field];
    if (value && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export async function formHandler(req: Request, res: Response): Promise<void> {
  res.status(200).json({ received: true });

  try {
    // Aceitar payload direto ou nested em body
    const rawBody = req.body?.body || req.body || {};

    // Log completo para debug de integração
    logger.info('Form webhook recebido', {
      payload: JSON.stringify(rawBody).substring(0, 500),
      keys: Object.keys(rawBody),
      headers: {
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent']?.substring(0, 100),
      },
    });

    const nome = extractField(rawBody, NAME_FIELDS);
    const telefone = extractField(rawBody, PHONE_FIELDS);
    const email = extractField(rawBody, EMAIL_FIELDS);

    if (!telefone) {
      logger.warn('Form webhook sem telefone', {
        keys: Object.keys(rawBody),
        sample: JSON.stringify(rawBody).substring(0, 300),
      });
      return;
    }

    const phone = normalizePhone(telefone);

    await logEvent('webhook_received', phone, { source: 'meta_form', nome, email });
    incrementMetric('webhooksReceived');

    // Buscar ou criar lead
    let lead = await findLeadByPhone(phone);
    if (!lead) {
      lead = await createLead(phone, nome, 'meta_form');
      logger.info('Lead criado via formulário', { phone, nome, email });
      await logEvent('lead_created', phone, { source: 'meta_form' });

      notifyNewLead(phone, nome, 'meta_form').catch(() => {});
    } else if (nome) {
      await updateLeadName(phone, nome);
    }

    // Enviar primeira mensagem
    try {
      const firstMessage = generateFirstMessage(nome || 'Olá');
      await uazapi.sendText(phone, firstMessage);
      await updateLeadIaMessage(phone);
      await logEvent('first_message_sent', phone, { source: 'meta_form' });
      logger.info('Primeira mensagem enviada para lead do formulário', { phone, nome });

      syncOutgoingMessage(phone, firstMessage).catch((err) => logger.warn('Chatwoot sync falhou (form)', { phone, error: err }));
    } catch (sendError) {
      if (sendError instanceof NotOnWhatsAppError) {
        await query("UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1", [phone]);
        await logEvent('lead_invalid_phone', phone, { source: 'meta_form' });
        notifyProblem('Lead com número inválido no WhatsApp', { phone, nome, fonte: 'Meta Form' }).catch(() => {});
        logger.warn('Número não está no WhatsApp (form)', { phone, nome });
      } else {
        throw sendError;
      }
    }

    // Sync com RD Station
    syncLeadCreated(lead).catch((err) => logger.error('CRM sync async falhou (form)', { phone, error: err }));
  } catch (error) {
    logger.error('Erro no form handler', { error });
    await logEvent('error', undefined, { handler: 'form', error: String(error) });
  }
}
