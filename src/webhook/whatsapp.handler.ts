/**
 * WhatsApp Webhook Handler (UAZAPI).
 * Para mensagens de entrada: bufferiza → engine processa.
 * Para novo lead: delega ao Lead Pipeline (sync CRM).
 */

import { Request, Response } from 'express';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import { findLeadByPhone, createLead, updateLeadOnMessage, clearLeadHistory } from '../database/leads.repo';
import { query } from '../database/client';
import { logEvent, logError } from '../database/events.repo';
import { uazapi } from '../whatsapp/uazapi.client';
import { addToBuffer } from '../conversation/message-buffer';
import { incrementMetric } from '../monitoring/metrics';
import { syncIncomingMessage } from '../chatwoot/sync';
import { processIncomingLead } from './lead-pipeline';

const POSITIVE_REACTIONS = ['👍', '🥳', '❤️', '✅', '❤', '😄', '💪'];
const NEGATIVE_REACTIONS = ['👎', '❌'];

function convertReaction(emoji: string): string {
  if (NEGATIVE_REACTIONS.includes(emoji)) return 'Não';
  return 'Sim';
}

export async function whatsappHandler(req: Request, res: Response): Promise<void> {
  res.status(200).json({ received: true });

  try {
    const raw = req.body || {};
    const payload = raw.body || raw;

    if (!payload?.message && !payload?.text) {
      logger.warn('Webhook recebido com payload inválido', {
        keys: Object.keys(raw),
        sample: JSON.stringify(raw).substring(0, 500),
      });
      return;
    }

    const msg = payload.message || payload;
    const rawPhone = payload.chat?.phone || payload.phone || payload.sender || payload.chatid?.replace('@s.whatsapp.net', '') || '';

    if (!rawPhone) {
      logger.warn('Webhook sem telefone identificável', { keys: Object.keys(payload) });
      return;
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      logger.warn('Webhook WhatsApp: phone inválido ignorado', { rawPhone });
      return;
    }

    await logEvent('webhook_received', phone, {
      fromMe: msg.fromMe,
      messageType: msg.messageType,
    });
    incrementMetric('webhooksReceived');

    // Ignorar número do Rodrigo
    if (phone === '5512996217353') return;

    // Filtro fromMe — Rodrigo respondeu manualmente
    if (msg.fromMe === true || msg.fromMe === 'true') {
      const lead = await findLeadByPhone(phone);
      if (lead) {
        await query("UPDATE leads SET status = 'paused', last_manual_message = NOW(), updated_at = NOW() WHERE phone = $1", [phone]);
        if (lead.status === 'active') {
          await logEvent('lead_paused', phone, { reason: 'fromMe - atendimento manual' });
          logger.info('Lead pausado — Rodrigo assumiu', { phone });
        }
      }
      return;
    }

    // Converter reaction
    let text = msg.text || '';
    if (msg.messageType === 'reactionMessage') {
      text = convertReaction(text);
    }

    // Comando #reset
    if (text.trim().toLowerCase() === '#reset') {
      await clearLeadHistory(phone);
      await uazapi.sendText(phone, 'Memória resetada. Pode iniciar uma nova conversa.');
      await logEvent('reset', phone);
      return;
    }

    // Comando #retomar
    if (text.trim().toLowerCase() === '#retomar') {
      await query("UPDATE leads SET status = 'active', has_lead_replied = true, followup_status = 0, updated_at = NOW() WHERE phone = $1", [phone]);
      await uazapi.sendText(phone, 'Lead reativado. A Helena vai retomar o atendimento.');
      await logEvent('lead_resumed', phone, { reason: 'comando #retomar' });
      return;
    }

    // Buscar ou criar lead (via pipeline para novos)
    let lead = await findLeadByPhone(phone);
    if (!lead) {
      // Pipeline cuida de: criar lead, sync CRM, notificar Gabriel
      await processIncomingLead({ phone, source: 'whatsapp' });
      lead = await findLeadByPhone(phone);
      if (!lead) return;
    }

    // Lead pausado → ignorar
    if (lead.status === 'paused') return;

    // Lead exhausted voltou → reativar
    if (lead.status === 'exhausted') {
      await query('UPDATE leads SET status = $1, followup_status = 0, updated_at = NOW() WHERE phone = $2', ['active', phone]);
      logger.info('Lead reativado (exhausted)', { phone });
      await logEvent('lead_reactivated', phone);
    }

    // Atualizar lead
    await updateLeadOnMessage(phone);

    // Buffer de mensagens
    let msgType: 'text' | 'audio' | 'image' = 'text';
    if (msg.messageType === 'audioMessage') msgType = 'audio';
    else if (msg.messageType === 'imageMessage') msgType = 'image';

    await addToBuffer(phone, { text, type: msgType, mediaId: msg.id });

    // Chatwoot
    syncIncomingMessage(phone, lead.name || '', text).catch((err) =>
      logger.warn('Chatwoot sync falhou', { phone, error: err }),
    );
  } catch (error) {
    logger.error('Erro no whatsapp handler', { error });
    await logError(undefined, { handler: 'whatsapp' }, error);
  }
}
