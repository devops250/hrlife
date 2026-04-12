import { Request, Response } from 'express';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import { findLeadByPhone, createLead, updateLeadName, updateLeadIaMessage } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { uazapi } from '../whatsapp/uazapi.client';
import { generateFirstMessage } from '../conversation/first-message';
import { syncLeadCreated } from '../crm/sync';
import { incrementMetric } from '../monitoring/metrics';
import { syncOutgoingMessage } from '../chatwoot/sync';
import { notifyNewLead } from '../monitoring/alerts';

// Mapeamento flexível de campos que a Pluga pode enviar
const NAME_FIELDS = ['nome', 'name', 'full_name', 'nome_completo'];
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

export async function plugaHandler(req: Request, res: Response): Promise<void> {
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};

    // Log completo do payload para debug
    logger.info('Pluga webhook recebido', {
      payload: JSON.stringify(body).substring(0, 500),
      keys: Object.keys(body),
    });

    const nome = extractField(body, NAME_FIELDS);
    const telefone = extractField(body, PHONE_FIELDS);
    const email = extractField(body, EMAIL_FIELDS);

    if (!telefone) {
      logger.warn('Pluga webhook sem telefone', {
        keys: Object.keys(body),
        sample: JSON.stringify(body).substring(0, 300),
      });
      return;
    }

    const phone = normalizePhone(telefone);

    await logEvent('webhook_received', phone, { source: 'pluga', nome, email });
    incrementMetric('webhooksReceived');

    // Buscar ou criar lead
    let lead = await findLeadByPhone(phone);
    if (!lead) {
      lead = await createLead(phone, nome, 'meta_form');
      logger.info('Lead criado via Pluga', { phone, nome, email });
      notifyNewLead(phone, nome, 'pluga').catch(() => {});
      await logEvent('lead_created', phone, { source: 'pluga' });
    } else if (nome) {
      await updateLeadName(phone, nome);
    }

    // Enviar primeira mensagem
    const firstMessage = generateFirstMessage(nome || 'Olá');
    await uazapi.sendText(phone, firstMessage);
    await updateLeadIaMessage(phone);
    await logEvent('first_message_sent', phone, { source: 'pluga' });

    logger.info('Primeira mensagem enviada via Pluga', { phone });

    // Sync com RD Station
    syncLeadCreated(lead).catch((err) => logger.error('CRM sync async falhou (pluga)', { phone, error: err }));

    // Espelhar no Chatwoot
    syncOutgoingMessage(phone, firstMessage).catch((err) => logger.warn('Chatwoot sync falhou (pluga)', { phone, error: err }));
  } catch (error) {
    logger.error('Erro no pluga handler', { error });
    await logEvent('error', undefined, { handler: 'pluga', error: String(error) });
  }
}
