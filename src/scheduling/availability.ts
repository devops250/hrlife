import { SCHEDULE, getAvailableSlots, formatSlotPtBr, getSaoPauloNow } from '../config/schedule';
import { checkFreeBusy } from './calendar.service';
import { isHoliday } from '../utils/holidays';
import { logger } from '../utils/logger';
import type { AvailableSlot } from './types';

export async function getNextAvailableSlots(
  period: 'manha' | 'tarde' | 'noite',
  count = 3,
): Promise<AvailableSlot[]> {
  const now = getSaoPauloNow();
  const slots: AvailableSlot[] = [];

  // Buscar ocupação real dos próximos 14 dias via freeBusy
  const endDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const busyPeriods = await checkFreeBusy(now, endDate);

  logger.info('Buscando slots disponíveis via freeBusy', {
    period,
    busyPeriods: busyPeriods.length,
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

      // Pular slots no passado — margem de 30 min
      if (dayOffset === 0 && slotDate.getTime() <= now.getTime() + 30 * 60 * 1000) continue;

      // Verificar ocupação via freeBusy (fonte real de verdade)
      const slotStart = slotDate.getTime();
      const slotEnd = slotStart + 60 * 60 * 1000; // +1h

      const isOccupied = busyPeriods.some((busy) => {
        const busyStart = busy.start.getTime();
        const busyEnd = busy.end.getTime();
        return busyStart < slotEnd && busyEnd > slotStart;
      });

      if (isOccupied) {
        logger.debug('Slot ocupado (freeBusy), pulando', {
          slot: formatSlotPtBr(slotDate, time),
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
