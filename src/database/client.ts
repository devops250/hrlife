import { Pool, QueryResult } from 'pg';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function query(sql: string, params?: unknown[]): Promise<QueryResult> {
  return pool.query(sql, params);
}

export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch (error) {
    logger.error('Falha na conexão com PostgreSQL', { error });
    return false;
  }
}
