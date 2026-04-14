import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
  resolveGroupMountPolicy: vi.fn((_config, isMain: boolean) => ({
    allowProjectMount: isMain,
    allowGlobalMount: false,
    allowAdditionalMounts: isMain,
    groupWorkspaceMode: 'rw',
  })),
}));

vi.mock('./docker-sibling-paths.js', () => ({
  ensureDockerSiblingPathMappings: vi.fn().mockResolvedValue(undefined),
  translatePathForDockerCliHost: (p: string, _root?: string) => p,
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  buildVolumeMounts,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from 'fs';
import {
  validateAdditionalMounts,
  resolveGroupMountPolicy,
} from './mount-security.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('buildVolumeMounts mount policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const value = String(p);
      return (
        value === '/tmp/nanoclaw-test-groups/global' ||
        value === '/workspace/project/container/skills' ||
        value === '/workspace/project/container/agent-runner/src'
      );
    });
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(resolveGroupMountPolicy).mockImplementation(
      (_config, isMain: boolean) => ({
        allowProjectMount: isMain,
        allowGlobalMount: false,
        allowAdditionalMounts: isMain,
        groupWorkspaceMode: 'rw',
      }),
    );
    vi.mocked(validateAdditionalMounts).mockReturnValue([
      {
        hostPath: '/allowed/file.txt',
        containerPath: '/workspace/extra/file.txt',
        readonly: true,
      },
    ]);
  });

  it('denies global and additional mounts by default for non-main groups', () => {
    const mounts = buildVolumeMounts(testGroup, false);
    expect(mounts.some((m) => m.containerPath === '/workspace/global')).toBe(
      false,
    );
    expect(
      mounts.some((m) => m.containerPath.startsWith('/workspace/extra/')),
    ).toBe(false);
    expect(validateAdditionalMounts).not.toHaveBeenCalled();
  });

  it('allows explicitly enabled non-main mounts via resolved policy', () => {
    vi.mocked(resolveGroupMountPolicy).mockReturnValue({
      allowProjectMount: false,
      allowGlobalMount: true,
      allowAdditionalMounts: true,
      groupWorkspaceMode: 'rw',
    });
    const mounts = buildVolumeMounts(
      {
        ...testGroup,
        containerConfig: {
          additionalMounts: [{ hostPath: '/allowed/file.txt' }],
        },
      },
      false,
    );
    expect(mounts.some((m) => m.containerPath === '/workspace/global')).toBe(
      true,
    );
    expect(
      mounts.some((m) => m.containerPath === '/workspace/extra/file.txt'),
    ).toBe(true);
    expect(validateAdditionalMounts).toHaveBeenCalled();
  });

  it('supports read-only group workspace mode', () => {
    vi.mocked(resolveGroupMountPolicy).mockReturnValue({
      allowProjectMount: false,
      allowGlobalMount: false,
      allowAdditionalMounts: false,
      groupWorkspaceMode: 'ro',
    });
    const mounts = buildVolumeMounts(testGroup, false);
    expect(
      mounts.find((m) => m.containerPath === '/workspace/group')?.readonly,
    ).toBe(true);
  });
});
