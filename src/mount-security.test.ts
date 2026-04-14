import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  ALLOWLIST_PATH,
  state,
}: {
  ALLOWLIST_PATH: string;
  state: {
    allowlistExists: boolean;
    allowlistJson: string;
    realPaths: Map<string, string>;
  };
} = vi.hoisted(() => ({
  ALLOWLIST_PATH: '/tmp/nanoclaw/mount-allowlist.json',
  state: {
    allowlistExists: true,
    allowlistJson: JSON.stringify({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    }),
    realPaths: new Map<string, string>(),
  },
}));

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: ALLOWLIST_PATH,
}));

vi.mock('pino', () => ({
  default: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: import('fs').PathLike) =>
        String(p) === ALLOWLIST_PATH
          ? state.allowlistExists
          : state.realPaths.has(String(p)),
      ),
      readFileSync: vi.fn((p: import('fs').PathLike) => {
        if (String(p) === ALLOWLIST_PATH) return state.allowlistJson;
        return '';
      }),
      realpathSync: vi.fn((p: import('fs').PathLike) => {
        const key = String(p);
        const resolved = state.realPaths.get(key);
        if (!resolved) throw new Error(`ENOENT: ${key}`);
        return resolved;
      }),
    },
  };
});

import {
  _resetMountAllowlistCacheForTests,
  normalizeContainerConfig,
  resolveGroupMountPolicy,
  validateAdditionalMounts,
  validateContainerConfigForRegistration,
  validateMount,
} from './mount-security.js';

describe('mount-security mount policy', () => {
  beforeEach(() => {
    state.allowlistExists = true;
    state.allowlistJson = JSON.stringify({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    state.realPaths.clear();
    _resetMountAllowlistCacheForTests();
  });

  it('normalizes container config with mount policy', () => {
    const result = normalizeContainerConfig({
      timeout: 1234,
      mountPolicy: {
        allowGlobalMount: true,
        groupWorkspaceMode: 'ro',
      },
    });

    expect(result).toEqual({
      timeout: 1234,
      mountPolicy: {
        allowGlobalMount: true,
        groupWorkspaceMode: 'ro',
      },
    });
  });

  it('resolves conservative defaults for non-main groups', () => {
    expect(resolveGroupMountPolicy(undefined, false)).toEqual({
      allowProjectMount: false,
      allowGlobalMount: false,
      allowAdditionalMounts: false,
      groupWorkspaceMode: 'rw',
    });
  });

  it('rejects non-main project mount requests at registration time', () => {
    const result = validateContainerConfigForRegistration(
      {
        mountPolicy: { allowProjectMount: true },
      },
      false,
    );

    expect(result.valid).toBe(false);
  });

  it('uses the longest matching allowed root when evaluating read-write mounts', () => {
    state.allowlistJson = JSON.stringify({
      allowedRoots: [
        { path: '/srv', allowReadWrite: false },
        { path: '/srv/private', allowReadWrite: true },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    state.realPaths.set('/srv', '/srv');
    state.realPaths.set('/srv/private', '/srv/private');
    state.realPaths.set('/srv/private/data', '/srv/private/data');

    const result = validateMount(
      {
        hostPath: '/srv/private/data',
        readonly: false,
      },
      true,
      {
        allowProjectMount: true,
        allowGlobalMount: false,
        allowAdditionalMounts: true,
        groupWorkspaceMode: 'rw',
      },
    );

    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('rejects duplicate /workspace/extra destinations', () => {
    state.allowlistJson = JSON.stringify({
      allowedRoots: [{ path: '/allowed', allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    state.realPaths.set('/allowed', '/allowed');
    state.realPaths.set('/allowed/file-a', '/allowed/file-a');
    state.realPaths.set('/allowed/file-b', '/allowed/file-b');

    const result = validateAdditionalMounts(
      [
        { hostPath: '/allowed/file-a', containerPath: 'same' },
        { hostPath: '/allowed/file-b', containerPath: 'same' },
      ],
      'test-group',
      true,
      {
        allowProjectMount: true,
        allowGlobalMount: false,
        allowAdditionalMounts: true,
        groupWorkspaceMode: 'rw',
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/same');
  });

  it('rejects additional mounts at registration time when policy disallows them', () => {
    const result = validateContainerConfigForRegistration(
      {
        additionalMounts: [{ hostPath: '/allowed/file-a' }],
      },
      false,
    );

    expect(result.valid).toBe(false);
  });
});
