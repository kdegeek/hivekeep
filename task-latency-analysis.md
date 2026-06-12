# Task latency — Hivekeep vs Claude Code (investigation 2026-05-29)

Why the *same* task is fast on Claude Code (CC) and slow on Hivekeep, even though
both use **Opus 4.8 on the same OAuth endpoint** (Hivekeep's anthropic-oauth
provider is fingerprinted to ride the same Claude subscription pool as CC).

## TL;DR

Same model + same endpoint, but **not the same setup**. Three *measured*
causes — none of which is the thinking *budget* we first suspected:

1. **Different thinking API generation.** CC uses the new adaptive/effort API
   (`output_config.effort` + `thinking:{type:"adaptive"}` + beta
   `effort-2025-11-24`) — the model decides how much to think per step (≈0 on a
   trivial read). Hivekeep uses the **legacy** API (`thinking:{type:"enabled",
   budget_tokens:8192}`) — a fat fixed thinking block **forced before every
   step**.
2. **Different architecture.** CC delegates the grunt exploration to a **Haiku
   sub-agent** (43 of 52 requests); its Opus only orchestrates (6 steps). Hivekeep
   runs **every** step in Opus-with-thinking, no delegation.
3. **Different orchestrator batching.** CC's Opus batched **3.0 tool calls/step**;
   Hivekeep's Opus does **1.3–1.6**.

## Method

Wire-level capture, both harnesses routed through one local proxy via
`ANTHROPIC_BASE_URL` (neither pins a baseURL, so zero code change):

- `scripts/llm-capture-proxy.ts` — fingerprints every `/v1/messages` request
  (model, thinking, betas, temperature, max_tokens, system size, tool count,
  and **cumulative `tool_result` block counts** — message *count* can't detect
  batching because parallel tool results pack into one user message). Dedupes
  big stable blobs (system, tools) by hash. Flags: `--force-thinking off|<budget>`
  and `--strip-beta <name>` to run single-variable A/Bs. Billing signature only
  covers the first user message text, so rewriting thinking/max_tokens/betas is
  safe.
- `scripts/llm-capture-diff.ts` — side-by-side first-request config + run
  aggregates (round-trips, tool calls/step, max batch).
- Captures live under `data/llm-capture/<label>/`.

**Test task** (identical across all runs): a read-only "map how the thinking
config flows from an Agent's settings to the Anthropic request" exploration of the
hivekeep repo. Read-only → no repo state to reset → starting state identical.

## Runs

| run | model / thinking | round-trips | tool calls | calls/step | max batch | wall |
|---|---|---|---|---|---|---|
| `hivekeep-normal` | Opus, budget 8192, interleaved on | ~96 | 109 | ~1.14 | — | 7m15 |
| `hivekeep-low` | Opus, budget 2048, interleaved on | 98 | 115 | 1.28 | 4 | 7m31 |
| `hivekeep-nointerleave` | Opus, budget 2048, interleaved **off** | 69 | 106 | 1.58 | 4 | 7m09 |
| **`claude-code`** | Opus orchestrator + **Haiku sub-agent**, effort=high adaptive | 52 (9 Opus + 43 Haiku) | ~54 | Opus **3.0** / Haiku 1.0 | 4 | **4m53** |
| **`hivekeep-adaptive`** (after fix) | Opus, **adaptive** thinking, effort=medium | **24** | **41** | **1.78** | 4 | **2m44** |

**Measured result of recommendation 1 (adaptive thinking), same task:** round-trips
~96 → **24 (4×)**, tool calls 109 → **41 (−62%)**, wall 7m15 → **2m44 (2.6×)**,
context 57k → 39k. calls/step rose (1.28 → 1.78) *while* total calls dropped — freed
from a forced thinking block before every action, the model plans better and acts
more decisively. One config change; N=1 but the magnitude dwarfs run-to-run noise.
Hivekeep-adaptive (effort=medium) already matches/beats CC on this task (CC at
effort=high: 4m53, ~54 calls) without even needing the sub-agent delegation of
recommendation 2 — CC's remaining edge is mostly the cheap Haiku worker + a higher
effort tier.

