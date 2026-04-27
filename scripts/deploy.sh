#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Match self-hosted runner / scripts/setup-runner.sh
export PATH="/home/deploy/.nvm/versions/node/v22.22.1/bin:$PATH"
if command -v corepack >/dev/null 2>&1; then
  corepack enable
fi

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building TypeScript..."
pnpm run build

echo "==> Rebuilding agent container image..."
./container/build.sh

MULTIHOST_ROOT="${MULTIHOST_ROOT:-/home/deploy/platform-ops/multihost}"
if [[ ! -d "$MULTIHOST_ROOT" || ! -f "$MULTIHOST_ROOT/scripts/compose-factory.sh" ]]; then
  echo "ERROR: multihost not found at MULTIHOST_ROOT=$MULTIHOST_ROOT (clone multihost or set MULTIHOST_ROOT)." >&2
  exit 1
fi

export NANOCLAW_BUILD_CONTEXT="$(realpath "$PROJECT_DIR")"
echo "==> Redeploying NanoClaw via Docker Compose (NANOCLAW_BUILD_CONTEXT=$NANOCLAW_BUILD_CONTEXT)..."
(
  cd "$MULTIHOST_ROOT"
  export APPS="${APPS:-nanoclaw}"
  bash scripts/compose-factory.sh up -d --build nanoclaw
)

echo "==> Waiting briefly for container..."
sleep 3

if docker ps --format '{{.Names}}' | grep -qx nanoclaw; then
  echo "==> nanoclaw container is running"
  docker ps --filter name=nanoclaw --no-trunc
else
  echo "ERROR: nanoclaw container not in docker ps"
  docker ps -a --filter name=nanoclaw || true
  exit 1
fi

echo ""
echo "==> Deployment complete."
