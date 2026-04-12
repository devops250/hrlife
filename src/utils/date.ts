/**
 * Converte "DD/MM/AAAA" para "AAAA-MM-DD" (ISO 8601)
 */
export function convertBirthdayToISO(date: string): string | null {
  const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return null;
}
