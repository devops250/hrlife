import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { query } from '../database/client';
import { logger } from '../utils/logger';

let dashboardHtml: string | null = null;

export function dashboardPage(_req: Request, res: Response): void {
  if (!dashboardHtml) {
    const htmlPath = path.join(__dirname, '..', '..', 'src', 'monitoring', 'dashboard.html');
    dashboardHtml = fs.readFileSync(htmlPath, 'utf-8');
  }
  res.type('html').send(dashboardHtml);
}

const VALID_PERIODS: Record<string, string> = {
  'today': "created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'",
  '7d': "created_at >= NOW() - INTERVAL '7 days'",
  '30d': "created_at >= NOW() - INTERVAL '30 days'",
};

function getPeriodFilter(period: string): string {
  return VALID_PERIODS[period] || VALID_PERIODS['7d'];
}

function _getPeriodFilter_OLD(period: string): string {
  switch (period) {
    case 'today': return "created_at >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'";
    case '30d': return "created_at >= NOW() - INTERVAL '30 days'";
    case '7d':
    default: return "created_at >= NOW() - INTERVAL '7 days'";
  }
}

export async function dashboardHandler(req: Request, res: Response): Promise<void> {
  try {
    const period = (req.query.period as string) || '7d';
    const filter = getPeriodFilter(period);

    const [totals, sources, followups, avgSchedule] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'active') as active,
          COUNT(*) FILTER (WHERE scheduled = true) as scheduled,
          COUNT(*) FILTER (WHERE status = 'exhausted') as exhausted,
          COUNT(*) FILTER (WHERE status = 'paused') as paused,
          COUNT(*) FILTER (WHERE status = 'invalid_phone') as invalid_phone
        FROM leads WHERE ${filter}
      `),
      query(`
        SELECT source, COUNT(*) as count
        FROM leads WHERE ${filter}
        GROUP BY source ORDER BY count DESC
      `),
      query(`
        SELECT COUNT(*) as total
        FROM followup_log WHERE sent_at >= NOW() - INTERVAL '${period === 'today' ? '1 day' : period === '30d' ? '30 days' : '7 days'}'
      `),
      query(`
        SELECT AVG(EXTRACT(EPOCH FROM (scheduled_at - created_at)) / 3600) as avg_hours
        FROM leads
        WHERE scheduled = true AND scheduled_at IS NOT NULL AND ${filter}
      `),
    ]);

    const t = totals.rows[0];
    const total = parseInt(t.total, 10);
    const scheduled = parseInt(t.scheduled, 10);
    const conversionRate = total > 0 ? ((scheduled / total) * 100).toFixed(1) : '0.0';

    const topSources: Record<string, number> = {};
    for (const row of sources.rows) {
      topSources[row.source] = parseInt(row.count, 10);
    }

    res.json({
      period,
      leads_total: total,
      leads_active: parseInt(t.active, 10),
      leads_scheduled: scheduled,
      leads_exhausted: parseInt(t.exhausted, 10),
      leads_paused: parseInt(t.paused, 10),
      leads_invalid_phone: parseInt(t.invalid_phone, 10),
      conversion_rate: `${conversionRate}%`,
      avg_time_to_schedule_hours: parseFloat(avgSchedule.rows[0]?.avg_hours || '0') || null,
      followups_sent: parseInt(followups.rows[0]?.total || '0', 10),
      top_sources: topSources,
    });
  } catch (error) {
    logger.error('Erro no dashboard', { error });
    res.status(500).json({ error: 'Erro ao gerar dashboard' });
  }
}
