# Local test instance (for agents verifying changes)

A ready-to-run, **LLM-capable** seeded database lives on this dev machine so you
can launch the real app and verify a change instead of only running tests. Use
it. Founders strongly prefer "I booted it and saw it work" over "typecheck
passed".

## What's seeded

Canonical seed data dir: **`~/.local/share/hivekeep-testdata/`** (self-contained:
SQLite DB + persisted `.encryption-key` + `workspaces/`).

- **Admin user**: `admin@local.test` / `Password123!` (onboarding complete)
- **Anthropic "Claude (subscription)" provider** in `cli` mode → reads the host's
  `~/.claude/.credentials.json` (Claude Max OAuth) at runtime. **No secret is
  stored in the DB**, so it's safe to copy around; it just works on this machine.
  Models are synced and the default LLM is set, so chat / tasks / tools work.
- One regular **Agent** ("Tester") bound to the default model
- **25 contacts**, **12 vault secrets**, **10 webhooks** — enough to exercise the
  settings list screens (search / filter / pagination thresholds are 8 items)

## Booting an isolated instance against it

> **Never boot against the canonical dir directly** — tests mutate data. Copy it
> first. And **never** use the prod env (see warnings below).

```bash
# 1. Copy the seed to a throwaway dir
SRC=~/.local/share/hivekeep-testdata
DST=/tmp/hk-test-$$
cp -r "$SRC" "$DST"

# 2. Boot on a dedicated port with the env FULLY overridden (this shell inherits
#    PROD env vars — see below). Leave ENCRYPTION_KEY unset; the dir carries its own.
DB_PATH="$DST/hivekeep.db" HIVEKEEP_DATA_DIR="$DST" \
PORT=4178 PUBLIC_URL=http://localhost:4178 HIVEKEEP_PUBLIC_URL=http://localhost:4178 \
TRUSTED_ORIGINS=http://localhost:4178 HIVEKEEP_MODEL_REGISTRY=false \
NODE_OPTIONS=--max-old-space-size=4096 \
bun src/server/index.ts
```

Then log in at `http://localhost:4178` with the admin creds above, or drive it
with Playwright (chromium is installed). Stop it by its **exact PID** when done.

## Regenerating / extending the seed

```bash
bun scripts/seed-test-db.ts          # top up what's missing (idempotent)
FRESH=1 bun scripts/seed-test-db.ts  # wipe + reseed from scratch
TESTDATA_DIR=/path bun scripts/seed-test-db.ts
```

`scripts/seed-test-db.ts` is the source of truth (survives schema migrations —
just re-run it). Extend it there if you need more seeded data (channels, crons,
mini-apps, etc.).

## Critical gotchas (this machine)

- **This shell inherits PROD env vars** from the user profile:
  `DB_PATH=~/.local/share/kinbot/kinbot.db` (the **live 185 MB prod DB**),
  `HIVEKEEP_DATA_DIR=~/.local/share/kinbot`, `PORT=3000`. A bare `bun run start`
  or `bun run db:migrate` targets **PROD**. Always override `DB_PATH` +
  `HIVEKEEP_DATA_DIR` + `PORT` inline. `scripts/migrate.ts` reads `DB_PATH` (not
  `HIVEKEEP_DATA_DIR`).
- **Prod runs live on port 3000.** Never `kill`/`pkill` by port or pattern — kill
  your isolated server by its exact PID only.
- **Settings is a modal, not a route.** Open it deterministically by navigating
  to `/?email_connected=x` (a URL hook), then click the section in the nav.
- **Playwright**: use `waitUntil: 'domcontentloaded'`, NOT `'networkidle'` — the
  global SSE connection never lets the network go idle. Launch chromium with
  `args: ['--no-sandbox']`.
- **Typecheck OOMs** without `NODE_OPTIONS=--max-old-space-size=8192`.
- The worktree has no `node_modules` of its own; Vite/bun need a symlink:
  `ln -s <repo-root>/node_modules node_modules` (gitignored).
