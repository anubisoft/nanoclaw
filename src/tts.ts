import OpenAI from 'openai';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { isTtsVoice, readSettings, type TtsVoice } from './settings.js';

const DEFAULT_VOICE: TtsVoice = 'ash';

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (openaiClient) return openaiClient;

  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY;

  if (!apiKey) {
    logger.debug('OPENAI_API_KEY not set; TTS disabled');
    return null;
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

function getVoice(): TtsVoice {
  const stored = readSettings().ttsVoice;
  if (stored && isTtsVoice(stored)) return stored;

  const envVars = readEnvFile(['TTS_VOICE']);
  const raw = process.env.TTS_VOICE || envVars.TTS_VOICE || DEFAULT_VOICE;
  if (typeof raw === 'string' && isTtsVoice(raw)) return raw;

  return DEFAULT_VOICE;
}

/**
 * Convert text to speech using OpenAI TTS.
 *
 * Returns an MP3 audio buffer suitable for Telegram sendVoice,
 * or null if TTS is unavailable (no API key, error, etc.).
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.audio.speech.create({
      model: 'tts-1',
      voice: getVoice(),
      input: text,
      response_format: 'mp3',
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'OpenAI TTS failed',
    );
    return null;
  }
}