CC did **~half the tool calls** AND ran most of them on a model ~5–10× faster
per step.

## Findings

### Axis 1 — the thinking knob (the long-running mystery, resolved)

Captured from CC's body: `output_config: {effort: "high"}` + `thinking:
{type:"adaptive"}`, beta `effort-2025-11-24`. So **CC's `/effort` is
`output_config.effort`, a native adaptive control — NOT `budget_tokens`.**

Hivekeep sends `thinking: {type:"enabled", budget_tokens:8192}` (from
`resolveThinkingConfig` default `medium`, mapped in `_anthropic-shared.ts:51`)
on **every** step. That's why CC at xhigh is still fast: "high effort" ≠ "8192
thinking tokens before every tool call." It's adaptive; Hivekeep's is fixed and
forced. We were turning the wrong knob in every "budget" comparison.

### Axis 2 — architecture (the big speed lever)

CC offloaded 43/52 requests to a Haiku sub-agent (no thinking, maxTok 32000) for
the file reading/grepping; the Opus orchestrator only planned, spawned, and
synthesized (6 thinking steps, batching 3.0 calls/step). Hivekeep ran all ~96
steps itself in Opus-with-thinking. The Agent *had* `spawn_self` (the prompt even
recommends it for >5 searches) but **didn't use it** — and even if it had, a
spawned sub-Agent runs the **same expensive Opus+thinking**, so the incentive to
delegate is weak.

### Axis 3 — orchestrator batching

CC's Opus: 3.0 calls/step (every tool-step batched 2–4). Hivekeep's Opus: 1.3–1.6,
~23% of steps batched. The "Fan out independent reads in one step" directive
exists (`prompt-builder.ts:980`) but is bullet 4 of an 11-item caution wall,
competing with serial-leaning scaffolding: `think`-to-plan
(`prompt-builder.ts:986`), `task_todos` one-in-flight (`:987`), and "call them
one at a time" (`:971`, `:1079`).

### Ruled out (with evidence)

- **Tool count / schema size** — CC carries **more** (69–79 tools, 90–122 KB
  incl. MCP) than Hivekeep (33 tools, 24 KB) and is faster.
- **Interleaved thinking alone** — CC sends `interleaved-thinking-2025-05-14`
  too and still batches 3.0. The -30% we saw on Hivekeep when stripping it is the
  *interleaved + fixed-budget* combination, not interleaved per se.
- **Thinking budget magnitude** — 8192 vs 2048 changed nothing (96 vs 90
  round-trips = noise).

### Betas CC sends that Hivekeep doesn't

`effort-2025-11-24`, `context-management-2025-06-27`, `context-1m-2025-08-07`,
`thinking-token-count-2026-05-13`, `redact-thinking-2026-02-12`,
`mid-conversation-system-2026-04-07`, `structured-outputs-2025-12-15`,
`extended-cache-ttl-2025-04-11`; plus `output_config` and `context_management`
request params. Hivekeep sends only 6 betas (`anthropic-oauth-auth.ts:264`). The
divergence also matters for the billing pool (and likely contributed to the
`overloaded_error` seen when thinking was stripped to 0: that routed onto the
saturated non-thinking Opus pool while the thinking pool had headroom).

## Recommendations (priority order)

1. **Migrate the anthropic provider to the effort/adaptive thinking API.**
   **✅ DONE (2026-05-29).** `buildThinkingParams` in `_anthropic-shared.ts` now
   emits `thinking:{type:"adaptive"}` + `output_config:{effort}` when
   `config.llm.adaptiveThinking` is on (default; `HIVEKEEP_ADAPTIVE_THINKING=false`
   reverts to the legacy fixed `budget_tokens`). Both providers (`anthropic-key`,
   `anthropic-oauth`) set `output_config`; the OAuth header set gained
   `effort-2025-11-24`. SDK 0.81 supports all of it natively (and deprecates
   `type:"enabled"`). Kills the forced-8192-per-step, matches CC on the thinking
   axis, avoids the no-thinking overload pool. Verify on the wire via the capture
   proxy (expect `thinking={type:adaptive}` + `output_config.effort` + the beta).
2. **Cheap-model scouting** (see design below). Delegate read-only exploration
   to a fast/cheap model, like CC's Haiku Explore agent.
3. **Adopt CC's beta set + `context_management`** — modern behavior + closer CC
   fingerprint (pool stability).
4. **Prompt batching saliency** — promote "fan out independent reads" to a
   top-line unconditional directive with an example; trim the serial scaffolding
   for read-only/exploration tasks. (Secondary once adaptive thinking is in.)

## Open design — cheap-model scouting in a multi-provider world

CC has it easy: one provider, Haiku is always the cheap tier. Hivekeep is
multi-provider, so "use a light model for scouting" needs a resolution story.
Two concerns to keep separate:

**(A) Which model does delegated/sub-agent work use?** Make it a configurable
"scout model", resolved with a fallback chain that mirrors the existing
`resolveSearchProvider` pattern (explicit → global default → first valid):

```
explicit param on the spawn  →  Agent-level setting  →  project-level setting
  →  global app_settings.default_scout_model_id  →  (fallback) the Agent's main model
