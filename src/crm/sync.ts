import { env } from '../config/env';
import {
  findContactByPhone,
  createDeal,
  updateContact,
  findDealsByContact,
  moveDealToStage,
} from './rdstation.service';
import { updateLeadData, findLeadByPhone, type Lead } from '../database/leads.repo';
import { logEvent } from '../database/events.repo';
import { logger } from '../utils/logger';

/**
 * Busca o contact_id após criar um deal (o deal cria o contato junto).
 * Espera 1s para o RD Station processar e depois busca.
 */
async function resolveContactId(phone: string): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const contact = await findContactByPhone(phone);
    return contact?._id || null;
  } catch {
    return null;
  }
}

/**
 * Chamado quando cadastra_lead com agendado=false ou via POST /form
 */
export async function syncLeadCreated(lead: Lead): Promise<void> {
  try {
    // Recarregar lead para pegar nome atualizado (pode ter sido salvo pelo cadastra_lead)
    const freshLead = await findLeadByPhone(lead.phone) || lead;
    const leadName = freshLead.name || lead.name || 'Lead';

    const contact = await findContactByPhone(lead.phone);

    if (!contact) {
      const deal = await createDeal(
        leadName,
        lead.phone,
        env.RD_STAGE_CONTATO_FEITO,
      );

      // Buscar contact_id criado junto com o deal
      const contactId = await resolveContactId(lead.phone);

      await updateLeadData(lead.phone, {
        rd_deal_id: deal._id,
        rd_contact_id: contactId || undefined,
      });
      await logEvent('crm_sync', lead.phone, {
        action: 'deal_created',
        dealId: deal._id,
        contactId,
        stage: 'contato_feito',
      });
      logger.info('CRM sync: deal + contato criados', { phone: lead.phone, dealId: deal._id, contactId });

      // Atualizar contato com dados de cotação (best-effort)
      if (contactId) {
        await safeUpdateContact(contactId, freshLead);
      }
      return;
    }

    // Contato existe — buscar deals
    const deals = await findDealsByContact(contact._id);
    const existingDeal = deals.find((d) =>
      d.deal_stage?._id !== env.RD_STAGE_SEM_RETORNO,
    );

    if (!existingDeal) {
      const deal = await createDeal(
        leadName || contact.name || 'Lead',
        lead.phone,
        env.RD_STAGE_CONTATO_FEITO,
      );
      await updateLeadData(lead.phone, {
        rd_contact_id: contact._id,
        rd_deal_id: deal._id,
      });
      await logEvent('crm_sync', lead.phone, {
        action: 'deal_created_existing_contact',
        contactId: contact._id,
        dealId: deal._id,
      });
    } else {
      await updateLeadData(lead.phone, {
        rd_contact_id: contact._id,
        rd_deal_id: existingDeal._id,
      });
      await logEvent('crm_sync', lead.phone, {
        action: 'existing_deal_found',
        contactId: contact._id,
        dealId: existingDeal._id,
        stage: existingDeal.deal_stage?.name,
      });
    }

    // Atualizar contato com dados de cotação (best-effort)
    await safeUpdateContact(contact._id, freshLead);

    logger.info('CRM sync: lead cadastrado sincronizado', { phone: lead.phone });
  } catch (error) {
    logger.error('CRM sync falhou (lead criado)', { phone: lead.phone, error });
    await logEvent('error', lead.phone, { crm_sync: 'lead_created', error: String(error) });
  }
}

/**
 * Chamado quando cadastra_lead com agendado=true ou registra_agendamento
 */
