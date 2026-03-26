/**
 * Mount Security Module for NanoClaw
 *
 * Validates additional mounts against an allowlist stored OUTSIDE the project root.
 * This prevents container agents from modifying security configuration.
 *
 * Allowlist location: ~/.config/nanoclaw/mount-allowlist.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import {
  AdditionalMount,
  AllowedRoot,
  ContainerConfig,
  GroupMountPolicy,
  MountAllowlist,
} from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Cache the allowlist in memory - only reloads on process restart
let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

/**
 * Default blocked patterns - paths that should never be mounted
 */
const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];

/**
 * Load the mount allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Result is cached in memory for the lifetime of the process.
 */
export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) {
    return cachedAllowlist;
  }

  if (allowlistLoadError !== null) {
    // Already tried and failed, don't spam logs
    return null;
  }

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      allowlistLoadError = `Mount allowlist not found at ${MOUNT_ALLOWLIST_PATH}`;
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        'Mount allowlist not found - additional mounts will be BLOCKED. ' +
          'Create the file to enable additional mounts.',
      );
      return null;
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const allowlist = JSON.parse(content) as MountAllowlist;

    // Validate structure
    if (!Array.isArray(allowlist.allowedRoots)) {
      throw new Error('allowedRoots must be an array');
    }

    if (!Array.isArray(allowlist.blockedPatterns)) {
      throw new Error('blockedPatterns must be an array');
    }

    if (typeof allowlist.nonMainReadOnly !== 'boolean') {
      throw new Error('nonMainReadOnly must be a boolean');
    }

    // Merge with default blocked patterns
    const mergedBlockedPatterns = [
      ...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns]),
    ];
    allowlist.blockedPatterns = mergedBlockedPatterns;

    cachedAllowlist = allowlist;
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded successfully',
    );

    return cachedAllowlist;
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        path: MOUNT_ALLOWLIST_PATH,
        error: allowlistLoadError,
      },
      'Failed to load mount allowlist - additional mounts will be BLOCKED',
    );
    return null;
  }
}

/**
 * Expand ~ to home directory and resolve to absolute path
 */
function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) {
    return path.join(homeDir, p.slice(2));
  }
  if (p === '~') {
    return homeDir;
  }
  return path.resolve(p);
}

/**
 * Get the real path, resolving symlinks.
 * Returns null if the path doesn't exist.
 */
function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Check if a path matches any blocked pattern
 */
function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const pathParts = realPath.split(path.sep);

  for (const pattern of blockedPatterns) {
    // Check if any path component matches the pattern
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) {
        return pattern;
      }
    }

    // Also check if the full path contains the pattern
    if (realPath.includes(pattern)) {
      return pattern;
    }
  }

  return null;
}

/**
 * Check if a real path is under an allowed root
 */
function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  let bestMatch: { root: AllowedRoot; length: number } | null = null;

  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path);
    const realRoot = getRealPath(expandedRoot);

    if (realRoot === null) {
      // Allowed root doesn't exist, skip it
      continue;
    }

    // Check if realPath is under realRoot
    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      if (bestMatch === null || realRoot.length > bestMatch.length) {
        bestMatch = { root, length: realRoot.length };
      }
    }
  }

  return bestMatch?.root ?? null;
}

/**
 * Validate the container path to prevent escaping /workspace/extra/
 */
