import cron from 'node-cron';
import { query } from '../database/client';
import { logger } from '../utils/logger';
import { isBusinessHours } from '../config/schedule';
import { getNextStage } from './stages';
import { enqueueForFollowup, getQueuedFollowups } from './queue';
import { uazapi } from '../whatsapp/uazapi.client';
import { logEvent } from '../database/events.repo';
import { moveDealToStage } from '../crm/rdstation.service';
import { env } from '../config/env';
import { UazapiClient, NotOnWhatsAppError } from '../whatsapp/uazapi.client';
import { findLeadByPhone, type Lead } from '../database/leads.repo';

const BATCH_SIZE = 10;
const DELAY_BETWEEN_SENDS_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let isRunning = false;

async function acquireLock(): Promise<boolean> {
  try {
    const { redisClient } = await import('../config/redis');
    const result = await redisClient.set('followup:lock', '1', { NX: true, EX: 290 });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  try {
    const { redisClient } = await import('../config/redis');
    await redisClient.del('followup:lock');
  } catch { /* best effort */ }
}

export async function reactivatePausedLeads(): Promise<number> {
  let count = 0;
  const pausedResult = await query(
    `SELECT * FROM leads
     WHERE status = 'paused'
       AND last_manual_message IS NOT NULL
       AND last_manual_message < NOW() - INTERVAL '30 minutes'`,
  );

  for (const lead of pausedResult.rows as Lead[]) {
    await query(
      "UPDATE leads SET status = 'active', has_lead_replied = true, followup_status = 0, last_manual_message = NULL, updated_at = NOW() WHERE phone = $1",
      [lead.phone],
    );
    await logEvent('lead_auto_resumed', lead.phone, { reason: '30min sem resposta manual' });
    logger.info('Lead reativado automaticamente (30min sem resposta manual)', { phone: lead.phone });
    count++;
  }

  return count;
}

async function processFollowups(): Promise<void> {
  if (isRunning) {
    logger.warn('Follow-up scheduler já está rodando (memory lock), pulando');
    return;
  }

  const hasLock = await acquireLock();
  if (!hasLock) {
    logger.warn('Follow-up scheduler já está rodando (redis lock), pulando');
    return;
  }

  isRunning = true;

  const startTime = Date.now();
  let sent = 0;
  let queued = 0;
  let skipped = 0;

  try {
    logger.info('Follow-up scheduler iniciado');

    // 0. Reativar leads pausados há 30+ min (Rodrigo não respondeu mais)
    const reactivated = await reactivatePausedLeads();

    // 1. Processar fila noturna primeiro (se estiver em horário comercial)
    if (isBusinessHours()) {
      const queuedItems = await getQueuedFollowups();
      for (const item of queuedItems) {
        try {
          await uazapi.sendText(item.phone, item.message);
          await query(
            'UPDATE leads SET followup_status = $1, last_ia_message = NOW(), updated_at = NOW() WHERE phone = $2',
            [item.stage, item.phone],
          );
          await query(
            'INSERT INTO followup_log (phone, stage, message) VALUES ($1, $2, $3)',
            [item.phone, item.stage, item.message],
          );
          await logEvent('followup_sent', item.phone, { stage: item.stage, source: 'queue' });
          sent++;
          await sleep(DELAY_BETWEEN_SENDS_MS);
        } catch (error) {
          logger.error('Erro ao enviar follow-up da fila', { phone: item.phone, error });
          await query(
            'INSERT INTO followup_log (phone, stage, message, success) VALUES ($1, $2, $3, false)',
            [item.phone, item.stage, item.message],
          );
        }
      }
      if (queuedItems.length > 0) {
        logger.info(`Fila noturna processada: ${sent} enviados de ${queuedItems.length}`);
      }
    }

    // 2. Buscar leads elegíveis para follow-up (excluir agendados)
    const result = await query(
      `SELECT * FROM leads
       WHERE status = 'active'
         AND has_lead_replied = false
         AND scheduled = false
         AND followup_status < 4
         AND last_ia_message IS NOT NULL
       ORDER BY last_ia_message ASC
       LIMIT $1`,
      [BATCH_SIZE],
    );

    const leads: Lead[] = result.rows;

    for (const lead of leads) {
      // Re-buscar lead do banco para garantir dados atualizados
      const freshLead = await findLeadByPhone(lead.phone);
      if (!freshLead || freshLead.status !== 'active' || freshLead.has_lead_replied || freshLead.scheduled) {
        skipped++;
        continue;
      }

      const next = await getNextStage(freshLead);
      if (!next) {
        skipped++;
        continue;
      }

      // Fora do horário comercial → enfileirar
      if (!isBusinessHours()) {
        await enqueueForFollowup(lead.phone, next.stage, next.message);
        queued++;
        continue;
      }

      try {
        await uazapi.sendText(lead.phone, next.message);
        await query(
          'UPDATE leads SET followup_status = $1, last_ia_message = NOW(), updated_at = NOW() WHERE phone = $2',
          [next.stage, lead.phone],
        );
        await query(
          'INSERT INTO followup_log (phone, stage, message) VALUES ($1, $2, $3)',
          [lead.phone, next.stage, next.message],
        );
        await logEvent('followup_sent', lead.phone, { stage: next.stage });
        sent++;
        await sleep(DELAY_BETWEEN_SENDS_MS);
      } catch (error) {
        if (error instanceof NotOnWhatsAppError) {
          // Número inválido — pausar lead para não ficar tentando
          await query(
            "UPDATE leads SET status = 'invalid_phone', updated_at = NOW() WHERE phone = $1",
            [lead.phone],
          );
          await logEvent('lead_invalid_phone', lead.phone, { stage: next.stage });
          logger.warn('Lead com número inválido no WhatsApp, marcado como invalid_phone', { phone: lead.phone });
        } else {
          logger.error('Erro ao enviar follow-up', { phone: lead.phone, error });
          await query(
            'INSERT INTO followup_log (phone, stage, message, success) VALUES ($1, $2, $3, false)',
            [lead.phone, next.stage, next.message],
          );
          await logEvent('error', lead.phone, { followup: true, stage: next.stage, error: String(error) });
        }
      }
    }

    // 3. Mover leads esgotados (status=4, sem resposta, não agendados) para "Sem Retorno"
    let closed = 0;
    const exhaustedResult = await query(
      `SELECT * FROM leads
       WHERE status = 'active'
         AND has_lead_replied = false
         AND scheduled = false
         AND followup_status >= 4
         AND last_ia_message IS NOT NULL
         AND last_ia_message < NOW() - INTERVAL '24 hours'
       LIMIT $1`,
      [BATCH_SIZE],
    );

    for (const lead of exhaustedResult.rows as Lead[]) {
      try {
        await query(
          "UPDATE leads SET status = 'exhausted', updated_at = NOW() WHERE phone = $1",
          [lead.phone],
        );

        if (lead.rd_deal_id) {
          await moveDealToStage(lead.rd_deal_id, env.RD_STAGE_SEM_RETORNO);
        }

        await logEvent('followup_exhausted', lead.phone, {
          rd_deal_id: lead.rd_deal_id,
          stage: 'sem_retorno',
        });
        closed++;
        logger.info('Lead esgotou follow-ups, movido para Sem Retorno', { phone: lead.phone });
      } catch (error) {
        logger.error('Erro ao encerrar lead esgotado', { phone: lead.phone, error });
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info('Follow-up scheduler finalizado', {
      elapsed_ms: elapsed,
      leads_checked: leads.length,
      sent,
      queued,
      skipped,
      closed,
      reactivated,
    });
  } catch (error) {
    logger.error('Erro no follow-up scheduler', { error });
    await logEvent('error', undefined, { scheduler: 'followup', error: String(error) });
  } finally {
    isRunning = false;
    await releaseLock();
  }
}

export function startFollowupScheduler(): void {
  cron.schedule('*/5 * * * *', () => {
    processFollowups().catch((err) => {
      logger.error('Erro fatal no follow-up scheduler', { error: err });
    });
  });
  logger.info('Follow-up scheduler registrado (a cada 5 minutos)');
}
