import { query } from './client';

export interface Conversation {
  id: number;
  phone: string;
  role: string;
  content: string;
  created_at: Date;
}

export async function addMessage(phone: string, role: string, content: string): Promise<void> {
  await query(
    'INSERT INTO conversations (phone, role, content) VALUES ($1, $2, $3)',
    [phone, role, content],
  );
}

export async function getHistory(phone: string, limit = 20): Promise<Conversation[]> {
  const result = await query(
    'SELECT * FROM conversations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2',
    [phone, limit],
  );
  return result.rows.reverse();
}
