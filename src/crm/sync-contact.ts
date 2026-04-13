import { findContactByPhone, findDealsByContact, createDeal, moveDealToStage, updateContact } from './rdstation.service';
import { updateLeadData, type Lead } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { buildCustomFields } from './sync-fields';

/**
 * Busca o contact_id após criar um deal (aguarda 1s para o RD Station processar).
 */
export async function resolveContactId(phone: string): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const contact = await findContactByPhone(phone);
    return contact?._id || null;
  } catch {
    return null;
  }
}

/**
 * Atualiza contato no RD Station com dados de cotação — best-effort.
 */
export async function safeUpdateContact(contactId: string, lead: Lead): Promise<void> {
  try {
    const data: Record<string, unknown> = {};
    if (lead.name) data.name = lead.name;
    const customFields = buildCustomFields(lead);
    if (customFields.length > 0) data.contact_custom_fields = customFields;
    if (Object.keys(data).length === 0) return;
    await updateContact(contactId, data);
    await logEvent('crm_sync', lead.phone, { action: 'custom_fields_updated', fieldsCount: customFields.length });
  } catch (error) {
    logger.warn('updateContact falhou (best-effort, continuando)', { contactId, error });
    await logEvent('crm_sync', lead.phone, { action: 'update_contact_failed_best_effort', contactId, error: String(error) });
  }
}

/**
 * Garante que o deal do contato esteja no estágio Agendado.
 * Move deal ativo, usa existente em Agendado, ou cria novo — nessa ordem.
 */
export async function ensureDealScheduled(
  contact: { _id: string; name?: string },
  leadName: string,
  phone: string,
): Promise<string> {
  const deals = await findDealsByContact(contact._id);
  const active = deals.find(
    (d) => d.deal_stage?._id !== env.RD_STAGE_SEM_RETORNO && d.deal_stage?._id !== env.RD_STAGE_AGENDADO,
  );
  if (active) {
    await moveDealToStage(active._id, env.RD_STAGE_AGENDADO);
    await updateLeadData(phone, { rd_deal_id: active._id });
    await logEvent('crm_sync', phone, { action: 'deal_moved_agendado', dealId: active._id });
    return active._id;
  }
  const already = deals.find((d) => d.deal_stage?._id === env.RD_STAGE_AGENDADO);
  if (already) {
    await updateLeadData(phone, { rd_deal_id: already._id });
    await logEvent('crm_sync', phone, { action: 'deal_already_agendado', dealId: already._id });
    return already._id;
  }
  const deal = await createDeal(leadName || contact.name || 'Lead', phone, env.RD_STAGE_AGENDADO);
  await updateLeadData(phone, { rd_deal_id: deal._id });
  await logEvent('crm_sync', phone, { action: 'deal_created_for_scheduled', dealId: deal._id });
  return deal._id;
}
