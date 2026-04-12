import OpenAI from 'openai';
import { retry } from '../utils/retry';

// Whisper (transcrição de áudio) permanece na OpenAI — Claude não tem equivalente
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const openai = new OpenAI({ apiKey: OPENAI_KEY });

export async function transcribeAudio(mediaBuffer: Buffer): Promise<string> {
  if (!OPENAI_KEY) {
    return '[Áudio recebido — transcrição indisponível]';
  }

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
