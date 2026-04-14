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
 * Some gateways return HTTP/HTML error bodies with a 200-style Whisper-shaped payload,
 * or the API echoes a short auth string in `text`. Treat those as failed transcription
 * so we do not feed the assistant fake "user speech" or TTS it back on Telegram.
 */
export function isLikelyNonSpeechTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const lower = t.toLowerCase().replace(/\.+$/, '').trim();
  const exact = new Set([
    'not logged in',
    'please log in',
    'log in to continue',
    'login required',
    'sign in required',
    'you must log in',
    'invalid api key',
    'authentication failed',
    'access denied',
  ]);
  if (exact.has(lower)) return true;
  // Short blobs that start like a login interstitial (not normal dictation).
  if (t.length <= 160) {
    if (lower.startsWith('not logged in')) return true;
    if (lower.startsWith('please log in')) return true;
    if (lower.startsWith('you must log in')) return true;
  }
  return false;
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
    const trimmed = text.trim();
    if (isLikelyNonSpeechTranscript(trimmed)) {
      logger.warn(
        { preview: trimmed.slice(0, 200) },
        'Whisper transcript rejected (proxy/auth noise, not speech)',
      );
      return null;
    }
    return trimmed;
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
