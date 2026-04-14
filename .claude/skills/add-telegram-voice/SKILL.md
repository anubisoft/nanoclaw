---
name: add-telegram-voice
description: Add voice message transcription (Whisper) and text-to-speech voice replies (OpenAI TTS) to the Telegram channel, plus a bot pool for agent teams. Requires /add-telegram first.
---

# Add Telegram Voice & Bot Pool

Adds three capabilities to the Telegram channel:

1. **Voice transcription** — inbound voice/audio messages are transcribed via OpenAI Whisper and delivered to the agent as `[Voice: <transcript>]`.
2. **TTS voice replies** — when the last inbound message was a voice note, the agent's text reply is synthesized to speech and sent back as a Telegram voice message (fallback to text on failure).
3. **Bot pool** — a set of send-only Telegram bots for agent teams (swarms). Each sub-agent is assigned a dedicated pool bot so multi-agent conversations appear as different senders in the chat.

**Prerequisite:** Telegram must be installed first (`/add-telegram`).

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f src/tts.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Configure).

### Check prerequisites

```bash
test -f src/channels/telegram.ts || { echo "Telegram not installed — run /add-telegram first"; exit 1; }
```

## Phase 2: Apply Code Changes

### New files to create

#### `src/transcription.ts`

OpenAI Whisper transcription module. Exports `transcribeFromBuffer(buffer, filename)` which returns the transcript string or `null`.

- Lazy-initializes an OpenAI client from `OPENAI_API_KEY` (via `readEnvFile` + `process.env`).
- Uses `openai.audio.transcriptions.create` with `whisper-1` model.
- Returns `null` gracefully when no API key is set or on error.

#### `src/tts.ts`

OpenAI TTS module. Exports `synthesizeSpeech(text)` which returns an MP3 `Buffer` or `null`.

- Lazy-initializes an OpenAI client from `OPENAI_API_KEY`.
- Reads the effective voice from `settings.ts` → `TTS_VOICE` env → default `'ash'`.
- Uses `openai.audio.speech.create` with `tts-1` model, MP3 format.
- Returns `null` gracefully when no API key or on error.

#### `src/settings.ts`

If not already present (may have been created by `/add-telegram-mini-app`), create the settings persistence module. See `/add-telegram-mini-app` for the full spec. If it already exists, no changes needed.

### Modifications to existing files

#### `src/channels/telegram.ts`

**Imports:** Add at top:

```typescript
import { transcribeFromBuffer } from '../transcription.js';
import { synthesizeSpeech } from '../tts.js';
```

**Voice tracking:** Add a `lastMessageWasVoice` Set to track which chats last received a voice message:

```typescript
private lastMessageWasVoice = new Set<string>();
```

Clear it in the `message:text` handler (`this.lastMessageWasVoice.delete(chatJid)`).

**Inbound voice/audio handler:** Add handlers for `message:voice` and `message:audio` that:

1. Download the file via Telegram Bot API (`getFile` → `downloadFile`).
2. Call `transcribeFromBuffer(buffer, filename)`.
3. If transcript is available, deliver as `[Voice: <transcript>]` and mark `lastMessageWasVoice.add(chatJid)`.
4. If transcription fails, deliver as `[Voice Message - transcription unavailable]`.

**Outbound sendMessage:** At the top of `sendMessage()`, check if `lastMessageWasVoice.has(jid)`. If so:

1. Delete the flag.
2. Call `synthesizeSpeech(text)`.
3. If buffer returned, send via `bot.api.sendVoice(chatId, new InputFile(buffer, 'reply.mp3'))` and return.
4. On failure, fall back to text.

**Bot pool:** Add at module scope:

```typescript
const poolApis: Api[] = [];
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;
```

Export `initBotPool(tokens: string[])` — creates Grammy `Api` instances (no polling), calls `getMe()` for validation. Export `sendPoolMessage(chatId, text, sender, groupFolder)` — round-robin assignment with `setMyName(sender)` on first use, 4096-char chunking.

