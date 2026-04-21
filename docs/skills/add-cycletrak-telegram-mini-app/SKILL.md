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

## 3) Configure dedicated tenant runtime environment

Use a dedicated env file for the dedicated Compose service:

- `host-routed-app-stack/nanoclaw-cycletrak/.env`
- (or another path via `NANOCLAW_CYCLETRAK_DOTENV_FILE`)

Set in that tenant env file:

- `CYCLETRAK_MINI_APP_URL` (default expected URL: `https://cycletrak.anubisoft.ai/`)
- `CYCLETRAK_TELEGRAM_GROUP_CHAT_ID` (numeric Telegram supergroup id)
- Dedicated `TELEGRAM_BOT_TOKEN` for the CycleTrak BotFather bot

To get the group id:

1. Run `/chatid` in the target Telegram group.
2. Use the numeric value from `tg:<id>`.

## 4) Configure BotFather domain

Allow the same HTTPS CycleTrak domain in BotFather Mini App/Web App settings for the bot.

## 5) Bring up dedicated runtime and verify behavior

Bring up stack with the dedicated service app key included:

```bash
cd host-routed-app-stack
APPS=nextjs,cycletrak,platform,nanoclaw,nanoclaw-cycletrak,medusa ./scripts/compose-factory.sh up -d --build
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

## 7) Tenant isolation requirements

For multi-tenant separation, ensure the dedicated CycleTrak runtime uses:

- separate service (`nanoclaw_cycletrak`)
- separate Docker volumes for `store/groups/data`
- separate bot token in tenant env only

Do not share tenant state volumes with the main `nanoclaw` service.
