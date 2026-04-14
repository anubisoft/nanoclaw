---
name: add-compose-runtime
description: Run NanoClaw as a Docker Compose service with sibling agent containers. Adds Dockerfile.compose, nested Docker path translation, agent UID handling, env fallback for Compose-injected secrets, and Linux host-networking. Use when deploying NanoClaw inside Docker Compose rather than as a host process.
---

# Add Docker Compose Runtime

Adapts NanoClaw to run as a Docker Compose service rather than a bare-metal host process. The orchestrator container spawns sibling agent containers through a mounted Docker socket.

**Key challenges solved:**

- **Path translation:** When NanoClaw runs inside a container, `docker run -v` paths are resolved on the real host, not inside the orchestrator container. Bind mount sources must be translated from container-internal paths to host-absolute paths.
- **Agent UID:** Volume files must be owned by the agent user (uid 1000) so containers can read/write them. When the orchestrator runs as root (typical in Compose), explicit `chown` is needed.
- **Env loading:** Docker Compose injects secrets via `env_file` into `process.env`, but the orchestrator has no `.env` file on disk. The env reader must fall back to `process.env`.
- **Linux networking:** On Linux, agent containers use `--network=host` to reach the credential proxy on localhost, bypassing Docker bridge firewall rules.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f Dockerfile.compose && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Configure).

### Check Docker is available

```bash
docker info >/dev/null 2>&1 || { echo "Docker not available"; exit 1; }
```

## Phase 2: Apply Code Changes

### New files to create

#### `Dockerfile.compose`

Multi-stage build for the orchestrator container:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    docker.io \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV HUSKY=0
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY container ./container
RUN pnpm run build

CMD ["node", "dist/index.js"]
```

Key points:
- Installs `docker.io` so the orchestrator can spawn sibling containers via the mounted socket.
- Installs native build tools (`python3`, `make`, `g++`) for `better-sqlite3`.
- Copies `container/` so agent-runner source is available for per-group mounts.
- Uses pnpm with frozen lockfile.

#### `.dockerignore`

```
node_modules
dist
*.tsbuildinfo
```

#### `src/docker-sibling-paths.ts`

Translates orchestrator-internal paths to host paths for `docker run -v`. On startup, inspects the orchestrator's own container via the Docker socket API (`/containers/<id>/json`) to discover bind mount mappings. Caches the result for the process lifetime.

Exports:
- `ensureDockerSiblingPathMappings()` — call once at startup; no-op when not in a container or no Docker socket.
- `translatePathForDockerCliHost(path)` — maps an orchestrator path to the host path the Docker daemon needs.

Fallback: `NANOCLAW_DOCKER_HOST_PROJECT_ROOT` env var for cases where auto-detection fails.

#### `src/docker-sibling-paths.test.ts`

Unit tests for `translatePathForNestedDocker()` (the pure function): prefix mapping, longest-prefix-wins, no-match passthrough, env var fallback.

#### `src/agent-container-user.ts`

Agent container UID/GID resolution and ownership helpers:

- `agentContainerUidGid()` — returns `{uid, gid}` for the agent container user. Uses host UID when non-root and non-1000; otherwise defaults to `1000:1000`.
- `chownPathToAgentRecursiveIfRoot(path)` — when orchestrator is root, recursively `chown` to the agent user.
- `chownPathToAgentIfRoot(path)` — single-file `chown`.

#### `src/agent-container-user.test.ts`

Unit tests for `agentContainerUidGid()` with mocked `process.getuid()`.

#### `scripts/deploy.sh`

CI/CD deploy script: `npm ci`, `npm run build`, `./container/build.sh`, `systemctl --user restart nanoclaw`, health check.

### Modifications to existing files

#### `src/env.ts`

When `.env` file is missing (typical in Docker where secrets come from Compose `env_file` only), do not return early. Parse empty string, then fill missing keys from `process.env`:

```typescript
for (const key of keys) {
  if (!result[key] && process.env[key]) {
    result[key] = process.env[key] as string;
  }
}
```

This ensures `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and other secrets injected by Compose are visible to the credential proxy and other readers.

#### `src/env.test.ts`

Add tests covering the `process.env` fallback behavior when `.env` file is absent.

#### `src/container-runtime.ts`

**Linux host gateway:** Set `CONTAINER_HOST_GATEWAY` to `'127.0.0.1'` on Linux (containers use host networking).

