import { SCHEDULE, getAvailableSlots, formatSlotPtBr, getSaoPauloNow } from '../config/schedule';
import { listEvents } from './calendar.service';
import { isHoliday } from '../utils/holidays';
import { logger } from '../utils/logger';
import type { AvailableSlot } from './types';

export async function getNextAvailableSlots(
  period: 'manha' | 'tarde' | 'noite',
  count = 3,
): Promise<AvailableSlot[]> {
  const now = getSaoPauloNow();
  const slots: AvailableSlot[] = [];

  // Buscar eventos dos próximos 14 dias
  const endDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const events = await listEvents(now, endDate);

  // Filtrar apenas eventos confirmados (excluir cancelados e recusados)
  const confirmedEvents = events.filter((event) => {
    // Eventos com status cancelado são descartados
    if (event.status === 'cancelled') return false;
    // Manter todos os outros (confirmed, tentative, sem status)
    return true;
  });

  logger.info('Buscando slots disponíveis', {
    period,
    eventsTotal: events.length,
    eventsConfirmed: confirmedEvents.length,
  });

  // Iterar próximos 14 dias
  for (let dayOffset = 0; dayOffset <= 14 && slots.length < count; dayOffset++) {
    const date = new Date(now);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(0, 0, 0, 0);

    const dayOfWeek = date.getDay();

    // Pular sáb/dom
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    // Pular feriados nacionais
    if (await isHoliday(date)) continue;

    // Pular se não tem grade para esse dia
    if (!SCHEDULE[dayOfWeek]) continue;

    const daySlots = getAvailableSlots(dayOfWeek, period);

    for (const time of daySlots) {
      if (slots.length >= count) break;

      const [hours, minutes] = time.split(':').map(Number);
      const slotDate = new Date(date);
      slotDate.setHours(hours, minutes, 0, 0);

      // Pular slots no passado (hoje) — margem de 30 min
      if (dayOffset === 0 && slotDate.getTime() <= now.getTime() + 30 * 60 * 1000) continue;

      // Verificar se o slot está ocupado — usar timezone-aware comparison
      const slotStart = slotDate.getTime();
      const slotEnd = slotStart + 60 * 60 * 1000; // +1h

      const isOccupied = confirmedEvents.some((event) => {
        const eventStart = event.start.getTime();
        const eventEnd = event.end.getTime();
        // Overlap: evento começa antes do slot acabar E evento termina depois do slot começar
        return eventStart < slotEnd && eventEnd > slotStart;
      });

      if (isOccupied) {
        logger.debug('Slot ocupado, pulando', {
          slot: formatSlotPtBr(slotDate, time),
          conflictingEvent: confirmedEvents.find((e) =>
            e.start.getTime() < slotEnd && e.end.getTime() > slotStart,
          )?.summary,
        });
        continue;
      }

      slots.push({
        date: slotDate,
        time,
        formatted: formatSlotPtBr(slotDate, time),
      });
    }
  }

  logger.info('Slots disponíveis encontrados', {
    period,
    count: slots.length,
    slots: slots.map((s) => s.formatted),
  });

  return slots;
}
