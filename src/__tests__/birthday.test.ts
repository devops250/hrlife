import { describe, it, expect } from 'vitest';
import { convertBirthdayToISO } from '../utils/date';

describe('convertBirthdayToISO', () => {
  it('converte DD/MM/AAAA para AAAA-MM-DD', () => {
    expect(convertBirthdayToISO('15/03/1985')).toBe('1985-03-15');
  });

  it('converte 01/01/2000', () => {
    expect(convertBirthdayToISO('01/01/2000')).toBe('2000-01-01');
  });

  it('converte 31/12/1990', () => {
    expect(convertBirthdayToISO('31/12/1990')).toBe('1990-12-31');
  });

  it('retorna null para formato inválido', () => {
    expect(convertBirthdayToISO('invalid')).toBeNull();
  });

  it('retorna null para formato americano MM/DD/YYYY', () => {
    expect(convertBirthdayToISO('1985-03-15')).toBeNull();
  });

  it('retorna null para string vazia', () => {
    expect(convertBirthdayToISO('')).toBeNull();
  });
});
