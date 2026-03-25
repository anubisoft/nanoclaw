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

export interface TmaStatusPayload {
  assistantName: string;
  channels: string[];
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

  return {
    assistantName: ASSISTANT_NAME,
    channels: getRegisteredChannelNames(),
    registeredGroups,
    chats: { total: chats.length, byChannel },
    tasks: { total: tasks.length, active },
    lastGroupSync: getLastGroupSync(),
  };
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
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/status') {
      res.writeHead(req.method === 'GET' ? 404 : 405, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== expectedAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const payload = buildTmaStatusPayload();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      logger.error({ err }, 'TMA status payload error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      logger.info({ port, host }, 'TMA status server listening');
      resolve(server);
    });
    server.on('error', reject);
  });
}
