import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';

import { ASSISTANT_NAME } from './config.js';
import { getRegisteredChannelNames } from './channels/registry.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getLastGroupSync,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  ALLOWED_TTS_VOICES,
  isTtsVoice,
  readSettings,
  setTtsVoice,
} from './settings.js';

export interface TmaStatusPayload {
  assistantName: string;
  channels: string[];
  ttsVoice: string;
  registeredGroups: Array<{
    jid: string;
    name: string;
    folder: string;
    isMain: boolean;
  }>;
  chats: { total: number; byChannel: Record<string, number> };
  tasks: { total: number; active: number };
  lastGroupSync: string | null;
}

export function buildTmaStatusPayload(): TmaStatusPayload {
  const groupsMap = getAllRegisteredGroups();
  const registeredGroups = Object.entries(groupsMap).map(([jid, g]) => ({
    jid,
    name: g.name,
    folder: g.folder,
    isMain: g.isMain === true,
  }));

  const chats = getAllChats().filter((c) => c.jid !== '__group_sync__');
  const byChannel: Record<string, number> = {};
  for (const c of chats) {
    const ch = c.channel || 'unknown';
    byChannel[ch] = (byChannel[ch] || 0) + 1;
  }

  const tasks = getAllTasks();
  const active = tasks.filter((t) => t.status === 'active').length;

  const storedVoice = readSettings().ttsVoice;
  const envVoice = process.env.TTS_VOICE;
  const ttsVoice =
    (storedVoice && isTtsVoice(storedVoice) && storedVoice) ||
    (envVoice && isTtsVoice(envVoice) && envVoice) ||
    'ash';

  return {
    assistantName: ASSISTANT_NAME,
    channels: getRegisteredChannelNames(),
    ttsVoice,
    registeredGroups,
    chats: { total: chats.length, byChannel },
    tasks: { total: tasks.length, active },
    lastGroupSync: getLastGroupSync(),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function tmaStatusEnv(): { portStr?: string; secret?: string; host: string } {
  const fromFile = readEnvFile([
    'NANOCLAW_TMA_STATUS_PORT',
    'NANOCLAW_TMA_STATUS_SECRET',
    'NANOCLAW_TMA_STATUS_HOST',
  ]);
  const portStr =
    process.env.NANOCLAW_TMA_STATUS_PORT || fromFile.NANOCLAW_TMA_STATUS_PORT;
  const secret =
    process.env.NANOCLAW_TMA_STATUS_SECRET ||
    fromFile.NANOCLAW_TMA_STATUS_SECRET;
  const host =
    process.env.NANOCLAW_TMA_STATUS_HOST ||
    fromFile.NANOCLAW_TMA_STATUS_HOST ||
    '127.0.0.1';
  return { portStr, secret, host };
}

export function startTmaStatusServer(): Promise<Server | null> {
  const { portStr, secret, host } = tmaStatusEnv();
  if (!portStr) {
    logger.info('TMA status server disabled (NANOCLAW_TMA_STATUS_PORT unset)');
    return Promise.resolve(null);
  }
  if (!secret) {
    logger.warn(
      'NANOCLAW_TMA_STATUS_PORT set but NANOCLAW_TMA_STATUS_SECRET missing — TMA status server not started',
    );
    return Promise.resolve(null);
  }
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 1) {
    logger.warn({ portStr }, 'Invalid NANOCLAW_TMA_STATUS_PORT');
    return Promise.resolve(null);
  }

  const expectedAuth = `Bearer ${secret}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url?.split('?')[0] || '';
    const auth = req.headers.authorization;
    if (auth !== expectedAuth) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      try {
        const payload = buildTmaStatusPayload();
        sendJson(res, 200, payload);
      } catch (err) {
        logger.error({ err }, 'TMA status payload error');
        sendJson(res, 500, { error: 'internal_error' });
      }
      return;
    }

    if (req.method === 'POST' && path === '/settings/tts-voice') {
      void (async () => {
        try {
          const body = await readJsonBody(req);
          const voice =
            body && typeof body === 'object' && 'voice' in body
              ? (body as { voice?: unknown }).voice
              : undefined;
          if (typeof voice !== 'string' || !isTtsVoice(voice)) {
            sendJson(res, 400, {
              error: 'invalid_voice',
              allowed: ALLOWED_TTS_VOICES,
            });
            return;
          }
          setTtsVoice(voice);
          sendJson(res, 200, { ok: true, voice });
        } catch (err) {
          logger.error({ err }, 'TMA set ttsVoice error');
          sendJson(res, 400, { error: 'invalid_json' });
        }
      })();
      return;
    }

    sendJson(res, req.method === 'GET' ? 404 : 405, { error: 'not_found' });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      logger.info({ port, host }, 'TMA status server listening');
      resolve(server);
    });
    server.on('error', reject);
  });
}
