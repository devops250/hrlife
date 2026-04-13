import { query } from './client';

export async function logEvent(type: string, phone?: string, payload?: object): Promise<void> {
  await query(
    'INSERT INTO events (type, phone, payload) VALUES ($1, $2, $3)',
    [type, phone || null, payload ? JSON.stringify(payload) : null],
  );
}

export async function getEventsToday(type?: string): Promise<Array<{ type: string; phone: string; payload: object; created_at: Date }>> {
  const sql = type
    ? "SELECT * FROM events WHERE type = $1 AND created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo' ORDER BY created_at DESC"
    : "SELECT * FROM events WHERE created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo' ORDER BY created_at DESC";
  const result = await query(sql, type ? [type] : []);
  return result.rows;
}

export async function getErrorsLast24h(): Promise<Array<{ type: string; phone: string; payload: object; created_at: Date }>> {
  const result = await query(
    "SELECT * FROM events WHERE type = 'error' AND created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC",
  );
  return result.rows;
}

export async function getLastWebhookTime(): Promise<Date | null> {
  const result = await query(
    "SELECT created_at FROM events WHERE type = 'webhook_received' ORDER BY created_at DESC LIMIT 1",
  );
  return result.rows[0]?.created_at || null;
}

export async function logError(
  phone: string | undefined,
  context: Record<string, unknown>,
  error?: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  const stack = error instanceof Error && error.stack ? error.stack.substring(0, 500) : undefined;
  await logEvent('error', phone, { ...context, message, ...(stack ? { stack } : {}) });
}