**Linux networking:** `hostGatewayArgs()` returns `['--network=host']` on Linux so agent containers share the host network stack and can reach the credential proxy on localhost:3001.

**Proxy bind host:** `detectProxyBindHost()` on bare-metal Linux tries the `docker0` bridge IP, falls back to `0.0.0.0`. WSL detection uses `/proc/sys/fs/binfmt_misc/WSLInterop`. Overridable via `CREDENTIAL_PROXY_HOST` env.

#### `src/container-runner.ts`

- Import and call `ensureDockerSiblingPathMappings()` at agent spawn time.
- Wrap all `docker run -v` host paths through `translatePathForDockerCliHost()`.
- Import and call `chownPathToAgentRecursiveIfRoot()` on session dirs, IPC dirs, and agent-runner source copies.
- Use `agentContainerUidGid()` for the `--user` flag.

#### `src/group-queue.ts`

Call `chownPathToAgentIfRoot()` on IPC message files and `_close` sentinel files so the agent container can unlink them.

#### `src/credential-proxy.ts`

Add a warning log when OAuth mode is detected but no `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` is available.

### Validate

```bash
pnpm install
pnpm run build
pnpm test
```

### Build the Compose image

```bash
docker build -f Dockerfile.compose -t nanoclaw:prod .
```

## Phase 3: Configure

### Docker Compose service definition

Add a NanoClaw service to your `docker-compose.yml`:

```yaml
nanoclaw:
  build:
    context: ./nanoclaw
    dockerfile: Dockerfile.compose
  container_name: nanoclaw
  restart: unless-stopped
  env_file: ./nanoclaw/.env
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
    - nanoclaw-data:/app/data
    - nanoclaw-store:/app/store
    - nanoclaw-groups:/app/groups
    - nanoclaw-logs:/app/logs
```

Mount the Docker socket so the orchestrator can spawn sibling containers.

### Environment variables

Secrets can live in the `.env` file or be injected via Compose `env_file` / `environment` — the env reader handles both.

Optional:

```bash
# Override if auto-detection of host project root fails
NANOCLAW_DOCKER_HOST_PROJECT_ROOT=/absolute/host/path/to/nanoclaw
# Override credential proxy bind address
CREDENTIAL_PROXY_HOST=0.0.0.0
```

### Build and start

```bash
docker compose build nanoclaw
docker compose up -d nanoclaw
```

## Phase 4: Verify

### Check orchestrator logs

```bash
docker compose logs -f nanoclaw
```

Look for:
- `Sibling agent bind mounts: using host paths from Docker inspect` — path translation working.
- `Credential proxy started` — proxy reachable from agent containers.
- `Container runtime already running` — Docker socket mounted correctly.

### Test agent spawn

Send a message to trigger an agent. Verify:
- Agent container starts (visible in `docker ps`).
- Agent responds successfully.
- No permission errors in logs.

### Test path translation

If you see mount errors like "invalid mount config", check that `translatePathForDockerCliHost` is translating paths correctly. Set `LOG_LEVEL=debug` for verbose output.

## Troubleshooting

- **"Could not locate the bindings file" (better-sqlite3):** The native addon must compile inside the container. Ensure `python3`, `make`, `g++` are in the Dockerfile and `pnpm install` runs without `--ignore-scripts`.
- **Agent containers can't reach credential proxy:** On Linux, verify `--network=host` is being passed. Check `CONTAINER_HOST_GATEWAY` resolves to localhost.
- **Permission denied in agent container:** Check that `chownPathToAgentRecursiveIfRoot` is running on volume paths. The orchestrator must be root or the agent user must own the files.
- **".env file not found" warnings:** Expected in Compose — secrets come from `env_file`. The fallback to `process.env` handles this.

## Removal

1. Delete `Dockerfile.compose`, `.dockerignore`, `scripts/deploy.sh`
2. Delete `src/docker-sibling-paths.ts`, `src/docker-sibling-paths.test.ts`
3. Delete `src/agent-container-user.ts`, `src/agent-container-user.test.ts`
4. Delete `src/env.test.ts`
5. Revert `src/env.ts` to return early when `.env` is missing (remove `process.env` fallback loop)
6. Revert `src/container-runtime.ts` Linux networking changes (if reverting to macOS-only)
7. Remove `ensureDockerSiblingPathMappings`, `translatePathForDockerCliHost`, `chown*` calls from `src/container-runner.ts` and `src/group-queue.ts`
8. Remove warning log from `src/credential-proxy.ts`
9. Rebuild: `pnpm run build`
