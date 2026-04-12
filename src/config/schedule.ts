export const SCHEDULE: Record<number, { manha: string[]; tarde: string[]; noite: string[] }> = {
  1: { manha: ['08:00', '09:00', '10:00'], tarde: ['14:30', '15:30'],                         noite: [] },
  2: { manha: ['08:00', '09:00', '10:00'], tarde: ['15:00', '16:00', '17:00', '18:00'],       noite: ['19:00', '20:00'] },
  3: { manha: ['08:00', '09:00', '10:00'], tarde: ['15:00', '16:00', '17:00', '18:00'],       noite: ['19:00', '20:00'] },
  4: { manha: ['08:00', '09:00', '10:00'], tarde: ['14:30', '15:30'],                         noite: [] },
  5: { manha: ['08:00', '09:00', '10:00'], tarde: ['14:30', '15:30'],                         noite: [] },
};

export function getAvailableSlots(dayOfWeek: number, period: 'manha' | 'tarde' | 'noite'): string[] {
  const daySchedule = SCHEDULE[dayOfWeek];
  if (!daySchedule) return [];
  return daySchedule[period] || [];
}

export function isValidSlot(date: Date): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const hours = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const daySchedule = SCHEDULE[day];
  if (!daySchedule) return false;
  return [...daySchedule.manha, ...daySchedule.tarde, ...daySchedule.noite].includes(hours);
}

export function isBusinessHours(date: Date = new Date()): boolean {
  const spDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hour = spDate.getHours();
  const day = spDate.getDay();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 20;
}

export function getSaoPauloNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

const WEEKDAY_NAMES: Record<number, string> = {
  0: 'Domingo',
  1: 'Segunda-feira',
  2: 'Terça-feira',
  3: 'Quarta-feira',
  4: 'Quinta-feira',
  5: 'Sexta-feira',
  6: 'Sábado',
};

export function formatSlotPtBr(date: Date, time: string): string {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const weekday = WEEKDAY_NAMES[date.getDay()];
  const hour = time.replace(':', 'h');
  return `${weekday} (${day}/${month}) às ${hour}`;
}
