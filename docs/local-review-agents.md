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
   - Kilo Code: Kilo's documented local-review slash commands through `kilo run --format json --auto --dir <repo> /local-review` (or `/local-review-uncommitted` for working-tree-only review).
4. Kilo falls back to a structured prompt (`kilo run --format json --auto --dir <repo> <review prompt>`) only if the slash-command run fails without parseable findings.
5. JSON-line or JSON-object output is parsed into `ReviewFinding[]`.
6. The gate blocks automatic push/PR only in `blocking` mode when any `critical` or `major` findings exist. Advisory mode always reports but does not block.
7. A durable JSON artifact is written under `config.codeReview.artifactDir` (default `data/code-reviews`).

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

The Kilo CLI was verified locally during implementation. Its help exposes the scriptable runner contract:

```bash
kilo run --format json --auto --dir <repo> <message-or-slash-command>
```

The Kilo CLI docs at <https://kilo.ai/docs/code-with-ai/platforms/cli> document:

- `kilo run [message..]` with `--format json` for raw JSON events.
- `--auto` autonomous mode, including exit codes (`0` success, `124` timeout, `1` error).
- `--dir` to choose the working directory.
- built-in slash commands `/local-review` and `/local-review-uncommitted` under "Local Code Reviews".

Hivekeep therefore treats this as Kilo's primary local-review contract and runs:

```bash
kilo run --format json --auto --dir <repo> /local-review
```

For explicitly working-tree-only review (`head: "working tree"` with no base/base commit), Hivekeep uses:

```bash
kilo run --format json --auto --dir <repo> /local-review-uncommitted
```

The provider status/result exposes `localReviewMode: "slash-command"` for this path. If the slash command exits non-zero and produces no parseable findings, Hivekeep retries once with the older structured prompt fallback and marks `localReviewMode: "prompt-fallback"` in the result so callers can distinguish native Kilo review from fallback review.

Observed local behavior on this branch:

- `/local-review` returned JSON events and spawned Kilo's built-in "Run local review" task. It produced findings against the branch diff without modifying files.
- `/local-review-uncommitted` returned JSON events and reported no findings on a clean working tree.
- Top-level commands such as `kilo review`, `kilo local-review`, `kilo reviews`, and `kilo code-review` are not separate commands in 7.3.44; they print top-level help. The stable entrypoint is the slash command through `kilo run`.
- `kilo run --command local-review` did not complete in a short safety test, so Hivekeep does not use it.

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
- Richer extraction for Kilo's nested task output if Kilo publishes a tighter machine-readable finding schema than JSON events containing review text.
- Automatic PR wrapper integration after the local runner has settled.
