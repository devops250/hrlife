import { Request, Response } from 'express';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import { findLeadByPhone, createLead, updateLeadName, updateLeadIaMessage } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { uazapi } from '../whatsapp/uazapi.client';
import { generateFirstMessage } from '../conversation/first-message';
import { syncLeadCreated } from '../crm/sync';
import { syncOutgoingMessage } from '../chatwoot/sync';

export async function formHandler(req: Request, res: Response): Promise<void> {
  res.status(200).json({ received: true });

  try {
    const { nome, telefone } = req.body?.body || req.body || {};

    if (!telefone) {
      logger.warn('Form webhook sem telefone');
      return;
    }

    const phone = normalizePhone(telefone);
    const name = nome || '';

    await logEvent('webhook_received', phone, { source: 'meta_form', name });

    // Buscar ou criar lead
    let lead = await findLeadByPhone(phone);
    if (!lead) {
      lead = await createLead(phone, name, 'meta_form');
      logger.info('Lead criado via formulário', { phone, name });
      await logEvent('lead_created', phone, { source: 'meta_form' });
    } else if (name) {
      await updateLeadName(phone, name);
    }

    // Enviar primeira mensagem
    const firstMessage = generateFirstMessage(name || 'Olá');
    await uazapi.sendText(phone, firstMessage);
    await updateLeadIaMessage(phone);
    await logEvent('first_message_sent', phone);

    logger.info('Primeira mensagem enviada para lead do formulário', { phone });

    // Sync com RD Station (criar contato + deal)
    syncLeadCreated(lead).catch((err) => logger.error('CRM sync async falhou (form)', { phone, error: err }));

    // Espelhar no Chatwoot
    syncOutgoingMessage(phone, firstMessage).catch((err) => logger.warn('Chatwoot sync falhou (form)', { phone, error: err }));
  } catch (error) {
    logger.error('Erro no form handler', { error });
    await logEvent('error', undefined, { handler: 'form', error: String(error) });
  }
}
