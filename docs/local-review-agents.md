# Local review agents: CodeRabbit and Kilo Code

Hivekeep exposes two in-house local code reviewers as first-class reviewer providers rather than arbitrary shell commands:

- **CodeRabbit** (`coderabbit`) through the CodeRabbit CLI (`cr` or `coderabbit`).
- **Kilo Code** (`kilo`) through the Kilo CLI.

The goal is a hook-style workflow that can run before push or PR creation, persist review artifacts, and give Agents/users a structured gating decision without making every commit depend on network services by default.

## Workflow

1. An Agent or hook calls `run_local_code_review` (or `bun scripts/hivekeep-local-review.ts`).
2. Hivekeep resolves the repo/worktree path and records review metadata: provider, base/head, mode, timestamps, findings, and artifact path.
3. Each reviewer runs as a dedicated provider adapter:
   - CodeRabbit: `cr review --agent --dir <repo> --light` plus `--base` / `--base-commit` when supplied.
   - Kilo Code: prompt fallback through `kilo run --format json --auto --dir <repo> <review prompt>`.
4. JSON-line or JSON-object output is parsed into `ReviewFinding[]`.
5. The gate blocks automatic push/PR only in `blocking` mode when any `critical` or `major` findings exist. Advisory mode always reports but does not block.
6. A durable JSON artifact is written under `config.codeReview.artifactDir` (default `data/code-reviews`).

## Tools

- `list_local_reviewers` — lists CodeRabbit and Kilo Code status.
- `check_code_review_auth` — checks CLI install/auth/doctor state for one or both reviewers.
- `run_local_code_review` — runs reviewers and returns structured results.

The tools are available to main Agents and sub-Agents and are included in the built-in `code` toolbox.

## Hook runner

Advisory pre-push example:

```bash
bun scripts/hivekeep-local-review.ts --provider all --mode advisory --base origin/main
```

Blocking pre-PR example:

```bash
bun scripts/hivekeep-local-review.ts --provider all --mode blocking --base origin/main
```

Exit codes:

- `0` — review passed or advisory findings were reported.
- `1` — reviewer failed in blocking mode.
- `2` — blocking mode found major/critical issues.

Hivekeep does **not** install this as a mandatory git hook automatically. Teams can opt in by calling the script from `.git/hooks/pre-push`, a PR creation wrapper, or CI.

## Authentication and data flow

Never put secrets in prompts or repo files.

### CodeRabbit

Install and authenticate the CodeRabbit CLI using CodeRabbit's documented setup. Hivekeep checks:

- `cr --version` or `coderabbit --version`
- `cr auth status --agent`
- `cr doctor`

Reviews are run with `cr review --agent`; review data is sent wherever the CodeRabbit CLI sends it under its authenticated account.

### Kilo Code

Kilo 7.3.44 was verified locally. The CLI exposes `kilo run --format json --auto --dir <repo>` for non-interactive runs. No dedicated non-interactive `/local-review` command was confirmed in this pass, so Hivekeep uses a structured review prompt fallback and documents that limitation clearly.

Review data is sent to the model/provider configured in Kilo. Use `kilo auth`, `kilo models`, `kilo profile`, and `kilo debug` locally to verify account/provider state.

## Artifact schema

Artifacts contain:

- run id, mode, status, blocked flag
- repo path, base/baseCommit/head
- per-provider status and raw capped output
- normalized findings: severity, confidence, title, message, file/line, rule id
- summary suitable for chat/task reporting

This JSON persistence is deliberately small and filesystem-backed for the MVP. The service boundary in `src/server/services/local-review.ts` is ready to swap to a DB-backed persistence layer later.

## Remediation loop

The review result is structured so Hiro/Kaito or ticket-bound sub-Agents can consume findings, fix high-severity issues, and rerun review before push/PR. In blocking mode, major/critical findings should prevent automatic push or PR creation unless a human explicitly overrides the gate.

## Deferred enhancements

- Rich React renderer for review artifacts/findings.
- DB migration and review-run history UI.
- Native Kilo local-review command support if/when a stable non-interactive command is available.
- Automatic PR wrapper integration after the local runner has settled.
