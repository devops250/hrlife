import { query } from './client';

export interface Lead {
  id: number;
  phone: string;
  name: string | null;
  source: string;
  status: string;
  birth_date: string | null;
  height: string | null;
  weight: string | null;
  profession: string | null;
  smoker: string | null;
  filhos?: string | null;
  income: string | null;
  cpf: string | null;
  scheduled: boolean;
  scheduled_at: Date | null;
  followup_status: number;
  last_ia_message: Date | null;
  last_lead_message: Date | null;
  has_lead_replied: boolean;
  rd_contact_id: string | null;
  rd_deal_id: string | null;
  chatwoot_contact_id: number | null;
  chatwoot_conversation_id: number | null;
  last_manual_message: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function findLeadByPhone(phone: string): Promise<Lead | null> {
  const result = await query('SELECT * FROM leads WHERE phone = $1', [phone]);
  return result.rows[0] || null;
}

export async function createLead(phone: string, name?: string, source = 'whatsapp'): Promise<Lead> {
  const result = await query(
    'INSERT INTO leads (phone, name, source) VALUES ($1, $2, $3) RETURNING *',
    [phone, name || null, source],
  );
  return result.rows[0];
}

export async function updateLeadOnMessage(phone: string): Promise<void> {
  await query(
    `UPDATE leads SET
       last_lead_message = NOW(),
       has_lead_replied = true,
       followup_status = 0,
       updated_at = NOW()
     WHERE phone = $1`,
    [phone],
  );
}

export async function updateLeadIaMessage(phone: string): Promise<void> {
  await query(
    `UPDATE leads SET
       last_ia_message = NOW(),
       has_lead_replied = false,
       updated_at = NOW()
     WHERE phone = $1`,
    [phone],
  );
}

export async function updateLeadName(phone: string, name: string): Promise<void> {
  await query(
    'UPDATE leads SET name = $1, updated_at = NOW() WHERE phone = $2 AND (name IS NULL OR name = \'\')',
    [name, phone],
  );
}

export async function updateLeadData(phone: string, data: Partial<Lead>): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const allowed = [
    'name', 'birth_date', 'height', 'weight', 'profession',
    'smoker', 'filhos', 'income', 'cpf', 'scheduled', 'scheduled_at',
    'status', 'rd_contact_id', 'rd_deal_id',
    'chatwoot_contact_id', 'chatwoot_conversation_id', 'last_manual_message',
  ] as const;

  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = $${idx}`);
      values.push(data[key]);
      idx++;
    }
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = NOW()`);
  values.push(phone);

  await query(
    `UPDATE leads SET ${fields.join(', ')} WHERE phone = $${idx}`,
    values,
  );
}

export async function clearLeadHistory(phone: string): Promise<void> {
  await query('DELETE FROM conversations WHERE phone = $1', [phone]);
}
