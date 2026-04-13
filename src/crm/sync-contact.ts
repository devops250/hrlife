import { findContactByPhone, findDealsByContact, createDeal, moveDealToStage, updateContact } from './rdstation.service';
import { updateLeadData, type Lead } from '../database/leads.repo';
import { logEvent, logError } from '../database/events.repo';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { buildCustomFields, RD_CUSTOM_FIELDS } from './sync-fields';

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

/** Mapa reverso: field_id → nome legível para logs */
const FIELD_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(RD_CUSTOM_FIELDS).map(([name, id]) => [id, name]),
);

/**
 * Atualiza contato no RD Station — envia cada campo individualmente.
 * Se um campo falha (ex: CPF inválido já armazenado), os outros continuam.
 */
export async function safeUpdateContact(contactId: string, lead: Lead): Promise<void> {
  const fields = buildCustomFields(lead);
  if (!lead.name && fields.length === 0) return;

  let succeeded = 0;
  let failed = 0;

  // Enviar nome separado
  if (lead.name) {
    try {
      await updateContact(contactId, { name: lead.name });
      succeeded++;
    } catch (err) {
      failed++;
      logger.warn('RD update name failed', { phone: lead.phone, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Enviar cada campo customizado individualmente
  for (const field of fields) {
    const fieldName = FIELD_NAMES[field.custom_field_id] || field.custom_field_id;
    try {
      await updateContact(contactId, { contact_custom_fields: [field] });
      succeeded++;
    } catch (err) {
      failed++;
      logger.warn('RD update field failed', {
        phone: lead.phone,
        field: fieldName,
        value: typeof field.value === 'string' ? field.value.substring(0, 50) : field.value,
        error: err instanceof Error ? err.message : String(err),
      });
      await logError(lead.phone, { crm_field_failed: fieldName, field_id: field.custom_field_id }, err);
    }
  }

  await logEvent('crm_sync', lead.phone, {
    action: failed === 0 ? 'custom_fields_updated' : 'custom_fields_partial',
    fieldsTotal: fields.length + (lead.name ? 1 : 0),
    succeeded,
    failed,
  });
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
