import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

export type TtsVoice =
  | 'alloy'
  | 'ash'
  | 'echo'
  | 'fable'
  | 'onyx'
  | 'nova'
  | 'shimmer';

export interface NanoclawSettings {
  /** Global OpenAI TTS voice for Telegram voice replies. */
  ttsVoice?: TtsVoice;
}

const SETTINGS_FILE = path.join(STORE_DIR, 'settings.json');

export const ALLOWED_TTS_VOICES: readonly TtsVoice[] = [
  'alloy',
  'ash',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
] as const;

export function isTtsVoice(v: string): v is TtsVoice {
  return (ALLOWED_TTS_VOICES as readonly string[]).includes(v);
}

export function readSettings(): NanoclawSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const json = JSON.parse(raw) as unknown;
    if (json && typeof json === 'object') {
      return json as NanoclawSettings;
    }
  } catch (err) {
    // Missing file is normal on first boot.
    logger.debug({ err }, 'Settings read failed');
  }
  return {};
}

export function writeSettings(next: NanoclawSettings): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

export function setTtsVoice(voice: TtsVoice): NanoclawSettings {
  const current = readSettings();
  const next: NanoclawSettings = { ...current, ttsVoice: voice };
  writeSettings(next);
  return next;
}
