import { describe, it, expect } from 'vitest';
import { classifyBlock, splitResponse } from '../whatsapp/message-anatomy';

describe('classifyBlock', () => {
  it('curtíssima: texto de 5-25 chars', () => {
    const block = classifyBlock('Oi, tudo bem? 😊');
    expect(block.category).toBe('curtissima');
    expect(block.chars).toBeLessThanOrEqual(25);
  });

  it('curta: texto de 26-64 chars', () => {
    const block = classifyBlock('Boa tarde! Sou a Helena, da HR Life.');
    expect(block.category).toBe('curta');
    expect(block.chars).toBeGreaterThanOrEqual(26);
    expect(block.chars).toBeLessThanOrEqual(64);
  });

  it('média: texto de 65-114 chars', () => {
    const block = classifyBlock('Para prepararmos sua cotação personalizada, preciso de alguns dados. Pode me dizer seu nome completo?');
    expect(block.category).toBe('media');
    expect(block.chars).toBeGreaterThanOrEqual(65);
    expect(block.chars).toBeLessThanOrEqual(114);
  });

  it('grande: texto de 115-179 chars', () => {
    const block = classifyBlock('Perfeito, João! Vou registrar seus dados agora. Enquanto isso, quer me contar um pouco sobre sua profissão? Isso ajuda a montar a melhor proposta para você.');
    expect(block.category).toBe('grande');
    expect(block.chars).toBeGreaterThanOrEqual(115);
    expect(block.chars).toBeLessThanOrEqual(179);
  });

  it('grandíssima: texto de 180+ chars', () => {
    const block = classifyBlock('Ótimo, João! Aqui está o resumo dos seus dados:\n- Data de nascimento: 15/03/1985\n- Altura: 1,78 — Peso: 82kg\n- Profissão: Engenheiro civil\n- Renda: ~R$ 12.000\n- Fumante: Não\nTudo certo? Vamos agendar!');
    expect(block.category).toBe('grandissima');
    expect(block.chars).toBeGreaterThanOrEqual(180);
  });

  it('texto vazio retorna curtíssima com 0 chars', () => {
    const block = classifyBlock('');
    expect(block.category).toBe('curtissima');
    expect(block.chars).toBe(0);
  });

  it('preserva o texto original (trimado)', () => {
    const block = classifyBlock('  Olá!  ');
    expect(block.text).toBe('Olá!');
  });
});

describe('splitResponse', () => {
  it('texto com 3 blocos → 3 MessageBlocks', () => {
    const text = 'Oi, tudo bem? 😊\n---\nPreciso de alguns dados.\n---\nPode me dizer seu nome?';
    const blocks = splitResponse(text);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe('Oi, tudo bem? 😊');
    expect(blocks[1].text).toBe('Preciso de alguns dados.');
    expect(blocks[2].text).toBe('Pode me dizer seu nome?');
  });

  it('texto sem --- → 1 MessageBlock', () => {
    const text = 'Esta é uma mensagem simples sem delimitadores.';
    const blocks = splitResponse(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(text);
  });

  it('mais de 5 blocos → máximo 5 (últimos concatenados)', () => {
    const parts = ['Um', 'Dois', 'Três', 'Quatro', 'Cinco', 'Seis', 'Sete'];
    const text = parts.join('\n---\n');
    const blocks = splitResponse(text);
    expect(blocks).toHaveLength(5);
    expect(blocks[0].text).toBe('Um');
    expect(blocks[4].text).toBe('Cinco\nSeis\nSete');
  });

  it('blocos vazios são filtrados', () => {
    const text = 'Primeiro\n---\n\n---\nSegundo';
    const blocks = splitResponse(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Primeiro');
    expect(blocks[1].text).toBe('Segundo');
  });

  it('texto vazio retorna array vazio', () => {
    expect(splitResponse('')).toHaveLength(0);
    expect(splitResponse('   ')).toHaveLength(0);
  });

  it('cada bloco tem category e delayMs preenchidos', () => {
    const text = 'Oi!\n---\nPreciso de dados para a cotação.';
    const blocks = splitResponse(text);
    for (const block of blocks) {
      expect(block.category).toBeDefined();
      expect(block.delayMs).toBeGreaterThan(0);
      expect(block.chars).toBeGreaterThan(0);
    }
  });
});

describe('delay', () => {
  it('curtíssima: delay < 1800ms', () => {
    const block = classifyBlock('Oi! 😊');
    expect(block.delayMs).toBeLessThan(1800);
  });

  it('grandíssima: delay > 7500ms', () => {
    const block = classifyBlock('Ótimo, João! Aqui está o resumo dos seus dados:\n- Data de nascimento: 15/03/1985\n- Altura: 1,78 — Peso: 82kg\n- Profissão: Engenheiro civil\n- Renda: ~R$ 12.000\n- Fumante: Não\nTudo certo? Vamos agendar!');
    expect(block.delayMs).toBeGreaterThan(7500);
  });

  it('delay mínimo é 1000ms', () => {
    const block = classifyBlock('Oi');
    expect(block.delayMs).toBeGreaterThanOrEqual(880); // 1000 * 0.88 (jitter -12%)
  });

  it('delay máximo é 12000ms (com jitter)', () => {
    const longText = 'A'.repeat(300) + ',' .repeat(20) + '.' .repeat(20);
    const block = classifyBlock(longText);
    expect(block.delayMs).toBeLessThanOrEqual(13440); // 12000 * 1.12 (jitter +12%)
  });

  it('jitter: delay varia entre chamadas com mesmo input', () => {
    const text = 'Esta é uma mensagem média para testar variação do jitter no delay.';
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(classifyBlock(text).delayMs);
    }
    // Com jitter ±12%, 20 chamadas devem gerar pelo menos 3 valores distintos
    expect(delays.size).toBeGreaterThanOrEqual(3);
  });
});
