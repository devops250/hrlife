import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { logEvent } from '../database/events.repo';
import { incrementMetric } from '../monitoring/metrics';
import { processIncomingLead } from './lead-pipeline';

import { env } from '../config/env';
const META_ACCESS_TOKEN = env.META_ACCESS_TOKEN;
const META_VERIFY_TOKEN = env.META_VERIFY_TOKEN;

/**
 * GET /webhook/meta — Verificação do webhook (Facebook challenge)
 */
export function metaVerifyHandler(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    logger.info('Meta webhook verificado com sucesso');
    res.status(200).send(challenge);
  } else {
    logger.warn('Meta webhook verificação falhou', { mode, token });
    res.status(403).send('Forbidden');
  }
}

/**
 * POST /webhook/meta — Recebe leadgen events do Meta Lead Ads
 */
export async function metaLeadHandler(req: Request, res: Response): Promise<void> {
  // Responder 200 imediatamente (Meta exige resposta rápida)
  res.status(200).json({ received: true });

  try {
    const body = req.body;

    if (!body?.entry) {
      logger.warn('Meta webhook sem entry', { keys: Object.keys(body || {}) });
      return;
    }

    for (const entry of body.entry) {
      const changes = entry.changes || [];

      for (const change of changes) {
        if (change.field !== 'leadgen') continue;

        const leadgenId = change.value?.leadgen_id;
        const formId = change.value?.form_id;
        const pageId = change.value?.page_id;

        if (!leadgenId) {
          logger.warn('Meta leadgen sem leadgen_id', { change });
          continue;
        }

        logger.info('Meta leadgen recebido', { leadgenId, formId, pageId });
        await logEvent('webhook_received', undefined, {
          source: 'meta_leadgen',
          leadgenId,
          formId,
          pageId,
        });
        incrementMetric('webhooksReceived');

        // Buscar dados completos do lead via Graph API
        await processMetaLead(leadgenId);
      }
    }
  } catch (error) {
    logger.error('Erro no meta lead handler', { error });
    await logEvent('error', undefined, { handler: 'meta_lead', error: String(error) });
  }
}

/**
 * Busca dados do lead via Graph API e processa
 */
async function processMetaLead(leadgenId: string): Promise<void> {
  try {
    if (!META_ACCESS_TOKEN) {
      logger.error('META_ACCESS_TOKEN não configurado');
      return;
    }

    // Buscar dados do lead no Meta
    const url = `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${META_ACCESS_TOKEN}`;
    const res = await fetch(url);

    if (!res.ok) {
      const errorText = await res.text();
      logger.error('Meta Graph API falhou', { status: res.status, error: errorText, leadgenId });
      await logEvent('error', undefined, {
        handler: 'meta_lead',
        action: 'graph_api_failed',
        status: res.status,
        error: errorText.substring(0, 200),
        leadgenId,
      });
      return;
    }

    const data = await res.json() as {
      id: string;
      field_data: Array<{ name: string; values: string[] }>;
      created_time: string;
    };

    // Extrair campos do formulário
    const fields: Record<string, string> = {};
    for (const field of data.field_data || []) {
      fields[field.name.toLowerCase()] = field.values?.[0] || '';
    }

    logger.info('Meta lead dados extraídos', { leadgenId, fields: Object.keys(fields) });

    // Extrair nome e telefone (Meta usa vários nomes de campo)
    const nome = fields.full_name || fields.nome || fields.name ||
      [fields.first_name, fields.last_name].filter(Boolean).join(' ') || '';

    const telefone = fields.phone_number || fields.telefone || fields.phone ||
      fields.celular || fields.whatsapp || '';

    if (!telefone) {
      logger.warn('Meta lead sem telefone', { leadgenId, fields });
      await logEvent('error', undefined, {
        handler: 'meta_lead',
        action: 'no_phone',
        leadgenId,
        fields: JSON.stringify(fields).substring(0, 300),
      });
      return;
    }

    // Delegar ao Pipeline (cuida de tudo: criar, enviar msg, sync CRM, notificar)
    await processIncomingLead({
      phone: telefone,
      name: nome,
      email: fields.email,
      source: 'meta_lead',
    });

    logger.info('Meta lead processado via pipeline', { phone: telefone, nome, leadgenId });
  } catch (error) {
    logger.error('Erro ao processar meta lead', { leadgenId, error });
    await logEvent('error', undefined, {
      handler: 'meta_lead',
      action: 'process_failed',
      leadgenId,
      error: String(error),
    });
  }
}