function isValidContainerPath(containerPath: string): boolean {
  // Must not contain .. to prevent path traversal
  if (containerPath.includes('..')) {
    return false;
  }

  // Must not be absolute (it will be prefixed with /workspace/extra/)
  if (containerPath.startsWith('/')) {
    return false;
  }

  // Must not be empty
  if (!containerPath || containerPath.trim() === '') {
    return false;
  }

  return true;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

export interface ResolvedGroupMountPolicy {
  allowProjectMount: boolean;
  allowGlobalMount: boolean;
  allowAdditionalMounts: boolean;
  groupWorkspaceMode: 'rw' | 'ro';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidGroupWorkspaceMode(
  value: unknown,
): value is ResolvedGroupMountPolicy['groupWorkspaceMode'] {
  return value === 'rw' || value === 'ro';
}

function normalizeMountPolicy(
  value: unknown,
): GroupMountPolicy | undefined | null {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return null;

  const policy: GroupMountPolicy = {};

  if (
    value.allowProjectMount !== undefined &&
    typeof value.allowProjectMount !== 'boolean'
  ) {
    return null;
  }
  if (
    value.allowGlobalMount !== undefined &&
    typeof value.allowGlobalMount !== 'boolean'
  ) {
    return null;
  }
  if (
    value.allowAdditionalMounts !== undefined &&
    typeof value.allowAdditionalMounts !== 'boolean'
  ) {
    return null;
  }
  if (
    value.groupWorkspaceMode !== undefined &&
    !isValidGroupWorkspaceMode(value.groupWorkspaceMode)
  ) {
    return null;
  }

  if (value.allowProjectMount !== undefined) {
    policy.allowProjectMount = value.allowProjectMount;
  }
  if (value.allowGlobalMount !== undefined) {
    policy.allowGlobalMount = value.allowGlobalMount;
  }
  if (value.allowAdditionalMounts !== undefined) {
    policy.allowAdditionalMounts = value.allowAdditionalMounts;
  }
  if (value.groupWorkspaceMode !== undefined) {
    policy.groupWorkspaceMode = value.groupWorkspaceMode;
  }

  return policy;
}

function normalizeAdditionalMount(value: unknown): AdditionalMount | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.hostPath !== 'string' || value.hostPath.trim() === '') {
    return null;
  }
  if (
    value.containerPath !== undefined &&
    (typeof value.containerPath !== 'string' ||
      value.containerPath.trim() === '')
  ) {
    return null;
  }
  if (value.readonly !== undefined && typeof value.readonly !== 'boolean') {
    return null;
  }

  return {
    hostPath: value.hostPath,
    containerPath: value.containerPath,
    readonly: value.readonly,
  };
}

