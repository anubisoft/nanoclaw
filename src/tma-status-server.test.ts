import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({
    'tg:1': {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2020-01-01',
      isMain: true,
    },
  })),
  getAllChats: vi.fn(() => [
    {
      jid: 'tg:1',
      name: 'Main',
      last_message_time: '2020-01-02',
      channel: 'telegram',
      is_group: 1,
    },
  ]),
  getAllTasks: vi.fn(() => [
    {
      id: 't1',
      group_folder: 'main',
      chat_jid: 'tg:1',
      prompt: 'hi',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      status: 'active',
      created_at: '2020-01-01',
    },
    {
      id: 't2',
      group_folder: 'main',
      chat_jid: 'tg:1',
      prompt: 'bye',
      schedule_type: 'cron',
      schedule_value: '0 0 * * *',
      status: 'paused',
      created_at: '2020-01-02',
    },
  ]),
  getLastGroupSync: vi.fn(() => '2020-01-03'),
}));

vi.mock('./channels/registry.js', () => ({
  getRegisteredChannelNames: vi.fn(() => ['telegram']),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestAssistant',
}));

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      resolve(addr.port);
      s.close();
    });
    s.on('error', reject);
  });
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('tma-status-server', () => {
  let port: number;
  let prevPort: string | undefined;
  let prevSecret: string | undefined;
  let prevHost: string | undefined;

  beforeEach(async () => {
    prevPort = process.env.NANOCLAW_TMA_STATUS_PORT;
    prevSecret = process.env.NANOCLAW_TMA_STATUS_SECRET;
    prevHost = process.env.NANOCLAW_TMA_STATUS_HOST;
    port = await allocatePort();
    process.env.NANOCLAW_TMA_STATUS_PORT = String(port);
    process.env.NANOCLAW_TMA_STATUS_SECRET = 'test-bearer-secret';
    delete process.env.NANOCLAW_TMA_STATUS_HOST;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevPort !== undefined) process.env.NANOCLAW_TMA_STATUS_PORT = prevPort;
    else delete process.env.NANOCLAW_TMA_STATUS_PORT;
    if (prevSecret !== undefined)
      process.env.NANOCLAW_TMA_STATUS_SECRET = prevSecret;
    else delete process.env.NANOCLAW_TMA_STATUS_SECRET;
    if (prevHost !== undefined) process.env.NANOCLAW_TMA_STATUS_HOST = prevHost;
    else delete process.env.NANOCLAW_TMA_STATUS_HOST;
  });

  it('returns null when port is unset', async () => {
    delete process.env.NANOCLAW_TMA_STATUS_PORT;
    delete process.env.NANOCLAW_TMA_STATUS_SECRET;
    vi.resetModules();
    const { startTmaStatusServer } = await import('./tma-status-server.js');
    const s = await startTmaStatusServer();
    expect(s).toBeNull();
  });

  it('GET /status with valid bearer returns JSON payload', async () => {
    const { startTmaStatusServer } = await import('./tma-status-server.js');
    const server = await startTmaStatusServer();
    expect(server).not.toBeNull();

    const res = await httpGet(port, '/status', {
      Authorization: 'Bearer test-bearer-secret',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      assistantName: string;
      channels: string[];
      registeredGroups: unknown[];
      tasks: { total: number; active: number };
    };
    expect(data.assistantName).toBe('TestAssistant');
    expect(data.channels).toEqual(['telegram']);
    expect(data.registeredGroups).toHaveLength(1);
    expect(data.tasks).toEqual({ total: 2, active: 1 });

    await new Promise<void>((r) => server!.close(() => r()));
  });

  it('rejects missing or wrong Authorization', async () => {
    const { startTmaStatusServer } = await import('./tma-status-server.js');
    const server = await startTmaStatusServer();

    const noAuth = await httpGet(port, '/status', {});
    expect(noAuth.statusCode).toBe(401);

    const badAuth = await httpGet(port, '/status', {
      Authorization: 'Bearer wrong',
    });
    expect(badAuth.statusCode).toBe(401);

    await new Promise<void>((r) => server!.close(() => r()));
  });

  it('returns 404 for unknown path', async () => {
    const { startTmaStatusServer } = await import('./tma-status-server.js');
    const server = await startTmaStatusServer();

    const res = await httpGet(port, '/nope', {
      Authorization: 'Bearer test-bearer-secret',
    });
    expect(res.statusCode).toBe(404);

    await new Promise<void>((r) => server!.close(() => r()));
  });
});
