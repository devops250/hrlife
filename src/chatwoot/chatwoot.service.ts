import { env } from '../config/env';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';

const baseUrl = () => `${env.CHATWOOT_API_URL}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}`;

async function request(method: string, path: string, body?: object): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      api_access_token: env.CHATWOOT_API_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function findContactByPhone(phone: string): Promise<{ id: number } | null> {
  return retry(
    async () => {
      const res = await request('GET', `/contacts/search?q=${phone}&include_contacts=true`);
      if (!res.ok) return null;
      const data = await res.json() as { payload: Array<{ id: number; phone_number: string }> };
      return data.payload?.find((c) => c.phone_number?.includes(phone)) || null;
    },
    { label: 'chatwoot.findContact' },
  );
}

export async function createContact(phone: string, name: string): Promise<{ id: number }> {
  return retry(
    async () => {
      const res = await request('POST', '/contacts', {
        name: name || 'Lead',
        phone_number: `+${phone}`,
        identifier: phone,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Chatwoot createContact falhou (${res.status}): ${err}`);
      }
      const data = await res.json() as { payload: { contact: { id: number } } };
      logger.info('Contato criado no Chatwoot', { phone, contactId: data.payload.contact.id });
      return { id: data.payload.contact.id };
    },
    { label: 'chatwoot.createContact' },
  );
}

export async function createConversation(contactId: number): Promise<{ id: number }> {
  return retry(
    async () => {
      const res = await request('POST', '/conversations', {
        contact_id: contactId,
        inbox_id: parseInt(env.CHATWOOT_INBOX_ID, 10),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Chatwoot createConversation falhou (${res.status}): ${err}`);
      }
      const data = await res.json() as { id: number };
      logger.info('Conversa criada no Chatwoot', { contactId, conversationId: data.id });
      return { id: data.id };
    },
    { label: 'chatwoot.createConversation' },
  );
}

export async function sendMessage(
  conversationId: number,
  content: string,
  type: 'incoming' | 'outgoing',
): Promise<void> {
  return retry(
    async () => {
      const res = await request('POST', `/conversations/${conversationId}/messages`, {
        content,
        message_type: type,
        private: false,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Chatwoot sendMessage falhou (${res.status}): ${err}`);
      }
    },
    { label: 'chatwoot.sendMessage' },
  );
}
