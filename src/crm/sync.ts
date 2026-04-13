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
import { trackRdSync } from '../monitoring/metrics';
import { redisClient } from '../index';
// Note: redisClient import needed for mutex lock

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
 * Sync básico: cria contato/deal no RD quando o lead chega (antes da coleta completa).
 * Chamado pelo webhook handler ao receber primeira mensagem.
 */
export async function syncLeadBasic(phone: string, name?: string): Promise<void> {
  try {
    const lead = await findLeadByPhone(phone);
    if (!lead) return;

    // Se já tem rd_contact_id, não precisa sync básico
    if (lead.rd_contact_id) return;

    const contact = await findContactByPhone(phone);

    if (contact) {
      // Contato já existe no RD — só salvar o ID localmente
      await updateLeadData(phone, { rd_contact_id: contact._id });

      const deals = await findDealsByContact(contact._id);
      const activeDeal = deals.find((d) =>
        d.deal_stage?._id !== env.RD_STAGE_SEM_RETORNO,
      );
      if (activeDeal) {
        await updateLeadData(phone, { rd_deal_id: activeDeal._id });
      }

      await logEvent('crm_sync', phone, { action: 'basic_sync_existing_contact', contactId: contact._id });
      trackRdSync(true);
      return;
    }

    // Criar deal + contato
    // Usar telefone formatado como fallback (nunca "Lead WhatsApp" genérico)
    const formattedPhone = phone.replace(/^55(\d{2})(\d+)/, '($1) $2');
    const leadName = name || lead.name || formattedPhone;
    const deal = await createDeal(leadName, phone, env.RD_STAGE_CONTATO_FEITO);
    const contactId = await resolveContactId(phone);

    await updateLeadData(phone, {
      rd_deal_id: deal._id,
      rd_contact_id: contactId || undefined,
    });

    await logEvent('crm_sync', phone, {
      action: 'basic_sync_created',
      dealId: deal._id,
      contactId,
    });
    trackRdSync(true);
    logger.info('CRM sync básico: lead registrado no RD', { phone, dealId: deal._id });
  } catch (error) {
    trackRdSync(false);
    logger.warn('CRM sync básico falhou (não bloqueia fluxo)', { phone, error: String(error) });
  }
}

/**
 * Chamado quando cadastra_lead com agendado=false ou via POST /form
 */
