/**
 * Anatomia da Mensagem — estrutura, classificação e cadência de envio.
 *
 * Função pura: sem dependências externas, fácil de testar.
 * Recebe o texto bruto do LLM (com delimitadores ---) e retorna
 * blocos classificados com delay proporcional ao tamanho.
 */

export type MessageCategory = 'curtissima' | 'curta' | 'media' | 'grande' | 'grandissima';

export interface MessageBlock {
  text: string;
  chars: number;
  category: MessageCategory;
  delayMs: number;
}

const CATEGORY_RANGES: Array<{ category: MessageCategory; min: number; max: number }> = [
  { category: 'curtissima', min: 0, max: 25 },
  { category: 'curta', min: 26, max: 64 },
  { category: 'media', min: 65, max: 114 },
  { category: 'grande', min: 115, max: 179 },
  { category: 'grandissima', min: 180, max: Infinity },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function countVisible(text: string): number {
  return text.length;
}

function calculateDelay(text: string): number {
  const chars = countVisible(text);
  const virgulas = (text.match(/,/g) || []).length;
  const pontos = (text.match(/[.!?;:]/g) || []).length;
  const quebras = (text.match(/\n/g) || []).length;

  const base = 700 + (chars * 38) + (virgulas * 180) + (pontos * 280) + (quebras * 450);
  const clamped = clamp(base, 1000, 12000);

  // Jitter ±12%
  const jitter = 1 + (Math.random() * 0.24 - 0.12);
  return Math.round(clamped * jitter);
}

function categorize(chars: number): MessageCategory {
  for (const range of CATEGORY_RANGES) {
    if (chars <= range.max) return range.category;
  }
  return 'grandissima';
}

export function classifyBlock(text: string): MessageBlock {
  const trimmed = text.trim();
  const chars = countVisible(trimmed);
  return {
    text: trimmed,
    chars,
    category: categorize(chars),
    delayMs: calculateDelay(trimmed),
  };
}

export function splitResponse(text: string): MessageBlock[] {
  // Splittar por delimitador --- (com newline ao redor)
  const parts = text.split(/\n---\n/).map((p) => p.trim()).filter(Boolean);

  // Se não tem delimitador ou é bloco único, retorna como está
  if (parts.length <= 1) {
    const single = text.trim();
    return single ? [classifyBlock(single)] : [];
  }

  // Limitar a 5 blocos: juntar excedentes no último
  let blocks: string[];
  if (parts.length > 5) {
    blocks = parts.slice(0, 4);
    blocks.push(parts.slice(4).join('\n'));
  } else {
    blocks = parts;
  }

  return blocks.map(classifyBlock);
}