export function normalizeContainerConfig(
  value: unknown,
): ContainerConfig | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return null;

  const mountPolicy = normalizeMountPolicy(value.mountPolicy);
  if (mountPolicy === null) return null;

  let additionalMounts: AdditionalMount[] | undefined;
  if (value.additionalMounts !== undefined) {
    if (!Array.isArray(value.additionalMounts)) return null;
    additionalMounts = [];
    for (const mount of value.additionalMounts) {
      const normalized = normalizeAdditionalMount(mount);
      if (normalized === null) return null;
      additionalMounts.push(normalized);
    }
  }

  let timeout: number | undefined;
  if (value.timeout !== undefined) {
    if (
      typeof value.timeout !== 'number' ||
      !Number.isFinite(value.timeout) ||
      value.timeout <= 0
    ) {
      return null;
    }
    timeout = value.timeout;
  }

  return {
    ...(additionalMounts ? { additionalMounts } : {}),
    ...(mountPolicy ? { mountPolicy } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

export function resolveGroupMountPolicy(
  config: ContainerConfig | undefined,
  isMain: boolean,
): ResolvedGroupMountPolicy {
  const policy = config?.mountPolicy;

  return {
    allowProjectMount: isMain ? policy?.allowProjectMount !== false : false,
    allowGlobalMount: policy?.allowGlobalMount === true,
    allowAdditionalMounts: isMain
      ? policy?.allowAdditionalMounts !== false
      : policy?.allowAdditionalMounts === true,
    groupWorkspaceMode: policy?.groupWorkspaceMode ?? 'rw',
  };
}

export function validateContainerConfigForRegistration(
  config: ContainerConfig | undefined,
  isMain: boolean,
): { valid: true } | { valid: false; reason: string } {
  if (!config) return { valid: true };

  const policy = resolveGroupMountPolicy(config, isMain);

  if (!isMain && config.mountPolicy?.allowProjectMount === true) {
    return {
      valid: false,
      reason: 'Non-main groups cannot mount /workspace/project',
    };
  }

  if (
    config.additionalMounts &&
    config.additionalMounts.length > 0 &&
    !policy.allowAdditionalMounts
  ) {
    return {
      valid: false,
      reason:
        'additionalMounts requested but this group policy does not allow additional mounts',
    };
  }

  if (config.additionalMounts && config.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(
      config.additionalMounts,
      'registration',
      isMain,
      policy,
    );
    if (validated.length !== config.additionalMounts.length) {
      return {
        valid: false,
        reason:
          'One or more additionalMounts were rejected by mount policy or deployment allowlist',
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a single additional mount against the allowlist.
 * Returns validation result with reason.
 */
export function validateMount(
  mount: AdditionalMount,
  isMain: boolean,
  policy: ResolvedGroupMountPolicy = resolveGroupMountPolicy(undefined, isMain),
): MountValidationResult {
  if (!policy.allowAdditionalMounts) {
    return {
      allowed: false,
      reason: 'Group policy does not allow additional mounts',
    };
  }

  const allowlist = loadMountAllowlist();

  // If no allowlist, block all additional mounts
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  // Derive containerPath from hostPath basename if not specified
  const containerPath = mount.containerPath || path.basename(mount.hostPath);

  // Validate container path (cheap check)
  if (!isValidContainerPath(containerPath)) {
    return {
      allowed: false,
      reason: `Invalid container path: "${containerPath}" - must be relative, non-empty, and not contain ".."`,
    };
  }

  // Expand and resolve the host path
  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);

  if (realPath === null) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    };
  }

  // Check against blocked patterns
  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  // Check if under an allowed root
  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
        .map((r) => expandPath(r.path))
        .join(', ')}`,
    };
  }

  // Determine effective readonly status
  const requestedReadWrite = mount.readonly === false;
  let effectiveReadonly = true; // Default to readonly

  if (requestedReadWrite) {
    if (!isMain && allowlist.nonMainReadOnly) {
      // Non-main groups forced to read-only
      effectiveReadonly = true;
      logger.info(
        {
          mount: mount.hostPath,
        },
        'Mount forced to read-only for non-main group',
      );
    } else if (!allowedRoot.allowReadWrite) {
      // Root doesn't allow read-write
      effectiveReadonly = true;
      logger.info(
        {
          mount: mount.hostPath,
          root: allowedRoot.path,
        },
        'Mount forced to read-only - root does not allow read-write',
      );
    } else {
      // Read-write allowed
      effectiveReadonly = false;
    }
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts for a group.
 * Returns array of validated mounts (only those that passed validation).
 * Logs warnings for rejected mounts.
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean,
  policy: ResolvedGroupMountPolicy = resolveGroupMountPolicy(undefined, isMain),
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  if (!policy.allowAdditionalMounts) {
    logger.warn(
      { group: groupName },
      'Additional mounts blocked by group mount policy',
    );
    return [];
  }

  const validatedMounts: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }> = [];
  const seenContainerPaths = new Set<string>();

  for (const mount of mounts) {
    const result = validateMount(mount, isMain, policy);

    if (result.allowed) {
      const fullContainerPath = `/workspace/extra/${result.resolvedContainerPath}`;
      if (seenContainerPaths.has(fullContainerPath)) {
        logger.warn(
          {
            group: groupName,
            requestedPath: mount.hostPath,
            containerPath: result.resolvedContainerPath,
          },
          'Additional mount REJECTED due to container path collision',
        );
        continue;
      }
      seenContainerPaths.add(fullContainerPath);
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: fullContainerPath,
        readonly: result.effectiveReadonly!,
      });

      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: result.resolvedContainerPath,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated successfully',
      );
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount REJECTED',
      );
    }
  }

  return validatedMounts;
}

/**
 * Generate a template allowlist file for users to customize
 */
export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      {
        path: '~/projects',
        allowReadWrite: true,
        description: 'Development projects',
      },
      {
        path: '~/repos',
        allowReadWrite: true,
        description: 'Git repositories',
      },
      {
        path: '~/Documents/work',
        allowReadWrite: false,
        description: 'Work documents (read-only)',
      },
    ],
    blockedPatterns: [
      // Additional patterns beyond defaults
      'password',
      'secret',
      'token',
    ],
    nonMainReadOnly: true,
  };

  return JSON.stringify(template, null, 2);
}

/** @internal - test helper */
export function _resetMountAllowlistCacheForTests(): void {
  cachedAllowlist = null;
  allowlistLoadError = null;
}