export async function syncLeadCreated(lead: Lead): Promise<void> {
  try {
    const freshLead = await findLeadByPhone(lead.phone) || lead;
    const leadName = freshLead.name || lead.name || 'Lead';

    const contact = await findContactByPhone(lead.phone);

    if (!contact) {
      const deal = await createDeal(
        leadName,
        lead.phone,
        env.RD_STAGE_CONTATO_FEITO,
      );

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
      trackRdSync(true);
      logger.info('CRM sync: deal + contato criados', { phone: lead.phone, dealId: deal._id, contactId });

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

    await safeUpdateContact(contact._id, freshLead);

    trackRdSync(true);
    logger.info('CRM sync: lead cadastrado sincronizado', { phone: lead.phone });
  } catch (error) {
    trackRdSync(false);
    logger.error('CRM sync falhou (lead criado)', { phone: lead.phone, error });
    await logEvent('error', lead.phone, { crm_sync: 'lead_created', error: String(error) });
  }
}

/**
 * Chamado quando cadastra_lead com agendado=true ou registra_agendamento.
 * Fix: verifica rd_deal_id local antes de criar novo deal (evita duplicados).
 */
export async function syncLeadScheduled(lead: Lead): Promise<void> {
  // C3: Mutex Redis — evitar race condition de deals duplicados
  const lockKey = `sync_scheduled_lock:${lead.phone}`;
  const locked = await redisClient.set(lockKey, '1', { NX: true, EX: 30 });
  if (!locked) {
    logger.info('syncLeadScheduled já em andamento, ignorando', { phone: lead.phone });
    return;
  }

  try {
    const freshLead = await findLeadByPhone(lead.phone) || lead;
    const leadName = freshLead.name || lead.name || 'Lead';

    // Fix deals duplicados: se já temos rd_deal_id, mover em vez de criar
    if (freshLead.rd_deal_id) {
      try {
        await moveDealToStage(freshLead.rd_deal_id, env.RD_STAGE_AGENDADO);
        await logEvent('crm_sync', lead.phone, {
          action: 'deal_moved_agendado',
          dealId: freshLead.rd_deal_id,
        });
        logger.info('CRM sync: deal existente movido para Agendado', {
          phone: lead.phone,
          dealId: freshLead.rd_deal_id,
        });

        // Atualizar contato com dados de cotação
        if (freshLead.rd_contact_id) {
          await safeUpdateContact(freshLead.rd_contact_id, freshLead);
        }

        trackRdSync(true);
        return;
      } catch (moveError) {
        logger.warn('Falha ao mover deal existente, tentando fluxo completo', {
          phone: lead.phone,
          dealId: freshLead.rd_deal_id,
          error: String(moveError),
        });
        // Continua para o fluxo completo se mover falhar
      }
    }

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
      trackRdSync(true);
      logger.info('CRM sync: deal criado no estágio Agendado', { phone: lead.phone });
      return;
    }

    // Atualizar contato
    await safeUpdateContact(contact._id, freshLead);
    await updateLeadData(lead.phone, { rd_contact_id: contact._id });

    // Buscar deals e mover o primeiro ativo para Agendado (não criar novo)
    const deals = await findDealsByContact(contact._id);
    const activeDeal = deals.find((d) =>
      d.deal_stage?._id !== env.RD_STAGE_SEM_RETORNO && d.deal_stage?._id !== env.RD_STAGE_AGENDADO,
    );

    if (activeDeal) {
      await moveDealToStage(activeDeal._id, env.RD_STAGE_AGENDADO);
      await updateLeadData(lead.phone, { rd_deal_id: activeDeal._id });
      await logEvent('crm_sync', lead.phone, {
        action: 'deal_moved_agendado',
        dealId: activeDeal._id,
      });
    } else {
      // Verificar se já tem deal em Agendado
      const alreadyScheduled = deals.find((d) => d.deal_stage?._id === env.RD_STAGE_AGENDADO);
      if (alreadyScheduled) {
        await updateLeadData(lead.phone, { rd_deal_id: alreadyScheduled._id });
        await logEvent('crm_sync', lead.phone, {
          action: 'deal_already_agendado',
          dealId: alreadyScheduled._id,
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
    }

    trackRdSync(true);
    logger.info('CRM sync: lead agendado sincronizado', { phone: lead.phone });
  } catch (error) {
    trackRdSync(false);
    logger.error('CRM sync falhou (lead agendado)', { phone: lead.phone, error });
    await logEvent('error', lead.phone, { crm_sync: 'lead_scheduled', error: String(error) });
  } finally {
    await redisClient.del(lockKey);
  }
}

/**
 * Converte "DD/MM/AAAA" para "AAAA-MM-DD" (ISO 8601, formato do RD Station)
 */
import { convertBirthdayToISO } from '../utils/date';

// IDs dos campos customizados do RD Station CRM (mapeados do contato real)
const RD_CUSTOM_FIELDS = {
  data_nascimento: '69bb4655626559001e2972b4',
  altura: '69bddd471c94960018bc1e3b',
  peso: '69bddd58fb02050016cc04c0',
  profissao: '69c2fe8d92aa8d001fd8313e',
  renda_mensal: '69bddc67d1fc640019a59ba9',
  fumante: '69bc628005b2d80026edfa48',
  cpf: '69bd76d25047c3001da71f9f',
  filhos: '69bb46a542ab9c00191305f8',
};

/**
 * Monta array de custom fields para enviar ao RD Station
 */
function buildCustomFields(lead: Lead): Array<{ custom_field_id: string; value: string | string[] }> {
  const fields: Array<{ custom_field_id: string; value: string | string[] }> = [];

  if (lead.birth_date) {
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.data_nascimento, value: lead.birth_date });
  }
  if (lead.height) {
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.altura, value: lead.height });
  }
  if (lead.weight) {
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.peso, value: lead.weight });
  }
  if (lead.profession) {
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.profissao, value: lead.profession });
  }
  if (lead.income) {
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.renda_mensal, value: lead.income });
  }
  if (lead.smoker) {
    const smokerValue = lead.smoker.toLowerCase().includes('sim') ? ['Sim'] : ['Não'];
    fields.push({ custom_field_id: RD_CUSTOM_FIELDS.fumante, value: smokerValue });
  }
  if (lead.cpf) {
    // Limpar CPF: remover pontos, traços e espaços. Ignorar se não é numérico (ex: "não")
    const cleanCpf = lead.cpf.replace(/[\.\-\s]/g, '');
    if (/^\d{11}$/.test(cleanCpf)) {
      fields.push({ custom_field_id: RD_CUSTOM_FIELDS.cpf, value: cleanCpf });
    }
  }

  return fields;
}

/**
 * Atualizar contato no RD Station — best-effort, não bloqueia o fluxo.
 * Preenche campos customizados individualmente + notas como backup.
 */
async function safeUpdateContact(contactId: string, lead: Lead): Promise<void> {
  try {
    const data: Record<string, unknown> = {};
    if (lead.name) data.name = lead.name;

    // Preencher campos customizados individualmente
    const customFields = buildCustomFields(lead);
    if (customFields.length > 0) {
      data.contact_custom_fields = customFields;
    }

    if (Object.keys(data).length === 0) return;

    await updateContact(contactId, data);

    await logEvent('crm_sync', lead.phone, {
      action: 'custom_fields_updated',
      fieldsCount: customFields.length,
    });
  } catch (error) {
    logger.warn('updateContact falhou (best-effort, continuando)', { contactId, error });
    await logEvent('crm_sync', lead.phone, {
      action: 'update_contact_failed_best_effort',
      contactId,
      error: String(error),
    });
  }
}
