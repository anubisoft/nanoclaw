import { APIConnectionError, APIError, toFile } from 'openai';

import { logger } from './logger.js';
import { getHostOpenAIClient } from './openai-host-client.js';

/** Whisper is picky about names; Telegram often uses `.oga` (Ogg Opus). */
function whisperUploadName(original: string): string {
  const base = original.trim() || 'voice.ogg';
  if (/\.oga$/i.test(base)) return base.replace(/\.oga$/i, '.ogg');
  return base;
}

/**
 * Transcribe an audio buffer using OpenAI Whisper.
 *
 * Returns the transcript text, or null if transcription is unavailable
 * (no API key / OneCLI proxy, API error, unsupported format, etc.).
 */
export async function transcribeFromBuffer(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const client = await getHostOpenAIClient();
  if (!client) return null;

  const uploadName = whisperUploadName(filename);

  try {
    const file = await toFile(buffer, uploadName, {
      type: 'audio/ogg',
    });

    const result = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });

    const text = (result as { text?: string }).text ?? '';
    if (!text) return null;
    return text.trim();
  } catch (err) {
    if (err instanceof APIConnectionError) {
      const cause =
        err.cause instanceof Error ? err.cause.message : String(err.cause);
      logger.error(
        { message: err.message, cause },
        'OpenAI transcription failed (connection)',
      );
    } else if (err instanceof APIError) {
      logger.error(
        {
          status: err.status,
          message: err.message,
          code: err.code,
        },
        'OpenAI transcription failed',
      );
    } else {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'OpenAI transcription failed',
      );
    }
    return null;
  }
}
