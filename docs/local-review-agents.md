# Local review agents: CodeRabbit and Kilo Code

Hivekeep exposes two in-house local code reviewers as **first-class reviewer agents** rather than arbitrary shell commands:

- **CodeRabbit Reviewer** (`coderabbit-reviewer`) backed by CodeRabbit CLI (`cr` or `coderabbit`).
- **Kilo Code Reviewer** (`kilo-code-reviewer`) backed by the Kilo CLI.

These reviewer agents are dedicated to reviewing code before commits, pushes, and PRs. They sit on top of the existing local-review providers/adapters and add product-visible metadata: auth status, adapter mode, default gate, focus areas, checklist links, reviewer memory tags, instruction tags, recent runs, findings, and remediation state.

## First-class reviewer-agent model

Reviewer agents are defined in `src/server/services/reviewer-agents.ts` with stable ids and metadata:

- `id`, `name`, `provider`, `providerName`, `adapterMode`
- `defaultReviewMode` and `defaultGate`
- `focusAreas`
- `checklistIds`
- `memoryTags` and `instructionTags`
- `remediationTargets` for install-configurable remediation handoff seams

The MVP intentionally stores reviewer knowledge/checklists as JSON-backed service data under the code-review artifact directory (`reviewer-knowledge.json`) instead of adding a DB migration. The service boundary is stable so this can move to DB-backed persistence later.

Seeded guidance:

- CodeRabbit tags: `reviewer:coderabbit`, `local-review`, `pre-pr-gate`
- Kilo tags: `reviewer:kilo`, `local-review`, `pre-commit-gate`
- Checklist tags such as `checklist:pre-pr`, `checklist:pre-commit`, and `memory:review-guidance`

Full semantic memory integration is deliberately represented as tags/links in this MVP. The extension point is to resolve these tags into central memory/instruction records before a run, then include that guidance in provider prompts or reviewer-agent task context.

## Workflow

1. An Agent, hook, API caller, or the UI calls a reviewer-agent run.
2. Hivekeep resolves the reviewer-agent id to its local-review provider (`coderabbit` or `kilo`).
3. Hivekeep checks CLI install/auth status without exposing secrets. Kilo authentication is decided from `kilo auth list`; `kilo config check` is shown as informational diagnostics so unrelated optional config warnings do not mark auth false.
4. Hivekeep records review metadata: provider, reviewer agent, base/head, mode, timestamps, findings, and artifact path.
5. Each reviewer runs through a dedicated provider adapter:
   - CodeRabbit: `cr review --agent --dir <repo> --light` plus `--base` / `--base-commit` when supplied.
   - Kilo Code: Kilo's documented local-review slash commands through `kilo run --format json --auto --dir <repo> /local-review` (or `/local-review-uncommitted` for working-tree-only review).
6. Kilo falls back to a structured prompt (`kilo run --format json --auto --dir <repo> <review prompt>`) only if the slash-command run fails without parseable findings.
7. CLI stdout/stderr are read through byte-capped streaming head/tail buffers before parsing/persisting, avoiding unbounded memory use while preserving both early and late findings in very large outputs.
8. JSON-line, JSON-object, embedded JSON, or Markdown-table output is parsed into normalized `ReviewFinding[]`.
9. Findings default to `open` and can be moved to `fixed`, `ignored`, or `needs-decision` for remediation tracking.
10. The gate blocks automatic push/PR only in `blocking` mode when any `critical` or `major` findings exist. Advisory mode always reports but does not block.
11. A durable JSON artifact is written under `config.codeReview.artifactDir` (default `data/code-reviews`).

## Repository containment

Local review tools keep workspace containment as the default. A `repo_path`/`repoPath` is first resolved to a real path, so symlinks cannot escape the allowed area. Hivekeep then allows the repository only when the resolved path is equal to or inside either:

- the current tool workspace/worktree; or
- one of the explicitly configured roots in `config.codeReview.allowedRepoRoots`.

Set additional roots with `HIVEKEEP_CODE_REVIEW_ALLOWED_ROOTS`. The value accepts host path separators and commas, for example:

```bash
HIVEKEEP_CODE_REVIEW_ALLOWED_ROOTS=/srv/repos:/opt/hivekeep/review-roots
HIVEKEEP_CODE_REVIEW_ALLOWED_ROOTS=/srv/repos,/opt/hivekeep/review-roots
```

