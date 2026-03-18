import OpenAI, { toFile } from 'openai';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;

  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY;

  if (!apiKey) {
    logger.debug('OPENAI_API_KEY not set; voice transcription disabled');
    return null;
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 *
 * Returns the transcript text, or null if transcription is unavailable
 * (no API key, API error, unsupported format, etc.).
 */
export async function transcribeFromBuffer(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  try {
    const file = await toFile(buffer, filename);

    const result = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });

    const text = (result as any).text ?? '';
    if (!text) return null;
    return text.trim();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'OpenAI transcription failed',
    );
    return null;
  }
}

