import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { retry } from '../utils/retry';

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export async function analyzeImage(mediaBuffer: Buffer): Promise<string> {
  return retry(
    async () => {
      const base64 = mediaBuffer.toString('base64');
      const response = await anthropic.messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: base64,
                },
              },
              { type: 'text', text: 'Descreva esta imagem brevemente em português.' },
            ],
          },
        ],
      });
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );
      return textBlock?.text || 'Imagem recebida.';
    },
    { label: 'vision.analyze' },
  );
}