Each configured root is also resolved to a real path before checking containment. Paths outside both the current workspace and configured roots are rejected before any reviewer CLI runs. The target must also be a Git repository root or contain a Git worktree: Hivekeep verifies this with `git -C <repo> rev-parse --show-toplevel` and rejects non-Git directories with a clear validation error.

## Tools

- `list_local_reviewers` — lists CodeRabbit and Kilo Code status.
- `check_code_review_auth` — checks CLI install/auth/doctor state for one or both reviewers.
- `run_local_code_review` — runs reviewers and returns structured results.

The tools are available to main Agents and sub-Agents and are included in the built-in `code` toolbox. Tool invocations forward the per-task workspace environment (for example `HIVEKEEP_GH_TOKEN` injected into ticket worktrees) into reviewer subprocesses without placing secrets in prompts or command arguments.

## HTTP API and UI

The reviewer-agent UI is available from the left activity bar as **Reviewer Agents** (`/reviewer-agents`, admin-only nav item).

Backend routes live under `/api/reviewer-agents`:

- `GET /api/reviewer-agents?repoPath=<path>` — list CodeRabbit Reviewer and Kilo Code Reviewer cards, auth status, checklists, and recent runs.
- `GET /api/reviewer-agents/:id` — fetch one reviewer agent.
- `POST /api/reviewer-agents/:id/runs` — run a review via one reviewer agent.
- `GET /api/reviewer-agents/runs?limit=20` — list recent persisted review artifacts.
- `GET /api/reviewer-agents/runs/:id` — fetch one review run detail.
- `PATCH /api/reviewer-agents/runs/:id/findings/:findingId` — update finding state (`open`, `fixed`, `ignored`, `needs-decision`).
- `GET /api/reviewer-agents/checklists` — list seeded/reusable reviewer checklists.
- `PATCH /api/reviewer-agents/checklists/:id` — edit checklist title/description/items/tags.

UI surfaces include:

- Dedicated CodeRabbit Reviewer and Kilo Code Reviewer cards.
- CLI install/auth status, version, adapter/driver mode, default gate, focus/memory/instruction tags.
- Latest gate status: clean, advisory findings, blocking findings, skipped, failed, or auth missing.
- Run controls for repo path, base ref, and advisory/blocking mode.
- Recent run history.
- Review-run detail with provider, adapter mode, repo/range, status, gate decision, timestamps/duration, finding severity counts, artifact path, and raw output disclosure.
- Checklist display/editing for seeded reviewer-specific checklists.
- Finding state updates for remediation tracking.
- Remediation handoff stubs for assigning findings to install-configured remediation agents; full task spawning is intentionally left as a follow-up seam.

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

Hivekeep does **not** install this as a mandatory git hook automatically. Teams can opt in by calling the script from `.git/hooks/pre-push`, a PR creation wrapper, or CI. If `--mode` / `HIVEKEEP_LOCAL_REVIEW_MODE` is omitted, the script now defers to `config.codeReview.defaultMode` rather than hard-coding advisory mode.

## Authentication and data flow

Never put secrets in prompts or repo files. Hivekeep surfaces CLI auth/doctor state only; it does not reveal tokens.

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
- normalized findings: severity, confidence, title, message, file/line, rule id, and remediation state
- summary suitable for chat/task reporting

This JSON persistence is deliberately small and filesystem-backed for the MVP. The service boundary in `src/server/services/local-review.ts` is ready to swap to a DB-backed persistence layer later.

## Remediation loop

The review result is structured so install-configured remediation agents or ticket-bound sub-Agents can consume findings, fix high-severity issues, and rerun review before push/PR. In blocking mode, major/critical findings should prevent automatic push or PR creation unless a human explicitly overrides the gate.

The current UI supports manual state transitions:

- `open` — active issue requiring attention.
- `fixed` — addressed by a follow-up change.
- `ignored` — accepted or intentionally not addressed.
- `needs-decision` — requires human/lead judgment before commit/PR.

The full "spawn fix task" action is exposed as a UI/service seam, but task creation from a specific finding should be added after the reviewer-agent MVP settles.

## Deferred enhancements

- DB-backed reviewer knowledge/checklists and run history.
- Full central-memory resolution for reviewer memory/instruction tags.
- Spawn-fix-task flow from a finding to an install-configured remediation agent with ticket comments and rerun automation.
- Richer extraction for Kilo's nested task output if Kilo publishes a tighter machine-readable finding schema than JSON events containing review text.
- Automatic PR wrapper integration after the local runner has settled.
