import { findLeadByPhone, updateLeadData } from '../database/leads.repo';
import { findContactByPhone, createContact, createConversation, sendMessage } from './chatwoot.service';
import { logger } from '../utils/logger';

async function ensureChatwootIds(phone: string, name: string): Promise<{ contactId: number; conversationId: number } | null> {
  const lead = await findLeadByPhone(phone);
  if (!lead) return null;

  let contactId = lead.chatwoot_contact_id;
  let conversationId = lead.chatwoot_conversation_id;

  if (!contactId) {
    const existing = await findContactByPhone(phone);
    if (existing) {
      contactId = existing.id;
    } else {
      const created = await createContact(phone, name || lead.name || 'Lead');
      contactId = created.id;
    }
    await updateLeadData(phone, { chatwoot_contact_id: contactId });
  }

  if (!conversationId) {
    const conv = await createConversation(contactId);
    conversationId = conv.id;
    await updateLeadData(phone, { chatwoot_conversation_id: conversationId });
  }

  return { contactId, conversationId };
}

export async function syncIncomingMessage(phone: string, name: string, text: string): Promise<void> {
  try {
    const ids = await ensureChatwootIds(phone, name);
    if (!ids) return;
    await sendMessage(ids.conversationId, text, 'incoming');
  } catch (error) {
    logger.warn('Chatwoot sync incoming falhou (best-effort)', { phone, error });
  }
}

export async function syncOutgoingMessage(phone: string, text: string): Promise<void> {
  try {
    const ids = await ensureChatwootIds(phone, '');
    if (!ids) return;
    await sendMessage(ids.conversationId, `[Helena IA] ${text}`, 'outgoing');
  } catch (error) {
    logger.warn('Chatwoot sync outgoing falhou (best-effort)', { phone, error });
  }
}
