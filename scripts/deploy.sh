#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

export PATH="/home/deploy/.nvm/versions/node/v22.22.1/bin:$PATH"

echo "==> Installing dependencies..."
npm ci

echo "==> Building TypeScript..."
npm run build

echo "==> Rebuilding agent container image..."
./container/build.sh

echo "==> Restarting NanoClaw service..."
systemctl --user restart nanoclaw

echo "==> Waiting for service to stabilize..."
sleep 5

if systemctl --user is-active --quiet nanoclaw; then
  echo "==> NanoClaw is running"
  systemctl --user status nanoclaw --no-pager
else
  echo "ERROR: NanoClaw failed to start"
  echo "==> Recent logs:"
  journalctl --user -u nanoclaw --no-pager -n 30 || true
  exit 1
fi

echo ""
echo "==> Deployment complete."
