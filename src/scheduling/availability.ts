import { SCHEDULE, getAvailableSlots, formatSlotPtBr, getSaoPauloNow } from '../config/schedule';
import { checkFreeBusy } from './calendar.service';
import { isHoliday } from '../utils/holidays';
import { logger } from '../utils/logger';
import type { AvailableSlot } from './types';

const pad2 = (n: number) => String(n).padStart(2, '0');

export async function getNextAvailableSlots(
  period: 'manha' | 'tarde' | 'noite',
  count = 3,
): Promise<AvailableSlot[]> {
  // getSaoPauloNow retorna Date com horário SP "como se fosse UTC" — correto para:
  //   - getDay(), getDate(), getHours() → dia/hora em São Paulo
  //   - comparação past-check (slotDate vs now) — ambos no mesmo referencial
  const now = getSaoPauloNow();
  const slots: AvailableSlot[] = [];

  // freeBusy: usar UTC real para query e comparação
  const realNow = new Date();
  const endDate = new Date(realNow.getTime() + 14 * 24 * 60 * 60 * 1000);
  const busyPeriods = await checkFreeBusy(realNow, endDate);

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

    // Montar data ISO do dia para conversão BRT→UTC
    const dateIso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

    for (const time of daySlots) {
      if (slots.length >= count) break;

      const [hours, minutes] = time.split(':').map(Number);
      const slotDate = new Date(date);
      slotDate.setHours(hours, minutes, 0, 0);

      // Pular slots no passado — margem de 30 min (ambos em referencial SP)
      if (dayOffset === 0 && slotDate.getTime() <= now.getTime() + 30 * 60 * 1000) continue;

      // FIX: converter horário BRT para UTC real antes de comparar com freeBusy
      // "20:00 BRT" = "20:00-03:00" = 23:00 UTC
      const slotStartUtc = new Date(`${dateIso}T${time}:00-03:00`).getTime();
      const slotEndUtc = slotStartUtc + 60 * 60 * 1000;

      const isOccupied = busyPeriods.some((busy) => {
        const busyStart = busy.start.getTime();
        const busyEnd = busy.end.getTime();
        return busyStart < slotEndUtc && busyEnd > slotStartUtc;
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
