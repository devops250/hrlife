/**
 * Pluga Webhook Handler — Delega ao Lead Pipeline.
 * Responsável apenas por: extrair campos → chamar pipeline.
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { processIncomingLead } from './lead-pipeline';

const NAME_FIELDS = ['nome', 'name', 'full_name', 'nome_completo'];
const PHONE_FIELDS = ['telefone', 'phone', 'celular', 'whatsapp', 'mobile', 'phone_number'];
const EMAIL_FIELDS = ['email', 'e-mail', 'email_address'];

function extractField(body: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = body[field];
    if (value && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

export async function plugaHandler(req: Request, res: Response): Promise<void> {
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};

    logger.info('Pluga webhook recebido', {
      payload: JSON.stringify(body).substring(0, 500),
      keys: Object.keys(body),
    });

    const nome = extractField(body, NAME_FIELDS);
    const telefone = extractField(body, PHONE_FIELDS);
    const email = extractField(body, EMAIL_FIELDS);

    if (!telefone) {
      logger.warn('Pluga webhook sem telefone', { keys: Object.keys(body) });
      return;
    }

    await processIncomingLead({
      phone: telefone,
      name: nome,
      email,
      source: 'pluga',
    });
  } catch (error) {
    logger.error('Erro no pluga handler', { error });
  }
}
