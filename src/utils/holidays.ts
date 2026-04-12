import { logger } from './logger';

let holidaysCache: Map<string, Set<string>> = new Map();

/**
 * Busca feriados nacionais do ano via BrasilAPI.
 * Cacheia por ano para não fazer múltiplas requests no mesmo dia.
 */
async function fetchHolidays(year: number): Promise<Set<string>> {
  const cacheKey = String(year);
  if (holidaysCache.has(cacheKey)) return holidaysCache.get(cacheKey)!;

  try {
    const res = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, {
      headers: { 'User-Agent': 'HRLife-SDR/1.0' },
    });
    if (!res.ok) {
      logger.warn('BrasilAPI feriados falhou, ignorando', { status: res.status });
      return new Set();
    }
    const data = await res.json() as Array<{ date: string; name: string }>;
    const dates = new Set(data.map((h) => h.date)); // formato YYYY-MM-DD
    holidaysCache.set(cacheKey, dates);
    logger.info('Feriados carregados', { year, count: dates.size });
    return dates;
  } catch (error) {
    logger.warn('Erro ao buscar feriados, ignorando', { error });
    return new Set();
  }
}

/**
 * Verifica se uma data é feriado nacional.
 */
export async function isHoliday(date: Date): Promise<boolean> {
  const year = date.getFullYear();
  const holidays = await fetchHolidays(year);
  const dateStr = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return holidays.has(dateStr);
}
