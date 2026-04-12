import { env } from '../config/env';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';

const BASE_URL = 'https://crm.rdstation.com/api/v1';

export interface RDContact {
  _id: string;
  id: string;
  name: string;
  phones: Array<{ phone: string }>;
  birthday: string | null;
  contact_custom_fields: Array<{ custom_field_id: string; value: string }>;
}

export interface RDDeal {
  _id: string;
  id: string;
  name: string;
  deal_stage: { _id: string; name: string };
  contacts: Array<{ name: string; phones: Array<{ phone: string }> }>;
}

async function request(method: string, path: string, body?: object): Promise<Response> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE_URL}${path}${separator}token=${env.RDSTATION_API_TOKEN}`;

  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function findContactByPhone(phone: string): Promise<RDContact | null> {
  return retry(
    async () => {
      const cleanPhone = phone.replace(/\D/g, '');
      const res = await request('GET', `/contacts?phone=${cleanPhone}`);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD findContact falhou (${res.status}): ${err}`);
      }
      const data = await res.json() as { contacts: RDContact[] };
      return data.contacts?.[0] || null;
    },
    { label: 'rdstation.findContactByPhone' },
  );
}

export async function createDeal(
  name: string,
  phone: string,
  stageId?: string,
): Promise<RDDeal> {
  return retry(
    async () => {
      const cleanPhone = phone.replace(/\D/g, '');
      const body: Record<string, unknown> = {
        deal: {
          name: `${name || 'Lead'} - Lead IA`,
          deal_pipeline_id: env.RD_PIPELINE_ID,
          deal_stage_id: stageId || env.RD_STAGE_CONTATO_FEITO,
          user_id: env.RD_USER_ID,
        },
        contacts: [
          {
            name: name || 'Lead',
            phones: [{ phone: cleanPhone, type: 'cellphone' }],
          },
        ],
      };

      const res = await request('POST', '/deals', body);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD createDeal falhou (${res.status}): ${err}`);
      }
      const deal = await res.json() as RDDeal;
      logger.info('Deal criado no RD Station', { dealId: deal._id, name, stage: stageId || 'contato_feito' });
      return deal;
    },
    { label: 'rdstation.createDeal' },
  );
}

export async function updateContact(contactId: string, data: Record<string, unknown>): Promise<void> {
  return retry(
    async () => {
      const res = await request('PUT', `/contacts/${contactId}`, { contact: data });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD updateContact falhou (${res.status}): ${err}`);
      }
      logger.info('Contato atualizado no RD Station', { contactId });
    },
    { label: 'rdstation.updateContact' },
  );
}

export async function findDealsByContact(contactId: string): Promise<RDDeal[]> {
  return retry(
    async () => {
      const res = await request('GET', `/deals?contact_id=${contactId}`);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD findDeals falhou (${res.status}): ${err}`);
      }
      const data = await res.json() as { deals: RDDeal[] };
      return data.deals || [];
    },
    { label: 'rdstation.findDealsByContact' },
  );
}

export async function moveDealToStage(dealId: string, stageId: string): Promise<void> {
  return retry(
    async () => {
      const res = await request('PUT', `/deals/${dealId}`, {
        deal: { deal_stage_id: stageId },
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD moveDeal falhou (${res.status}): ${err}`);
      }
      logger.info('Deal movido para novo estágio', { dealId, stageId });
    },
    { label: 'rdstation.moveDealToStage' },
  );
}

export async function updateDeal(dealId: string, data: Record<string, unknown>): Promise<void> {
  return retry(
    async () => {
      const res = await request('PUT', `/deals/${dealId}`, { deal: data });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD updateDeal falhou (${res.status}): ${err}`);
      }
      logger.info('Deal atualizado no RD Station', { dealId });
    },
    { label: 'rdstation.updateDeal' },
  );
}

export async function moveDealToLost(dealId: string, reason = 'Sem retorno'): Promise<void> {
  return retry(
    async () => {
      const res = await request('PUT', `/deals/${dealId}`, {
        deal: {
          deal_stage_id: env.RD_STAGE_SEM_RETORNO,
          closed_at: new Date().toISOString(),
        },
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RD moveDealToLost falhou (${res.status}): ${err}`);
      }
      logger.info('Deal movido para Sem Retorno', { dealId, reason });
    },
    { label: 'rdstation.moveDealToLost' },
  );
}
