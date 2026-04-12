import { Request, Response } from 'express';
import { normalizePhone } from '../utils/phone';
import { logger } from '../utils/logger';
import { findLeadByPhone, createLead, updateLeadOnMessage, clearLeadHistory } from '../database/leads.repo';
import { query } from '../database/client';
import { logEvent } from '../database/events.repo';
import { uazapi } from '../whatsapp/uazapi.client';
import { addToBuffer } from '../conversation/message-buffer';
import { incrementMetric } from '../monitoring/metrics';
import { syncIncomingMessage } from '../chatwoot/sync';
import { syncLeadBasic } from '../crm/sync';
import { notifyNewLead } from '../monitoring/alerts';

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

    // UAZAPI pode enviar como { body: { message, chat } } ou direto { message, chat }
    const payload = raw.body || raw;

    if (!payload?.message && !payload?.text) {
      logger.warn('Webhook recebido com payload inválido', {
        keys: Object.keys(raw),
        sample: JSON.stringify(raw).substring(0, 500),
      });
      return;
    }

    // Adaptar: UAZAPI pode enviar flat (campos no root) ou nested (message/chat)
    const msg = payload.message || payload;
    const rawPhone = payload.chat?.phone || payload.phone || payload.sender || payload.chatid?.replace('@s.whatsapp.net', '') || '';

    if (!rawPhone) {
      logger.warn('Webhook sem telefone identificável', {
        keys: Object.keys(payload),
        sample: JSON.stringify(raw).substring(0, 500),
      });
      return;
    }

    const phone = normalizePhone(rawPhone);

    await logEvent('webhook_received', phone, {
      fromMe: msg.fromMe,
      messageType: msg.messageType,
    });
    incrementMetric('webhooksReceived');

    // Ignorar número do Rodrigo (dono) — nunca responder
    if (phone === '5512996217353') {
      return;
    }

    // Filtro fromMe — Rodrigo respondeu manualmente → pausar lead
    if (msg.fromMe === true || msg.fromMe === 'true') {
      const lead = await findLeadByPhone(phone);
      if (lead) {
        await query("UPDATE leads SET status = 'paused', last_manual_message = NOW(), updated_at = NOW() WHERE phone = $1", [phone]);
        if (lead.status === 'active') {
          await logEvent('lead_paused', phone, { reason: 'fromMe - atendimento manual' });
          logger.info('Lead pausado — Rodrigo assumiu atendimento', { phone });
        }
      }
      return;
    }

    // Converter reaction em texto
    let text = msg.text || '';
    if (msg.messageType === 'reactionMessage') {
      text = convertReaction(text);
    }

    // Comando #reset
    if (text.trim().toLowerCase() === '#reset') {
      await clearLeadHistory(phone);
      await uazapi.sendText(phone, 'Memória resetada. Pode iniciar uma nova conversa.');
      await logEvent('reset', phone);
      logger.info('Histórico resetado', { phone });
      return;
    }

    // Comando #retomar — devolver lead para a Helena
    if (text.trim().toLowerCase() === '#retomar') {
      await query("UPDATE leads SET status = 'active', has_lead_replied = true, followup_status = 0, updated_at = NOW() WHERE phone = $1", [phone]);
      await uazapi.sendText(phone, 'Lead reativado. A Helena vai retomar o atendimento.');
      await logEvent('lead_resumed', phone, { reason: 'comando #retomar' });
      logger.info('Lead reativado via #retomar', { phone });
      return;
    }

    // Buscar ou criar lead
    let lead = await findLeadByPhone(phone);
    let isNewLead = false;
    if (!lead) {
      lead = await createLead(phone);
      isNewLead = true;
      logger.info('Novo lead criado', { phone });
      await logEvent('lead_created', phone, { source: 'whatsapp' });

      // Notificar Gabriel via WhatsApp
      notifyNewLead(phone, '', 'whatsapp').catch(() => {});

    }

    // Sync básico com RD Station (assíncrono, não bloqueia)
    if (isNewLead || !lead.rd_contact_id) {
      syncLeadBasic(phone).catch((err) =>
        logger.warn('Sync básico RD falhou (não bloqueia)', { phone, error: err }),
      );
    }

    // Lead pausado — ignorar
    if (lead.status === 'paused') {
      logger.info('Lead pausado, ignorando', { phone });
      return;
    }

    // Lead esgotou follow-ups mas voltou a responder — reativar
    if (lead.status === 'exhausted') {
      await query('UPDATE leads SET status = $1, followup_status = 0, updated_at = NOW() WHERE phone = $2', ['active', phone]);
      logger.info('Lead reativado (estava exhausted)', { phone });
      await logEvent('lead_reactivated', phone);
    }

    // Atualizar lead (reset follow-up, marcar resposta)
    await updateLeadOnMessage(phone);

    // Determinar tipo de mensagem e adicionar ao buffer
    let msgType: 'text' | 'audio' | 'image' = 'text';
    if (msg.messageType === 'audioMessage') msgType = 'audio';
    else if (msg.messageType === 'imageMessage') msgType = 'image';

    await addToBuffer(phone, {
      text,
      type: msgType,
      mediaId: msg.id,
    });

    logger.info('Mensagem adicionada ao buffer', { phone, type: msgType });

    // Espelhar no Chatwoot
    syncIncomingMessage(phone, lead.name || '', text).catch((err) =>
      logger.warn('Chatwoot sync falhou', { phone, error: err }),
    );
  } catch (error) {
    logger.error('Erro no whatsapp handler', { error });
    await logEvent('error', undefined, { handler: 'whatsapp', error: String(error) });
  }
}
