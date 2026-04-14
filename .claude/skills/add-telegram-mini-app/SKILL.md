---
name: add-telegram-mini-app
description: Add Telegram Mini App integration to NanoClaw. Exposes a bearer-authenticated HTTP status API for a TMA frontend, sets the bot's menu button to open the Mini App URL, and supports TTS voice selection via the TMA settings endpoint. Requires /add-telegram first.
---

# Add Telegram Mini App

Adds Telegram Mini App (TMA) support: a lightweight HTTP status server that a Mini App frontend can query for NanoClaw state, and wires the Telegram bot's menu button to open the Mini App URL.

**Prerequisite:** Telegram must be installed first (`/add-telegram`). This skill modifies Telegram channel files.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f src/tma-status-server.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Configure).

### Check prerequisites

Verify Telegram channel exists:

```bash
test -f src/channels/telegram.ts || { echo "Telegram not installed — run /add-telegram first"; exit 1; }
```

## Phase 2: Apply Code Changes

### New files to create

#### `src/settings.ts`

Persists user settings (currently TTS voice) to `store/settings.json`. Provides `readSettings()`, `writeSettings()`, `setTtsVoice()`, and `isTtsVoice()` helpers.

Type definition:

```typescript
export type TtsVoice = 'alloy' | 'ash' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export interface NanoclawSettings {
  ttsVoice?: TtsVoice;
}
```

Implementation: atomic JSON write (tmp + rename) to `STORE_DIR/settings.json`. `readSettings()` returns `{}` on missing file. `ALLOWED_TTS_VOICES` is the canonical voice list.

#### `src/tma-status-server.ts`

Bearer-authenticated HTTP server with two endpoints:

- **GET `/status`** — returns `TmaStatusPayload` JSON: assistant name, active channels, effective TTS voice, registered groups, chat counts by channel, task totals, last group sync timestamp.
- **POST `/settings/tts-voice`** — validates `{ "voice": "<name>" }` against `ALLOWED_TTS_VOICES`, persists via `setTtsVoice()`.

Enabled only when `NANOCLAW_TMA_STATUS_PORT` is set. Requires `NANOCLAW_TMA_STATUS_SECRET` for bearer auth. Binds to `NANOCLAW_TMA_STATUS_HOST` (default `127.0.0.1`; use `0.0.0.0` inside Docker when other Compose services need to reach it).

#### `src/tma-status-server.test.ts`

Unit tests for `buildTmaStatusPayload()` and the HTTP server (start, auth, GET /status, POST /settings/tts-voice with valid/invalid voice, 404 fallback, shutdown).

### Modifications to existing files

#### `src/channels/telegram.ts`

In the `onStart` callback (after bot connects), add Mini App menu button setup:

```typescript
const envMini = readEnvFile(['TELEGRAM_MINI_APP_URL']);
const miniAppUrl = process.env.TELEGRAM_MINI_APP_URL || envMini.TELEGRAM_MINI_APP_URL;
if (miniAppUrl) {
  try {
    await this.bot!.api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'NanoClaw',
        web_app: { url: miniAppUrl },
      },
    });
    logger.info({ url: miniAppUrl }, 'Telegram Mini App menu button set');
  } catch (err) {
    logger.warn({ err }, 'Failed to set Telegram Mini App menu button');
  }
}
```

This reads `TELEGRAM_MINI_APP_URL` from `.env` or process.env. When set, the bot's default menu button opens the Mini App. Non-fatal if it fails.

#### `src/index.ts`

Import and start the TMA server alongside the credential proxy:

```typescript
import { startTmaStatusServer } from './tma-status-server.js';
```

In the main startup sequence (after `startCredentialProxy`):

```typescript
const tmaStatusServer = await startTmaStatusServer();
```

In the shutdown handler, close the TMA server:

```typescript
tmaStatusServer?.close();
```

#### `.env.example`

Append:

```bash
# Optional: HTTPS URL of the Telegram Mini App (e.g. https://yourdomain.com/tma).
# When set, the bot sets the default menu button to open this Web App.
TELEGRAM_MINI_APP_URL=

# Optional: read-only HTTP status for the Mini App backend (Bearer secret).
# Bind 127.0.0.1 on the host; use 0.0.0.0 inside Docker when Next.js reaches this service on the compose network.
NANOCLAW_TMA_STATUS_PORT=
NANOCLAW_TMA_STATUS_SECRET=
NANOCLAW_TMA_STATUS_HOST=
```

### Validate

```bash
pnpm install
pnpm run build
pnpm test
```

## Phase 3: Configure

### Set environment variables

AskUserQuestion: Do you have a Telegram Mini App URL (HTTPS endpoint for your TMA frontend)?

If yes, collect it. If no, the menu button feature is simply inactive — no harm.

Add to `.env`:

```bash
TELEGRAM_MINI_APP_URL=<url-or-leave-blank>
NANOCLAW_TMA_STATUS_PORT=3100
NANOCLAW_TMA_STATUS_SECRET=<generate-a-random-secret>
NANOCLAW_TMA_STATUS_HOST=127.0.0.1
```

For Docker Compose deployments where other services (e.g. Next.js) query the status API on the internal network, use `NANOCLAW_TMA_STATUS_HOST=0.0.0.0`.

### Build and restart

```bash
pnpm run build
# Restart via your deployment method (Compose, launchctl, systemd, etc.)
```

## Phase 4: Verify

### Test status endpoint

```bash
curl -H "Authorization: Bearer <your-secret>" http://localhost:3100/status
```

Should return JSON with `assistantName`, `channels`, `ttsVoice`, `registeredGroups`, etc.

### Test voice settings endpoint

```bash
curl -X POST -H "Authorization: Bearer <your-secret>" \
  -H "Content-Type: application/json" \
  -d '{"voice":"nova"}' \
  http://localhost:3100/settings/tts-voice
```

Should return `{"ok":true,"voice":"nova"}`.

### Test menu button

If `TELEGRAM_MINI_APP_URL` is set, open the Telegram bot chat — the menu button should say "NanoClaw" and open the Mini App URL.

## Troubleshooting

- **Status server not starting:** Check logs for `TMA status server disabled` (port unset) or `NANOCLAW_TMA_STATUS_SECRET missing`.
- **401 from status endpoint:** Verify the Bearer token matches `NANOCLAW_TMA_STATUS_SECRET` exactly.
- **Menu button not appearing:** The URL must be HTTPS. Check bot logs for `Failed to set Telegram Mini App menu button`.

## Removal

1. Delete `src/tma-status-server.ts`, `src/tma-status-server.test.ts`, `src/settings.ts`
2. Remove `startTmaStatusServer` import and call from `src/index.ts`
3. Remove `setChatMenuButton` block from `src/channels/telegram.ts`
4. Remove `TELEGRAM_MINI_APP_URL`, `NANOCLAW_TMA_STATUS_*` from `.env` and `.env.example`
5. Rebuild: `pnpm run build`
