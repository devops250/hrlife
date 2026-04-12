import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../utils/phone';

describe('normalizePhone', () => {
  it('retorna 13 dígitos quando já está completo', () => {
    expect(normalizePhone('5512996217353')).toBe('5512996217353');
  });

  it('normaliza com +55 e espaços', () => {
    expect(normalizePhone('+55 12 99621-7353')).toBe('5512996217353');
  });

  it('adiciona 55 quando tem 11 dígitos (DDD + 9 dígitos)', () => {
    expect(normalizePhone('11987654321')).toBe('5511987654321');
  });

  it('adiciona 55 e 9 quando tem 10 dígitos (DDD + 8 dígitos)', () => {
    expect(normalizePhone('1198765432')).toBe('55119987654320'.slice(0, 13));
  });

  it('trata número com formatação brasileira', () => {
    expect(normalizePhone('(12) 99621-7353')).toBe('5512996217353');
  });

  it('trata número com +556796278716', () => {
    expect(normalizePhone('+556796278716')).toBe('5567996278716');
  });
});
