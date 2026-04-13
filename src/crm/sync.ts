import { env } from '../config/env';
import { findContactByPhone, createDeal, findDealsByContact, moveDealToStage } from './rdstation.service';
import { updateLeadData, findLeadByPhone, type Lead } from '../database/leads.repo';
import { logEvent, logError } from '../database/events.repo';
import { logger } from '../utils/logger';
import { trackRdSync } from '../monitoring/metrics';
import { redisClient } from '../config/redis';
import { resolveContactId, safeUpdateContact, ensureDealScheduled } from './sync-contact';

async function withCrmLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `crm_lock:${phone}`;
  const acquired = await redisClient.set(lockKey, '1', { NX: true, EX: 30 });
  if (!acquired) {
    logger.warn('CRM sync: lock não adquirido, aguardando 2s e tentando novamente', { phone });
    await new Promise((r) => setTimeout(r, 2000));
    const retry = await redisClient.set(lockKey, '1', { NX: true, EX: 30 });
    if (!retry) {
      logger.warn('CRM sync: lock timeout — possível sync duplicado em andamento', { phone });
      throw new Error(`CRM sync lock timeout para ${phone}`);
    }
  }
  try {
    return await fn();
  } finally {
    await redisClient.del(lockKey);
  }
}

/**
 * Sync básico: cria contato/deal no RD quando o lead chega (antes da coleta completa).
 * Chamado pelo webhook handler ao receber primeira mensagem.
 */
export async function syncLeadBasic(phone: string, name?: string): Promise<void> {
  return withCrmLock(phone, async () => {
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
  });
}

/**
 * Chamado quando cadastra_lead com agendado=false ou via POST /form
 */
export async function syncLeadCreated(lead: Lead): Promise<void> {
  return withCrmLock(lead.phone, async () => {
    try {
      const freshLead = await findLeadByPhone(lead.phone) || lead;
      const leadName = freshLead.name || lead.name || 'Lead';

      const contact = await findContactByPhone(lead.phone);

      if (!contact) {
        const recheckedLead = await findLeadByPhone(lead.phone);
        if (recheckedLead?.rd_deal_id) {
          logger.info('CRM sync: deal já criado por outro processo (recheck fallback)', { phone: lead.phone });
          return;
        }

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
      await logError(lead.phone, { crm_sync: 'lead_created' }, error);
    }
  });
}

/**
 * Chamado quando cadastra_lead com agendado=true ou registra_agendamento.
 * Fix: verifica rd_deal_id local antes de criar novo deal (evita duplicados).
 */
export async function syncLeadScheduled(lead: Lead): Promise<void> {
  return withCrmLock(lead.phone, async () => {
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
        const recheckedLead = await findLeadByPhone(lead.phone);
        if (recheckedLead?.rd_deal_id) {
          logger.info('CRM sync: deal já criado por outro processo (recheck fallback)', { phone: lead.phone });
          return;
        }

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

      await safeUpdateContact(contact._id, freshLead);
      await updateLeadData(lead.phone, { rd_contact_id: contact._id });
      await ensureDealScheduled(contact, leadName, lead.phone);

      trackRdSync(true);
      logger.info('CRM sync: lead agendado sincronizado', { phone: lead.phone });
    } catch (error) {
      trackRdSync(false);
      logger.error('CRM sync falhou (lead agendado)', { phone: lead.phone, error });
      await logError(lead.phone, { crm_sync: 'lead_scheduled' }, error);
    }
  });
}
