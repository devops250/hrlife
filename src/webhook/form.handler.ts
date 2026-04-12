/**
 * Form Webhook Handler — Delega ao Lead Pipeline.
 * Responsável apenas por: extrair campos → chamar pipeline.
 */

import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { processIncomingLead } from './lead-pipeline';

const NAME_FIELDS = ['nome', 'name', 'full_name', 'nome_completo', 'first_name'];
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

export async function formHandler(req: Request, res: Response): Promise<void> {
  res.status(200).json({ received: true });

  try {
    const rawBody = req.body?.body || req.body || {};

    logger.info('Form webhook recebido', {
      payload: JSON.stringify(rawBody).substring(0, 500),
      keys: Object.keys(rawBody),
    });

    const nome = extractField(rawBody, NAME_FIELDS);
    const telefone = extractField(rawBody, PHONE_FIELDS);
    const email = extractField(rawBody, EMAIL_FIELDS);

    if (!telefone) {
      logger.warn('Form webhook sem telefone', { keys: Object.keys(rawBody) });
      return;
    }

    await processIncomingLead({
      phone: telefone,
      name: nome,
      email,
      source: 'meta_form',
    });
  } catch (error) {
    logger.error('Erro no form handler', { error });
  }
}
