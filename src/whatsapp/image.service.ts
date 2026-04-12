import OpenAI from 'openai';
import { env } from '../config/env';
import { retry } from '../utils/retry';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function analyzeImage(mediaBuffer: Buffer): Promise<string> {
  return retry(
    async () => {
      const base64 = mediaBuffer.toString('base64');
      const response = await openai.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Descreva esta imagem brevemente em português.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 300,
      });
      return response.choices[0]?.message?.content || 'Imagem recebida.';
    },
    { label: 'vision.analyze' },
  );
}
