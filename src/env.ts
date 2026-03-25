import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    // No disk .env (typical in Docker when secrets come from Compose env_file only).
    // Still fall through so process.env merge below can populate keys.
    logger.debug(
      { err },
      '.env file not found; will use process.env for missing keys',
    );
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  // Docker Compose (and similar) inject secrets via env_file into process.env,
  // but the image often has no /app/.env on disk. Fall back so credential proxy
  // and other readers still see ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, etc.
  for (const key of keys) {
    if (!result[key] && process.env[key]) {
      result[key] = process.env[key] as string;
    }
  }

  return result;
}
