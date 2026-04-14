---
name: add-fork-sync
description: Add automated upstream sync and CI/CD workflows for a NanoClaw fork. Keeps the fork's main branch up to date with qwibitai/nanoclaw, merge-forwards skill branches, and deploys on push to main via a self-hosted runner.
---

# Add Fork Sync & Deploy CI

Adds GitHub Actions workflows for maintaining a NanoClaw fork:

1. **Upstream sync** — automatically merges `qwibitai/nanoclaw` main into the fork's main, validates build + tests, and merge-forwards skill branches.
2. **Deploy** — runs CI checks and deploys to a self-hosted runner on push to main.

These workflows are fork-specific — they only run when `github.repository != 'qwibitai/nanoclaw'`.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f .github/workflows/fork-sync-skills.yml && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Configure).

## Phase 2: Apply Code Changes

### New files to create

#### `.github/workflows/fork-sync-skills.yml`

Upstream sync + skill branch merge-forward workflow. Triggers:

- `repository_dispatch` event `upstream-main-updated` (sent by upstream's merge-forward workflow to notify forks).
- Schedule: every 6 hours (fallback if dispatch isn't configured).
- Push to `main` (catches direct pushes).
- Manual `workflow_dispatch`.

Guard: `if: github.repository != 'qwibitai/nanoclaw'` — never runs on the upstream repo.

**Job: `sync-and-merge`**

Steps:
1. Create GitHub App token (requires `APP_ID` and `APP_PRIVATE_KEY` secrets — allows pushing to protected branches).
2. Checkout with full history (`fetch-depth: 0`).
3. **Sync with upstream main:**
   - `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
   - `git fetch upstream main`
   - Skip if already up to date (`git merge-base --is-ancestor upstream/main HEAD`).
   - Merge `upstream/main` — if conflicts, abort and flag `sync_failed`.
   - Run `pnpm install && pnpm run build && pnpm test` — if build/tests fail, reset and flag `sync_failed`.
   - Push to `origin main`.
4. **Merge main into skill branches:**
   - For each `origin/skill/*` branch: checkout, merge `main`, validate build + tests, push.
   - Failed branches are collected for issue creation.
5. **On failure:** open a GitHub issue with resolution instructions (label: `upstream-sync` or `skill-maintenance`).

#### `.github/workflows/deploy.yml`

CI + deploy workflow for the fork. Triggers on push to `main` when `src/`, `container/`, or `package*.json` change. Also supports `workflow_dispatch`.

**Job: `deploy`**

Runs on `[self-hosted, linux, production]` runner. Steps:
1. Checkout.
2. Setup Node.js 20.
3. `pnpm install` (or `npm ci`).
4. Format check, typecheck, tests.
5. Run `scripts/deploy.sh` (build TypeScript, rebuild container image, restart service).
6. On failure: show recent journal logs.

#### `scripts/deploy.sh`

Deployment script called by the CI workflow:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(dirname "$0")")"

pnpm install --frozen-lockfile
pnpm run build
./container/build.sh
systemctl --user restart nanoclaw
sleep 5
systemctl --user is-active --quiet nanoclaw || { journalctl --user -u nanoclaw -n 30; exit 1; }
```

### Validate

Verify the workflow YAML is valid:

```bash
# Quick syntax check
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/fork-sync-skills.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"
```

## Phase 3: Configure

### GitHub App for sync workflow

The sync workflow needs a GitHub App token to push to protected branches. 

AskUserQuestion: Do you have a GitHub App configured for this repo with contents:write permission?

If no:

1. Go to GitHub Settings > Developer Settings > GitHub Apps > New GitHub App.
2. Give it a name (e.g., "NanoClaw Fork Sync").
3. Permissions: Repository > Contents: Read & Write.
4. Install it on the fork repository.
5. Note the App ID and generate a private key.
6. Add secrets to the repo: `APP_ID` and `APP_PRIVATE_KEY`.

If yes, ensure `APP_ID` and `APP_PRIVATE_KEY` secrets are set on the repository.

### Self-hosted runner for deploy workflow

The deploy workflow requires a self-hosted runner with labels `[self-hosted, linux, production]`.

AskUserQuestion: Do you have a self-hosted GitHub Actions runner configured for this repo?

If no, follow the setup in `actions-runners/` or GitHub's runner registration docs.

### Upstream remote

Ensure the fork has an `upstream` remote locally:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git 2>/dev/null || true
```

## Phase 4: Verify

### Test sync manually

Trigger the workflow manually:

```bash
gh workflow run fork-sync-skills.yml
```

Or push to `main` and watch the Actions tab.

### Test deploy manually

```bash
gh workflow run deploy.yml
```

### Verify issues on failure

If the sync fails, check the repo's Issues tab for auto-created issues with labels `upstream-sync` or `skill-maintenance`.

## Troubleshooting

- **"Resource not accessible by integration"** — the GitHub App token doesn't have sufficient permissions. Check the App's installation and permissions.
- **Sync conflicts** — resolve manually: `git fetch upstream main && git merge upstream/main`, fix conflicts, push.
- **Deploy fails on self-hosted runner** — check the runner is online, has Node.js 20+, and the `nanoclaw` systemd user service exists.
- **Skill branch merge-forward fails** — checkout the failing branch, merge main manually, fix conflicts, push.

## Removal

1. Delete `.github/workflows/fork-sync-skills.yml`
2. Delete `.github/workflows/deploy.yml`
3. Delete `scripts/deploy.sh`
4. Optionally remove the GitHub App and its secrets
