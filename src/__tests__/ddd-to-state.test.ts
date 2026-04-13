import { describe, it, expect } from 'vitest';
import { extractStateFromPhone } from '../utils/ddd-to-state';

describe('extractStateFromPhone', () => {
  it('DDD 11 -> SP', () => expect(extractStateFromPhone('5511987654321')).toBe('SP'));
  it('DDD 21 -> RJ', () => expect(extractStateFromPhone('5521987654321')).toBe('RJ'));
  it('DDD 31 -> MG', () => expect(extractStateFromPhone('5531987654321')).toBe('MG'));
  it('DDD 41 -> PR', () => expect(extractStateFromPhone('5541987654321')).toBe('PR'));
  it('DDD 47 -> SC', () => expect(extractStateFromPhone('5547987654321')).toBe('SC'));
  it('DDD 51 -> RS', () => expect(extractStateFromPhone('5551987654321')).toBe('RS'));
  it('DDD 61 -> DF', () => expect(extractStateFromPhone('5561987654321')).toBe('DF'));
  it('DDD 71 -> BA', () => expect(extractStateFromPhone('5571987654321')).toBe('BA'));
  it('DDD 85 -> CE', () => expect(extractStateFromPhone('5585987654321')).toBe('CE'));
  it('DDD 91 -> PA', () => expect(extractStateFromPhone('5591987654321')).toBe('PA'));
  it('DDD inválido (00) -> null', () => expect(extractStateFromPhone('5500987654321')).toBeNull());
  it('phone null -> null', () => expect(extractStateFromPhone(null)).toBeNull());
  it('phone sem prefixo 55 -> null', () => expect(extractStateFromPhone('11987654321')).toBeNull());
  it('phone curto demais -> null', () => expect(extractStateFromPhone('551198765')).toBeNull());
});