#### `src/config.ts`

Add bot pool token parsing:

```typescript
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
```

#### `src/index.ts`

Import `TELEGRAM_BOT_POOL` from config, `initBotPool` from telegram channel. After channels connect:

```typescript
if (TELEGRAM_BOT_POOL.length > 0) {
  await initBotPool(TELEGRAM_BOT_POOL);
}
```

#### `src/ipc.ts`

In the IPC outbound message handler, for `tg:` JIDs, try `sendPoolMessage` first (when a sender name is available), fall back to `channel.sendMessage`.

#### `package.json`

Add dependencies:

```json
"openai": "^4.78.1",
"@elevenlabs/elevenlabs-js": "^2.30.0"
```

Note: `@elevenlabs/elevenlabs-js` is listed but currently unused — `tts.ts` uses OpenAI only. Include it if you plan ElevenLabs support later; omit it to keep deps minimal.

#### `.env.example`

Append (if not already present from `/add-voice-transcription`):

```bash
OPENAI_API_KEY=
# Optional: comma-separated Telegram bot tokens for agent team (swarm) pool.
TELEGRAM_BOT_POOL=
# Optional: OpenAI TTS voice (alloy, ash, echo, fable, onyx, nova, shimmer). Default: ash.
TTS_VOICE=
```

### Validate

```bash
pnpm install
pnpm run build
pnpm test
```

## Phase 3: Configure

### OpenAI API key

AskUserQuestion: Do you have an OpenAI API key for voice transcription and TTS?

If no, direct them to https://platform.openai.com/api-keys.

Add to `.env`:

```bash
OPENAI_API_KEY=<key>
```

### Bot pool (optional)

AskUserQuestion: Do you want to set up a Telegram bot pool for agent teams? Each sub-agent gets its own bot identity in the chat.

If yes:

1. Create additional bots via `@BotFather` (one per team role).
2. Collect their tokens.
3. Add to `.env`:

```bash
TELEGRAM_BOT_POOL=token1,token2,token3
```

### Build and restart

```bash
pnpm run build
```

## Phase 4: Verify

### Test voice transcription

Send a voice note in a registered Telegram chat. The agent should receive `[Voice: <transcript>]` and respond to the spoken content.

### Test TTS replies

After a voice note, the agent's reply should come back as a voice message (audio player in Telegram). If `OPENAI_API_KEY` is unset, replies are text only.

### Test bot pool (if configured)

Trigger an agent team task. Each sub-agent's messages should come from a different bot username in the chat.

## Troubleshooting

- **"OPENAI_API_KEY not set; voice transcription disabled"** — set the key in `.env`.
- **"OPENAI_API_KEY not set; TTS disabled"** — same key is used for both features.
- **Voice replies always fall back to text** — check logs for `OpenAI TTS failed`.
- **Bot pool bots don't send** — verify each token with `curl "https://api.telegram.org/bot<TOKEN>/getMe"`.
- **Pool bot names don't update** — `setMyName` has rate limits; Telegram may delay the change.

## Removal

1. Delete `src/transcription.ts`, `src/tts.ts`
2. Delete `src/settings.ts` (only if `/add-telegram-mini-app` is not installed)
3. Remove voice/audio handlers and `lastMessageWasVoice` logic from `src/channels/telegram.ts`
4. Remove `synthesizeSpeech` calls from `sendMessage()` in `src/channels/telegram.ts`
5. Remove bot pool code (`poolApis`, `senderBotMap`, `initBotPool`, `sendPoolMessage`) from `src/channels/telegram.ts`
6. Remove `TELEGRAM_BOT_POOL` from `src/config.ts` and `initBotPool` call from `src/index.ts`
7. Remove pool routing from `src/ipc.ts`
8. Remove `OPENAI_API_KEY`, `TELEGRAM_BOT_POOL`, `TTS_VOICE` from `.env` and `.env.example`
9. Uninstall: `pnpm remove openai @elevenlabs/elevenlabs-js`
10. Rebuild: `pnpm run build`
