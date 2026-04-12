import OpenAI from 'openai';
import { env } from '../config/env';
import { retry } from '../utils/retry';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export async function transcribeAudio(mediaBuffer: Buffer): Promise<string> {
  return retry(
    async () => {
      const file = new File([new Uint8Array(mediaBuffer)], 'audio.ogg', { type: 'audio/ogg' });
      const response = await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'pt',
      });
      return response.text;
    },
    { label: 'whisper.transcribe' },
  );
}
