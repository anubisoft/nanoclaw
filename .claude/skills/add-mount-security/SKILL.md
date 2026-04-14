---
name: add-mount-security
description: Add per-group mount policies and an external allowlist for additional container mounts. Enforces which groups can access project files, global memory, and extra host directories. Prevents agents from escalating their own mount privileges.
---

# Add Mount Security

Hardens NanoClaw's container mount system with per-group policies and a tamper-proof external allowlist. Without this skill, all groups share the same mount behavior. With it, each group's access is individually controlled.

**What this adds:**

- **Per-group mount policies** — control whether a group gets project mounts, global memory, or extra host directories.
- **External allowlist** — stored at `~/.config/nanoclaw/mount-allowlist.json`, outside the project tree, so container agents cannot modify their own security configuration.
- **Blocked patterns** — default list of sensitive paths (`.ssh`, `.gnupg`, `.aws`, `.env`, private keys, etc.) that can never be mounted.
- **Read-only enforcement** — non-main groups can be forced to read-only regardless of config.
- **Registration validation** — rejects group registrations that request mounts they're not allowed.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "GroupMountPolicy" src/types.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Configure).

## Phase 2: Apply Code Changes

### Modifications to `src/types.ts`

Add the `GroupMountPolicy` interface and `mountPolicy` field:

```typescript
export interface GroupMountPolicy {
  allowProjectMount?: boolean;
  allowGlobalMount?: boolean;
  allowAdditionalMounts?: boolean;
  groupWorkspaceMode?: 'rw' | 'ro';
}
```

Add `mountPolicy?: GroupMountPolicy` to `ContainerConfig`.

The existing `MountAllowlist`, `AllowedRoot`, and `AdditionalMount` interfaces are already upstream. Verify they exist and match.

### New test file: `src/mount-security.test.ts`

Tests for mount policy normalization, resolution, validation, blocked patterns, and registration rejection.

### Modifications to `src/mount-security.ts`

The upstream `mount-security.ts` already has allowlist loading, blocked-pattern checking, and mount validation. The fork extends it with:

#### Policy normalization and resolution

Add `normalizeContainerConfig(value)` — deeply validates and normalizes a `ContainerConfig` from untrusted input (e.g., IPC registration). Rejects invalid types, normalizes mount policy fields, validates additional mount entries.

Add `normalizeMountPolicy(value)` — validates individual mount policy fields (`allowProjectMount`, `allowGlobalMount`, `allowAdditionalMounts`, `groupWorkspaceMode`). Returns `null` for invalid input.

Add `resolveGroupMountPolicy(config, isMain)` — resolves effective policy from config + `isMain` flag:

- **Main groups:** project mount and additional mounts are allowed unless explicitly disabled.
- **Non-main groups:** project mount is denied; global and additional mounts require explicit opt-in.
- `groupWorkspaceMode` defaults to `'rw'`.

#### Registration validation

Add `validateContainerConfigForRegistration(config, isMain)` — called during IPC group registration. Rejects:

- Non-main groups requesting `allowProjectMount: true`
- Groups requesting `additionalMounts` when policy disallows them
- Individual mounts that fail allowlist validation

### Modifications to `src/container-runner.ts`

In `buildVolumeMounts()`, use `resolveGroupMountPolicy()` to determine which mounts to include:

- Project mount: only when `allowProjectMount` is true (main groups by default).
- Global mount: only when `allowGlobalMount` is true.
- Additional mounts: validated against the allowlist when `allowAdditionalMounts` is true.
- Group workspace: respects `groupWorkspaceMode` for read/write vs read-only.

### Modifications to `src/db.ts`

When reading/writing `containerConfig` from SQLite, apply `normalizeContainerConfig()` to validate stored data. Reject corrupted configs gracefully.

### Modifications to `src/ipc.ts`

In the `register_group` IPC handler, apply `normalizeContainerConfig()` and `validateContainerConfigForRegistration()` before persisting. Reject registrations with invalid or disallowed mount configurations.

### Validate

```bash
pnpm install
pnpm run build
pnpm test
```

## Phase 3: Configure

### Create the mount allowlist

The allowlist lives at `~/.config/nanoclaw/mount-allowlist.json` — outside the project tree so container agents cannot modify it.

```bash
mkdir -p ~/.config/nanoclaw
```

AskUserQuestion: Which directories should agents be able to mount? Common choices: ~/projects, ~/repos, ~/Documents. Which should be read-write vs read-only?

Create the allowlist based on user input:

```json
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/Documents",
      "allowReadWrite": false,
      "description": "Documents (read-only)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

`blockedPatterns` here is for additional patterns beyond the built-in defaults (`.ssh`, `.gnupg`, `.aws`, `.env`, private keys, etc.).

`nonMainReadOnly: true` forces all non-main group mounts to read-only regardless of individual config.

### Configure group policies (optional)

Groups registered via IPC can include a `containerConfig.mountPolicy` object:

```json
{
  "mountPolicy": {
    "allowProjectMount": false,
    "allowGlobalMount": true,
    "allowAdditionalMounts": false,
    "groupWorkspaceMode": "rw"
  }
}
```

The main group defaults to permissive; non-main groups default to restrictive. Override per-group as needed.

### Build and restart

```bash
pnpm run build
```

## Phase 4: Verify

### Test mount policy resolution

From the main group, register a group with additional mounts and verify they appear in the agent container.

### Test non-main restrictions

Register a non-main group with `allowProjectMount: true` — the registration should be rejected.

### Test blocked patterns

Try to mount a path containing `.ssh` or `.env` — should be blocked regardless of allowlist.

### Test read-only enforcement

With `nonMainReadOnly: true`, verify non-main group mounts are always read-only even if `readonly: false` is requested.

## Security Model

- **Defense in depth:** Mount security has three layers — group policy, external allowlist, and blocked patterns. All three must pass.
- **Tamper-proof:** The allowlist is stored outside the project root (`~/.config/nanoclaw/`) so container agents cannot modify it.
- **Default deny:** Without an allowlist file, all additional mounts are blocked.
- **Blocked by default:** Sensitive paths (`.ssh`, `.gnupg`, `.aws`, private keys, etc.) are always blocked.
- **Non-main isolation:** Non-main groups cannot mount the project tree and can be forced to read-only.

## Troubleshooting

- **"Mount allowlist not found"** — create `~/.config/nanoclaw/mount-allowlist.json`.
- **"additionalMounts requested but this group policy does not allow additional mounts"** — the group's `mountPolicy.allowAdditionalMounts` is not `true`.
- **"Path is not under any allowed root"** — add the parent directory to `allowedRoots` in the allowlist.
- **"Path matches blocked pattern"** — the path contains a sensitive component. This cannot be overridden.
- **"Non-main groups cannot mount /workspace/project"** — by design; only the main group gets project access.

## Removal

1. Remove `GroupMountPolicy` from `src/types.ts` and `mountPolicy` field from `ContainerConfig`
2. Revert `src/mount-security.ts` to remove `normalizeContainerConfig`, `normalizeMountPolicy`, `resolveGroupMountPolicy`, `validateContainerConfigForRegistration`
3. Delete `src/mount-security.test.ts`
4. Revert `src/container-runner.ts` to unconditional mount behavior
5. Revert `src/db.ts` to skip `normalizeContainerConfig` on read/write
6. Revert `src/ipc.ts` to skip registration validation
7. Optionally delete `~/.config/nanoclaw/mount-allowlist.json`
8. Rebuild: `pnpm run build`
