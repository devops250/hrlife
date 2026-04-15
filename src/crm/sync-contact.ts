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
 * Atualiza contato no RD Station.
 * Envia TODOS os campos customizados em uma única chamada (RD substitui o array inteiro no PUT).
 * Campos nativos (nome, email) são enviados junto no mesmo batch.
 * Se o batch falhar, retenta sem o CPF (campo mais comum de dar 422).
 */
export async function safeUpdateContact(contactId: string, lead: Lead): Promise<void> {
  const fields = buildCustomFields(lead);
  if (!lead.name && !lead.email && fields.length === 0) return;

  // Montar payload único com todos os dados
  const payload: Record<string, unknown> = {};
  if (lead.name) payload.name = lead.name;
  if (lead.email) payload.emails = [{ email: lead.email }];
  if (fields.length > 0) payload.contact_custom_fields = fields;

  try {
    await updateContact(contactId, payload);
    await logEvent('crm_sync', lead.phone, {
      action: 'custom_fields_updated',
      fieldsTotal: fields.length + (lead.name ? 1 : 0) + (lead.email ? 1 : 0),
      succeeded: fields.length + (lead.name ? 1 : 0) + (lead.email ? 1 : 0),
      failed: 0,
    });
    return;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Se falhou com 422, tentar sem CPF (campo que mais causa erro de validação)
    if (errMsg.includes('422') && fields.some((f) => f.custom_field_id === RD_CUSTOM_FIELDS.cpf)) {
      logger.warn('RD batch update falhou (422), retentando sem CPF', { phone: lead.phone });
      const fieldsNoCpf = fields.filter((f) => f.custom_field_id !== RD_CUSTOM_FIELDS.cpf);
      const retryPayload: Record<string, unknown> = {};
      if (lead.name) retryPayload.name = lead.name;
      if (lead.email) retryPayload.emails = [{ email: lead.email }];
      if (fieldsNoCpf.length > 0) retryPayload.contact_custom_fields = fieldsNoCpf;

      try {
        await updateContact(contactId, retryPayload);
        await logEvent('crm_sync', lead.phone, {
          action: 'custom_fields_partial',
          fieldsTotal: fields.length,
          succeeded: fieldsNoCpf.length + (lead.name ? 1 : 0),
          failed: 1,
          skipped_field: 'cpf',
        });
        return;
      } catch (retryErr) {
        logger.error('RD batch update sem CPF também falhou', { phone: lead.phone, error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
      }
    }

    logger.error('RD safeUpdateContact falhou', { phone: lead.phone, error: errMsg });
    await logError(lead.phone, { crm_update_failed: true }, err);
    await logEvent('crm_sync', lead.phone, {
      action: 'custom_fields_failed',
      fieldsTotal: fields.length,
      succeeded: 0,
      failed: fields.length,
    });
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
