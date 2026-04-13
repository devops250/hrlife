import { env } from '../config/env';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';

export class UazapiClient {
  private baseUrl = env.UAZAPI_BASE_URL;
  private token = env.UAZAPI_INSTANCE_TOKEN;

  private async request(path: string, body: object): Promise<Response> {
    return fetch(`${this.baseUrl}${path}?token=${this.token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async sendText(phone: string, text: string): Promise<void> {
    await retry(
      async () => {
        const res = await this.request('/send/text', {
          number: phone,
          text,
          delay: 2000,
          readchat: true,
        });
        if (!res.ok) {
          const err = await res.text();

          // Número não existe no WhatsApp — erro permanente, não faz sentido retry
          if (err.includes('is not on WhatsApp')) {
            logger.warn('Número não está no WhatsApp', { phone });
            throw new NotOnWhatsAppError(phone);
          }

          // Instância desconectada — erro sistêmico, não adianta retry
          if (res.status === 503 && err.includes('WhatsApp disconnected')) {
            throw new WhatsAppDisconnectedError();
          }

          throw new Error(`UAZAPI sendText falhou (${res.status}): ${err}`);
        }
        logger.info('Mensagem enviada via UAZAPI', { phone });
      },
      { label: 'uazapi.sendText', maxAttempts: 3 },
    );
  }

  static isNotOnWhatsApp(error: unknown): boolean {
    return error instanceof NotOnWhatsAppError;
  }

  async checkHealth(): Promise<{ connected: boolean; instanceName: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/status?token=${this.token}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { connected: false, instanceName: '' };
      const data = await res.json() as {
        status: { checked_instance: { connection_status: string; is_healthy: boolean; name: string } };
      };
      const inst = data.status?.checked_instance;
      return {
        connected: inst?.connection_status === 'connected' && inst?.is_healthy === true,
        instanceName: inst?.name || '',
      };
    } catch {
      return { connected: false, instanceName: '' };
    }
  }

  async downloadMedia(messageId: string): Promise<Buffer> {
    return retry(
      async () => {
        const res = await this.request('/message/download', { messageId });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`UAZAPI downloadMedia falhou (${res.status}): ${err}`);
        }
        const data = await res.json() as { fileURL: string };
        const fileRes = await fetch(data.fileURL);
        if (!fileRes.ok) {
          throw new Error(`Download do arquivo falhou (${fileRes.status})`);
        }
        const arrayBuffer = await fileRes.arrayBuffer();
        return Buffer.from(arrayBuffer);
      },
      { label: 'uazapi.downloadMedia' },
    );
  }
}

export class NotOnWhatsAppError extends Error {
  constructor(public phone: string) {
    super(`Número ${phone} não está no WhatsApp`);
    this.name = 'NotOnWhatsAppError';
  }
}

export class WhatsAppDisconnectedError extends Error {
  constructor() {
    super('WhatsApp disconnected — instância desconectada');
    this.name = 'WhatsAppDisconnectedError';
  }
}

export const uazapi = new UazapiClient();
