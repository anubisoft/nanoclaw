import fs from 'node:fs';

import { OneCLI } from '@onecli-sh/sdk';
import OpenAI from 'openai';
import type { Fetch } from 'openai/core.js';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { ONECLI_URL } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/** Same system CA locations as @onecli-sh/sdk (Debian/Ubuntu after ca-certificates). */
const SYSTEM_CA_PATHS = [
  '/etc/ssl/cert.pem',
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
];

function buildTlsCaForGateway(gatewayCaPem: string): string {
  for (const sysPath of SYSTEM_CA_PATHS) {
    try {
      const sysCa = fs.readFileSync(sysPath, 'utf8');
      return `${sysCa.trimEnd()}\n${gatewayCaPem.trimEnd()}\n`;
    } catch {
      continue;
    }
  }
  return gatewayCaPem;
}

function directOpenAiApiKey(): string | null {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const k = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY;
  return k?.trim() ? k : null;
}

let resolved: OpenAI | null | undefined;
let inflight: Promise<OpenAI | null> | null = null;

/**
 * OpenAI client for the NanoClaw host process (Telegram Whisper/TTS, etc.).
 *
 * Resolution order:
 * 1. `OPENAI_API_KEY` in environment or `.env` — direct API calls.
 * 2. Otherwise, if `ONECLI_URL` is set, same OneCLI container config as agents:
 *    HTTPS proxy + gateway CA so api.openai.com traffic matches vault secrets.
 *
 * OneCLI uses a MITM gateway. Node only reads `NODE_EXTRA_CA_CERTS` at process
 * startup, so we cannot rely on setting it here. We use `undici` `ProxyAgent`
 * with `requestTls.ca` (system roots + gateway CA) and pass `fetch` into the
 * OpenAI SDK instead of `HttpsProxyAgent` (which does not apply `ca` to the
 * CONNECT TLS upgrade path used by node-fetch).
 */
export function getHostOpenAIClient(): Promise<OpenAI | null> {
  if (resolved !== undefined) return Promise.resolve(resolved);
  if (inflight) return inflight;

  inflight = (async () => {
    const direct = directOpenAiApiKey();
    if (direct) {
      resolved = new OpenAI({ apiKey: direct });
      inflight = null;
      return resolved;
    }

    if (!ONECLI_URL?.trim()) {
      resolved = null;
      inflight = null;
      return null;
    }

    try {
      const onecli = new OneCLI({ url: ONECLI_URL });
      const config = await onecli.getContainerConfig();
      const proxyUrl =
        config.env.HTTPS_PROXY ||
        config.env.HTTP_PROXY ||
        config.env.https_proxy ||
        config.env.http_proxy;
      if (!proxyUrl || !config.caCertificate) {
        logger.warn(
          {
            hasProxy: Boolean(proxyUrl),
            hasCa: Boolean(config.caCertificate),
          },
          'OneCLI /api/container-config returned no HTTPS_PROXY or CA; host Whisper/TTS need OPENAI_API_KEY or a working OneCLI gateway',
        );
        resolved = null;
        inflight = null;
        return null;
      }

      const caBundle = buildTlsCaForGateway(config.caCertificate);
      const dispatcher = new ProxyAgent({
        uri: proxyUrl,
        requestTls: {
          ca: caBundle,
        },
      });

      // OpenAI's client still attaches `agent` (node-fetch); undici `fetch` must not receive it.
      // Undici requires `duplex: 'half'` when `body` is set (Whisper multipart, TTS, etc.).
      const boundFetch: Fetch = ((...args: Parameters<Fetch>) => {
        const init = args[1] as Record<string, unknown> | undefined;
        const { agent: _agent, ...rest } = init ?? {};
        const out: Record<string, unknown> = { ...rest, dispatcher };
        if (out.body != null && out.duplex === undefined) {
          out.duplex = 'half';
        }
        return undiciFetch(args[0] as URL | string, out);
      }) as unknown as Fetch;

      resolved = new OpenAI({
        apiKey: 'sk-onecli-host-placeholder',
        fetch: boundFetch,
      });
      inflight = null;
      logger.debug('Host OpenAI client configured via OneCLI proxy (undici)');
      return resolved;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'OneCLI getContainerConfig failed — host Whisper/TTS cannot use the vault (check ONECLI_URL from inside the nanoclaw container and ONECLI_API_KEY if required)',
      );
      resolved = null;
      inflight = null;
      return null;
    }
  })();

  return inflight;
}

/** Call once after channels are up so operators see Whisper/TTS readiness in logs. */
export async function logHostOpenAiStatus(): Promise<void> {
  const client = await getHostOpenAIClient();
  if (client) {
    const mode = directOpenAiApiKey() ? 'OPENAI_API_KEY' : 'OneCLI_proxy';
    logger.info(
      { mode },
      'Host OpenAI ready (Telegram Whisper + voice reply TTS)',
    );
    return;
  }

  logger.warn(
    'Host OpenAI is not available: voice notes are stored as [Voice message] without a transcript, so the assistant may say transcription is broken. Fix: add OPENAI_API_KEY to nanoclaw/.env (Compose env_file), or set ONECLI_URL and an OpenAI secret in OneCLI for api.openai.com. From Docker, ONECLI_URL must reach the gateway (often http://host.docker.internal:<port> when OneCLI runs on the host). Rebuild nanoclaw after code changes.',
  );
}
