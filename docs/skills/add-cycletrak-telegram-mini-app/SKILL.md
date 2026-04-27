---
name: add-cycletrak-telegram-mini-app
description: Feature skill spec for adding a group-scoped CycleTrak Telegram Mini App entry. Use this instead of adding the behavior directly to NanoClaw core main.
---

# Add CycleTrak Telegram Mini App

This is a **feature skill** workflow. Keep NanoClaw `main` minimal and move this capability to a skill branch.

## Goal

Enable Telegram group-specific CycleTrak Mini App behavior (`/cycletrak` command + join message) through skill code, not core source changes on `main`.

## 1) Confirm prerequisites

Confirm with the user:

- They want this as an optional feature skill.
- `origin` points to their fork and `upstream` points to `qwibitai/nanoclaw`.
- The working tree is clean before applying the skill.

## 2) Apply the feature skill branch

Use the standard branch-based skill flow:

```bash
git fetch upstream skill/cycletrak-telegram-mini-app
git merge upstream/skill/cycletrak-telegram-mini-app
```

If this skill is hosted on a different trusted remote, fetch and merge from that remote instead.

## 3) Configure runtime environment

Use the NanoClaw env file used by your Compose deployment:

- `multihost/nanoclaw/.env`
- (or another path via `NANOCLAW_DOTENV_FILE`)

Set in that tenant env file:

- `CYCLETRAK_MINI_APP_URL` (default expected URL: `https://cycletrak.anubisoft.ai/`)
- `CYCLETRAK_TELEGRAM_GROUP_CHAT_ID` (numeric Telegram supergroup id)
- `TELEGRAM_BOT_TOKEN` for the BotFather bot you want to serve this flow

To get the group id:

1. Run `/chatid` in the target Telegram group.
2. Use the numeric value from `tg:<id>`.

## 4) Configure BotFather domain

Allow the same HTTPS CycleTrak domain in BotFather Mini App/Web App settings for the bot.

## 5) Bring up runtime and verify behavior

Bring up stack with the NanoClaw app key included:

```bash
cd multihost
APPS=nextjs,cycletrak,platform,nanoclaw ./scripts/compose-factory.sh up -d --build
```

1. Restart NanoClaw.
2. Run `/cycletrak` in the configured group.
3. Verify the bot responds with an inline **Open CycleTrak** Web App button.
4. Verify the button opens `CYCLETRAK_MINI_APP_URL`.

## 6) Keep core clean

Do not add this feature directly to NanoClaw core files on `main`:

- `src/channels/telegram.ts`
- `.env.example`

This capability should remain skill-scoped and optional.

## 7) Runtime isolation note

This feature skill controls behavior by configured group/chat IDs. If you need strict tenant isolation, run separate NanoClaw deployments outside this stack.