export async function syncLeadScheduled(lead: Lead): Promise<void> {
  try {
    // Recarregar lead e buscar contato
    const freshLead = await findLeadByPhone(lead.phone) || lead;
    const leadName = freshLead.name || lead.name || 'Lead';
    const contact = await findContactByPhone(lead.phone);

    if (!contact) {
      const deal = await createDeal(
        leadName,
        lead.phone,
        env.RD_STAGE_AGENDADO,
      );
      const contactId = await resolveContactId(lead.phone);
      await updateLeadData(lead.phone, {
        rd_deal_id: deal._id,
        rd_contact_id: contactId || undefined,
      });
      await logEvent('crm_sync', lead.phone, {
        action: 'deal_created_agendado',
        dealId: deal._id,
      });
      logger.info('CRM sync: deal criado no estágio Agendado', { phone: lead.phone });
      return;
    }

    // Atualizar contato (best-effort)
    await safeUpdateContact(contact._id, freshLead);
    await updateLeadData(lead.phone, { rd_contact_id: contact._id });

    // Buscar deals e mover TODOS os ativos para Agendado
    const deals = await findDealsByContact(contact._id);
    const activeDeals = deals.filter((d) =>
      d.deal_stage?._id !== env.RD_STAGE_SEM_RETORNO && d.deal_stage?._id !== env.RD_STAGE_AGENDADO,
    );

    if (activeDeals.length > 0) {
      for (const deal of activeDeals) {
        await moveDealToStage(deal._id, env.RD_STAGE_AGENDADO);
        logger.info('CRM sync: deal movido para Agendado', { dealId: deal._id, name: deal.name });
      }
      await updateLeadData(lead.phone, { rd_deal_id: activeDeals[0]._id });
      await logEvent('crm_sync', lead.phone, {
        action: 'deal_moved_agendado',
        dealsMoved: activeDeals.map((d) => d._id),
      });
    } else {
      const newDeal = await createDeal(
        leadName || contact.name || 'Lead',
        lead.phone,
        env.RD_STAGE_AGENDADO,
      );
      await updateLeadData(lead.phone, { rd_deal_id: newDeal._id });
      await logEvent('crm_sync', lead.phone, {
        action: 'deal_created_for_scheduled',
        dealId: newDeal._id,
      });
    }

    logger.info('CRM sync: lead agendado sincronizado', { phone: lead.phone });
  } catch (error) {
    logger.error('CRM sync falhou (lead agendado)', { phone: lead.phone, error });
    await logEvent('error', lead.phone, { crm_sync: 'lead_scheduled', error: String(error) });
  }
}

/**
 * Converte "DD/MM/AAAA" para "AAAA-MM-DD" (ISO 8601, formato do RD Station)
 */
import { convertBirthdayToISO } from '../utils/date';

/**
 * Atualizar contato no RD Station — best-effort, não bloqueia o fluxo
 */
function buildLeadNotes(lead: Lead): string {
  const lines: string[] = ['📋 Dados de Cotação (coletados pela Helena)', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];
  if (lead.birth_date) lines.push(`Nascimento: ${lead.birth_date}`);
  if (lead.height) lines.push(`Altura: ${lead.height}`);
  if (lead.weight) lines.push(`Peso: ${lead.weight}`);
  if (lead.profession) lines.push(`Profissão: ${lead.profession}`);
  if (lead.smoker) lines.push(`Fumante: ${lead.smoker}`);
  if (lead.income) lines.push(`Renda: ${lead.income}`);
  if (lead.cpf) lines.push(`CPF: ${lead.cpf}`);
  if (lead.scheduled && lead.scheduled_at) {
    const dt = new Date(lead.scheduled_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    lines.push(`Agendado: ${dt}`);
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Atualizado em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  return lines.join('\n');
}

async function safeUpdateContact(contactId: string, lead: Lead): Promise<void> {
  try {
    const data: Record<string, unknown> = {};
    if (lead.name) data.name = lead.name;

    // Enviar todos os dados de cotação no campo notes
    const hasData = lead.birth_date || lead.height || lead.weight || lead.profession || lead.smoker || lead.income || lead.cpf;
    if (hasData) {
      data.notes = buildLeadNotes(lead);
    }

    if (Object.keys(data).length === 0) return;

    await updateContact(contactId, data);
  } catch (error) {
    logger.warn('updateContact falhou (best-effort, continuando)', { contactId, error });
    await logEvent('crm_sync', lead.phone, {
      action: 'update_contact_failed_best_effort',
      contactId,
      error: String(error),
    });
  }
}
