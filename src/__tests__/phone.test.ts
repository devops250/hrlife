import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../utils/phone';

describe('normalizePhone', () => {
  // Happy path — números válidos
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
    expect(normalizePhone('1198765432')).toBe('5511998765432');
  });

  it('trata número com formatação brasileira', () => {
    expect(normalizePhone('(12) 99621-7353')).toBe('5512996217353');
  });

  it('trata número com +556796278716', () => {
    expect(normalizePhone('+556796278716')).toBe('5567996278716');
  });

  it('corrige número com 0 inicial (051995318698 -> 5551995318698)', () => {
    expect(normalizePhone('051995318698')).toBe('5551995318698');
  });

  // Casos inválidos — devem retornar null
  it('retorna null para null', () => {
    expect(normalizePhone(null)).toBeNull();
  });

  it('retorna null para undefined', () => {
    expect(normalizePhone(undefined)).toBeNull();
  });

  it('retorna null para string vazia', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('retorna null para CNPJ (14 dígitos)', () => {
    expect(normalizePhone('43878392000107')).toBeNull();
  });

  it('retorna null para número muito curto (< 10 dígitos)', () => {
    expect(normalizePhone('12345')).toBeNull();
  });

  it('retorna null para lixo sem dígitos', () => {
    expect(normalizePhone('abc---')).toBeNull();
  });
});