```

- Store as a concrete `{providerId, modelId}` (a *tier* like "cheap" can't be
  assumed across providers).
- **Decided (user, 2026-05-29):** configure it at **project level** (where the
  task model is declared) **and Agent level** — both, mirroring how the main model
  is configured. Not at the provider level (rejected: a provider-declared "light
  model" is the wrong layer — the choice belongs with the project/Agent, like the
  main model). Add a global default and a per-spawn override on top.
- If nothing is configured, fall back to the main model (current behaviour) but
  surface "no scout model set" so the user configures one. Auto-picking the
  cheapest model only works if Hivekeep tracks cost/speed tiers per model — it
  currently doesn't, so don't guess.
- This config benefits **crons and sub-tasks too**, not just a scout tool —
  which is why it should be a first-class setting, decided independently of (B).

**(B) How does the Agent decide to delegate?** The Agent under-uses `spawn_self`
today. Options:
- *Enhance `spawn_self`*: add a `model`/`tier` param, default read-only scouting
  spawns to the scout model from (A), and make the affordance prominent in the
  prompt. Lowest surface area — reuses all the sub-task machinery (await/async,
  depth limits, tool presets).
- *Dedicated `scout` tool*: a thin, highly-discoverable wrapper
  (`scout({queries, paths}) → digest`) that internally spawns a read-only
  cheap-model sub-task. More likely to be picked up by the model (discoverability
  is half of why CC's Agent tool gets used), at the cost of duplicating
  spawn_self.

**Recommendation:** build (A) first — it's the multi-provider answer and is
needed regardless. For (B), start by making `spawn_self` default its sub-task to
the scout model + raise its prompt saliency; measure delegation rate. If the
model still won't delegate, promote it to a dedicated `scout` tool with a punchy
description. Don't add the tool speculatively before measuring.

## Repro

```bash
# capture (no code change to Hivekeep — env var only)
bun scripts/llm-capture-proxy.ts --port 8789 --label <run>
ANTHROPIC_BASE_URL=http://localhost:8789 bun run dev     # Hivekeep
ANTHROPIC_BASE_URL=http://localhost:8789 claude          # Claude Code
# single-variable A/Bs
#   --force-thinking off|<budget>   rewrite the thinking param
#   --strip-beta <name>             drop a beta from the anthropic-beta header
bun scripts/llm-capture-diff.ts <runA> <runB>
```
