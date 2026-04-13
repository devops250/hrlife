import { logger } from './logger';

interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  label?: string;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000, label = 'operation' } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Erros permanentes — não faz sentido retry
      if (error instanceof Error && (error.name === 'NotOnWhatsAppError' || error.name === 'WhatsAppDisconnectedError')) {
        throw error;
      }
      if (attempt === maxAttempts) {
        logger.error(`${label} falhou após ${maxAttempts} tentativas`, { error });
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      logger.warn(`${label} tentativa ${attempt}/${maxAttempts} falhou, retry em ${delay}ms`, { error });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unreachable');
}
