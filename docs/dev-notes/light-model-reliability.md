# Reliability with low-end / self-hosted LLMs

**Status:** analysis, plus R1, R2, and R6's sampling fix now implemented. This maps the
problem and proposes fixes ranked by impact and effort, for the maintainer to decide on.
Built so far: R1 (tolerant tool-argument parsing), R2 (schema validation with a correctable
error), and the low-temperature-for-tool-turns part of R6. R3 to R5 and R6's tool-scoping /
prompt-slimming parts remain proposals.

**Origin:** user feedback that Hivekeep is the #1-cited adoption blocker for the
self-hosted / local-LLM audience. The platform works well with Claude, but small and
medium self-hosted models (Gemma 12B self-hosted, a 31B on Ollama Cloud, and similar)
frequently return broken or empty tool-call JSON, or do not respond at all. Two peers
the reporter named, [Odysseus](https://pewdiepie-archdaemon.github.io/odysseus/) (a
self-hosted AI workspace) and [Hermes Agent](https://hermes-agent.nousresearch.com/)
(Nous Research), handle the same models far more reliably. Recommending Claude "for
reliability" is a workaround, not a fix: it locks out the exact audience Hivekeep
targets.

The short version: Hivekeep's tool-calling path is built and tuned for frontier models.
It relies entirely on native function-calling, sends the full instruction-heavy prompt
and the full tool surface regardless of model size, sets no sampling controls, uses no
constrained decoding even where the backend supports it, and has no repair-retry when a
call comes back malformed. Each of those is individually survivable on Claude and
individually fatal on a 12B local model. They stack.

---

## Phase 1 — How tool-calling / structured output works today

### 1.1 Request construction (the OpenAI-compatible path)

Self-hosted users almost always arrive through one provider:
`src/server/llm/llm/openai-compatible.ts`. Its own header doc (lines 1-30) names the
targets explicitly: NewAPI, LiteLLM, llama.cpp (`llama-server`), LM Studio, vLLM, and
Ollama's OpenAI shim. There is **no dedicated `ollama.ts` / `llamacpp.ts` / `vllm.ts` /
`lmstudio.ts`** and **no branching on backend type**. Every local endpoint is treated as
a vanilla OpenAI `/chat/completions` server. The branded providers (`xai.ts`,
`openrouter.ts`, `deepseek.ts`, `moonshot.ts`, `minimax.ts`) are near-verbatim copies of
the same `chat()` / `streamChat()` code with a hardcoded base URL.

The request payload is minimal (`openai-compatible.ts:497-526`):

```ts
const params: ChatCompletionCreateParamsStreaming = {
  model: model.id,
  messages: messagesToOpenAI(request.messages, system),
  stream: true,
  stream_options: { include_usage: true },
}
const tools = toolsToOpenAI(request.tools)
if (tools) params.tools = tools
// optional: max_tokens, temperature, reasoning_effort (gated), user
```

### 1.2 Tool calls are native-only

All providers attach tools as the **native OpenAI `tools` array**
(`openai-compatible.ts:320-330`, `toolsToOpenAI`):

```ts
return tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}))
```

`parameters` is the tool's raw JSON Schema, sent unmodified. There is **no prompt-based
or text tool protocol** anywhere in the codebase. A model that cannot reliably emit
native OpenAI `tool_calls` has no fallback path.

### 1.3 No forcing, no JSON mode, no constrained decoding

Confirmed by grep across the chat path:

- **`tool_choice` is never sent.** No provider sets `tool_choice: "required" | "auto" |
  "any"`. Gemini even declares the type for it (`gemini.ts:134`,
  `functionCallingConfig.mode`) but `chat()` never sets it (`gemini.ts:704`). Tool use
  is always left to the model's discretion.
- **No `response_format` / `json_schema`** (OpenAI structured outputs).
- **No vLLM `guided_json` / `guided_choice` / `guided_grammar`.**
- **No Ollama `format` (json / json-schema).**
- **No llama.cpp GBNF `grammar`.**

The generic connector's header explicitly commits to "no vendor quirks", so none of the
backend-specific structured-output knobs are ever used, even though every backend
Hivekeep targets supports at least one of them.

### 1.4 Sampling is left to the backend default

Every provider gates sampling on the request: `if (request.temperature != null)
params.temperature = request.temperature` (`openai-compatible.ts:510-512` and twins).
But **no caller in `src/server/` ever sets `temperature`, `top_p`, or `maxOutputTokens`.**
The request is assembled in `agent-engine.ts:1612-1622` (and the quick-session path
`:2383`, and the task path `tasks.ts:1529`) with only `messages`, `system`, `tools`,
`thinkingEffort`, `signal`. `ChatRequest` (`packages/sdk/src/index.ts:1011-1023`) has the
fields; nothing populates them.

Consequence: temperature is whatever the local server defaults to, commonly 0.7 to 0.8
for Ollama and llama.cpp, with **no lowering for tool-calling turns**. High temperature
is a direct cause of malformed structured output on small models.

### 1.5 The streaming parse and the failure path

Tool-call argument deltas are accumulated by index and parsed at stream end
(`openai-compatible.ts:407-418`):

```ts
for (const state of toolsByIndex.values()) {
  if (!state.id || !state.name) continue          // (A) silently DROPS id/name-less calls
  let args: unknown = {}
  if (state.args.length > 0) {
    try { args = JSON.parse(state.args) }
    catch { args = { _raw: state.args } }         // (B) malformed JSON wrapped, not repaired
  }
  yield { type: 'tool-use', id: state.id, name: state.name, args }
}
```

This exact pattern is duplicated in `xai.ts:430`, `openrouter.ts:471`, `deepseek.ts:406`,
`moonshot.ts:503`, `minimax.ts:565`, `openai-key.ts:381`, `openai-codex.ts:455`, and
`_anthropic-shared.ts:363`.

The parse is a single `JSON.parse`. There is **no tolerant parsing**: no stripping of
` ```json ` fences, no first-JSON-object extraction, no brace-balancing, no
trailing-prose tolerance.

Downstream, `normalizeToolUseInput` (`stream-runner.ts:68-92`) only coerces *non-objects*
to `{}`. A `{ _raw: "..." }` value **is** a plain object, so it passes through unchanged
and reaches the tool's `execute` as its arguments. The real fields the model intended are
gone.

**There is no schema validation of arguments before execution.** `tool()`
(`packages/sdk/src/index.ts:89-98`) is a typed pass-through; `asSchema` (`:119-145`) only
converts the declared schema to JSON Schema to *send to the model*; it is never run
against returned args. `executeSingleTool` (`tool-executor.ts:243-395`) calls
`toolDef.execute(execArgs, ...)` directly.

What happens for each failure mode (this is the crux):

| Model returns | What happens today | Where |
|---|---|---|
| Malformed JSON args | Wrapped as `{ _raw: "<string>" }`, passed to the tool as garbage args, tool throws on a missing field, error string returned to the model as a tool-result. Loop continues. **No repair re-prompt.** | `openai-compatible.ts:413`, `tool-executor.ts:364-373` |
| Tool-call delta with no `id` / `name` | **Silently dropped** (`continue`). The call vanishes; looks empty. | `openai-compatible.ts:408` |
| Empty response / no tool call | Loop breaks; an italic system note is shown to the user ("The model ended its turn without producing a response. Try sending your message again.") keyed on `finishReason`. **No retry.** | `agent-engine.ts:1673`, `:1832-1853` |
| Unknown tool name | `{ error: describeUnavailableTool(name) }` returned to the model. Loop continues. | `tool-executor.ts:249-252`, `:187-220` |
| Prose describing a tool call (no native `tool_use`) | Treated as the final text answer, shown to the user verbatim, loop ends. The tool never runs. | `stream-runner.ts:341-367` |

The agent loop itself (`agent-engine.ts:processNextMessage` 1607-1722, mirrored in the
quick-session loop `:2378-2474` and `tasks.ts`) never throws on a bad tool call: every
failure becomes a `{ error }` tool-result fed back to the model, and recovery depends
entirely on the model noticing and self-correcting on a later step, bounded only by
`config.tools.maxSteps`. **There is no retry-with-repair, no max-retries, no backoff.**

### 1.6 Prompt and tool surface (model-agnostic)

`buildSystemPrompt` (`prompt-builder.ts`) assembles roughly 27 blocks for a main Agent.
The `## Internal instructions` block alone is a single literal of about 23,000 characters
(~5 to 6k tokens), always on for any tool-enabled main Agent
(`prompt-builder.ts:1304-1436`). The only model-driven gate is `toolsEnabled`
(`prompt-builder.ts:972`, computed from `getMaxToolsForRequest(...) > 0` at
`agent-engine.ts:1388`); when a model declares `maxTools: 0` the tool sections are
omitted. **There is no "small model" branch** that shrinks the prompt. A Gemma 12B with
`maxTools > 0` gets the identical prompt Claude Opus gets.

Tool surface: `register.ts` registers **269 native tools**. The default "all" toolbox
expands `"*"` to every native + enabled custom tool (`toolset-resolver.ts:125-204`,
`toolboxes.ts`). The only per-turn reduction is `capTools` (`agent-engine.ts:110-187`), a
**hard numeric cap, not a relevance filter**: it keeps a protected set then fills slots in
insertion order up to `maxTools` (model `maxTools` ?? provider default ??
`DEFAULT_MAX_LLM_TOOLS = 128`). For any provider whose cap is >= 269 nothing is dropped.
So a small local model can be handed well over a hundred JSON-Schema tool definitions,
each with multi-sentence descriptions, on every turn.

Context window: estimated (`estimateContextTokens`, `agent-engine.ts:613-677`) and shown
in the UI, but **never compared against `contextWindow` to gate or trim before the call.**
Overflow is handled reactively, after the provider errors (`CONTEXT_TOO_LARGE_RE`,
`agent-engine.ts:466`, recovery at `:2028-2058`). On a small-context local model the fixed
prompt + tools overhead can dominate the window, and compacting only trims message
history, not the system prompt or the tool block.

There are **no few-shot examples** teaching tool-call syntax. The only tool-related prompt
text is behavioral anti-narration guidance (`## Tool calling discipline`,
`prompt-builder.ts:1130-1152`), which adds prompt weight without helping a weak model
form a valid call.

---

## Phase 2 — Why small models fail here

Each row maps a known failure mode to whether Hivekeep is affected and where.

| Failure mode | Affected? | Where / why |
|---|---|---|
| Strict native function-calling that small/local models support poorly | **Yes, severely.** Native `tools` is the *only* path; no prompt-based fallback. | `openai-compatible.ts:320-330`, `:504-505` |
| No tolerant JSON parsing (fence / stray token / unclosed brace / trailing prose breaks the turn) | **Yes.** Single `JSON.parse`, malformed wrapped as `{ _raw }` and passed through as bad args. | `openai-compatible.ts:407-418`, `stream-runner.ts:68-92` |
| No retry-with-repair loop | **Yes.** No repair re-prompt anywhere; recovery is implicit self-correction only. | `agent-engine.ts:1607-1722`; grep for retry/repair = none in the loop |
| No constrained decoding even when the backend supports it | **Yes.** No `format` (Ollama), `guided_json` (vLLM), or GBNF grammar (llama.cpp), no `response_format`, no `tool_choice`. | grep: 0 hits in chat path |
| System prompt / tool schema too large for small context | **Yes.** ~5 to 6k-token always-on instructions + up to 269 tool schemas, model-agnostic, no pre-call size check. | `prompt-builder.ts:1304-1436`, `toolset-resolver.ts:125-204`, `agent-engine.ts:110-187` |
| Too many tools exposed at once | **Yes.** Default "all" toolbox; `capTools` is a numeric cap, not relevance scoping. | `toolboxes.ts`, `agent-engine.ts:110-187` |
| Temperature / sampling not tuned for structured output | **Yes.** `temperature` never set; backend default (often 0.7 to 0.8) used for tool turns. | `agent-engine.ts:1612-1622`, `openai-compatible.ts:510-512` |

Two compounding details worth calling out, because they make the symptom look like
"empty / no response" rather than "error":

- **Silent drop of id/name-less calls** (`openai-compatible.ts:408`). Several local
  backends stream tool-call deltas without an `id`, or send the function name late. Those
  calls are discarded with no trace. From the user's seat the model "did nothing."
- **Prose-as-final-answer** (`stream-runner.ts:341-367`). A weak model that narrates a
  tool call in plain text instead of emitting native `tool_use` (very common on local
  models) has that prose shown as the final answer and the turn ends. The tool never runs
  and nothing flags it.

---

## Phase 3 — How the peers and the ecosystem do it

The reliable approaches cluster into three layers. Hivekeep currently has none of them.

### 3.1 Constrain generation so invalid output is impossible (best, backend-dependent)

This is the highest-leverage technique and the one local backends are built for. Instead
of hoping the model emits valid JSON, the backend masks tokens during decoding so only
schema-valid continuations are sampleable.

- **llama.cpp GBNF grammars.** `common/json-schema-to-grammar.cpp` converts JSON Schema
  (Draft 7 subset: types, enums, `oneOf`/`anyOf`/`allOf`, string/number/array/object
  constraints) into a GBNF grammar that forces valid output. This is the foundation of
  llama.cpp's own tool-calling. Sources:
  [llama.cpp grammar & structured output](https://deepwiki.com/ggml-org/llama.cpp/8.1-grammar-and-structured-output),
  [grammars/README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md),
  [constrained decoding guide](https://www.aidancooper.co.uk/constrained-decoding/).
- **vLLM guided decoding.** The OpenAI-compatible server accepts `guided_json`,
  `guided_choice`, `guided_regex`, `guided_grammar` (migrating to a unified
  `structured_outputs` field). Notably, vLLM applies guided decoding automatically for
  `tool_choice: "required"`, and constraining to a known structure can *speed up*
  generation by skipping sampling. Sources:
  [vLLM structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/),
  [vLLM tool calling](https://docs.vllm.ai/en/v0.8.3/features/tool_calling.html),
  [Red Hat: structured outputs in vLLM](https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses).
- **Ollama structured outputs.** Pass a JSON Schema as the `format` field. Ollama reports
  "6x faster performance with near-100% parse success" and "most models almost always
  return outputs matching the requested schema." Sources:
  [Ollama structured outputs blog](https://ollama.com/blog/structured-outputs),
  [Ollama docs](https://docs.ollama.com/capabilities/structured-outputs).
- **Libraries that do this generically:** Outlines and Guidance (token-masking during
  generation), and XGrammar (the engine behind much of the above). They "mask invalid
  tokens so the model physically cannot produce malformed output." Source:
  [structured output libraries](https://techsy.io/en/blog/best-llm-structured-output-libraries).

The catch (worth noting in the plan): grammar constraints guarantee structure but not
completion. A model can still truncate before closing the JSON if it runs out of tokens
([llama.cpp grammar notes](https://deepwiki.com/ggml-org/llama.cpp/8.1-grammar-and-structured-output)).
So constrained decoding pairs well with, not replaces, tolerant parsing and repair.

### 3.2 A prompt-based tool protocol for models with weak native function-calling

This is precisely what **Hermes Agent** does and is the most portable idea for Hivekeep's
generic provider. Hermes models are trained to receive tool signatures inside
`<tools>...</tools>` in the system prompt and to emit calls as XML-wrapped JSON:

```
<tool_call> {"name": "terminal", "arguments": {"command": "ls -la"}} </tool_call>
```

The model decides when to call; the host parses the delimited block. Because the channel
is plain text inside a clear delimiter, it does not depend on the backend implementing the
OpenAI `tool_calls` streaming contract correctly (which many local shims do
imperfectly), and it degrades to recoverable text rather than a silently dropped call.
Sources:
[Hermes function-calling](https://github.com/NousResearch/Hermes-Function-Calling),
[JSON mode system](https://deepwiki.com/NousResearch/Hermes-Function-Calling/3-json-mode-system),
[Hermes 3 as an agent](https://internet10k.com/en/blog/hermes-3-agent-function-calling-en/).

[Odysseus](https://pewdiepie-archdaemon.github.io/odysseus/) attacks the problem from the
deployment side: a hardware-aware layer that scans VRAM and recommends a quantization
(GGUF / FP8 / AWQ) known to run well, plus per-session tool toggling for granular control
of the tool surface. The portable lesson there is **scope the tools per session and steer
users onto model/quant combinations that actually tool-call**, rather than exposing
everything to everything.

### 3.3 Tolerant parse + validate + repair-retry (after generation, backend-agnostic)

This is the floor that works on every backend, including closed ones, and is what
Instructor and BAML do:

- **Tolerant ingestion.** Strip markdown fences, extract the first `{...}` span, then run
  a JSON-repair pass (close brackets/braces, fix quotes, drop trailing commas, strip
  conversational preamble). Libraries:
  [mangiucugna/json_repair](https://github.com/mangiucugna/json_repair) (Python; ports
  exist),
  [llm-json-repair](https://github.com/gcrabtree/llm-json-repair). The recommended
  architecture is three layers: lenient parse, repair library, then re-prompt fallback
  ([resilient LLM JSON handling](https://medium.com/@gtdevice/architecting-resilient-llm-interactions-a-definitive-guide-to-robust-json-handling-in-java-0caa6947ea73),
  [DataWeave 3 layers of defense](https://dev.to/thasha/parsing-llm-responses-in-dataweave-3-layers-of-defense-against-markdown-fences-4ch5)).
- **Validate against the schema, then repair-retry.** Instructor re-sends the failed
  output plus the validation error and asks the model to fix the specific issue; BAML uses
  a json-repair algorithm first and retries only when needed. "Tool argument rot" (malformed
  JSON, missing fields, wrong types) is explicitly identified as the dominant source of
  agent flakiness, and validating every tool input against its schema as a strict contract
  is named the most effective fix. Sources:
  [Instructor + Ollama](https://python.useinstructor.com/integrations/ollama/),
  [BAML vs Instructor](https://www.glukhov.org/post/2025/12/baml-vs-instruct-for-structured-output-llm-in-python/),
  [how to get reliable structured output](https://mljourney.com/how-to-get-reliable-structured-output-from-llms/).

---

## Phase 4 — Remediation plan, ranked

Ranked by impact-to-effort. Each item lists the concrete files/symbols to change.
**This pass implements nothing**; these are proposals.

### R1. Tolerant parse + repair of tool-call arguments (highest impact, low effort) — IMPLEMENTED

**Status:** done. Shared helper `src/server/llm/core/parse-tool-args.ts`
(`parseToolArguments`) with tests in `parse-tool-args.test.ts`, wired into all nine stream
adapters (`openai-compatible`, `xai`, `openrouter`, `deepseek`, `moonshot`, `minimax`,
`openai-key`, `openai-codex`, `_anthropic-shared`). The id/name-less drop was also fixed:
a call with a name but no `id` now gets a synthesized `call_${index}` id instead of being
discarded. Recovery is conservative (fence strip, balanced-span extraction, trailing-comma
removal, closing unterminated strings/brackets); it never rewrites quotes or values, and
still falls back to `{ _raw }` when nothing parses.

**What:** Replace the bare `JSON.parse` / `{ _raw }` fallback with a tolerant pipeline:
strip ` ```json ` fences, extract the first balanced `{...}` span, run a small repair pass
(close brackets, fix quotes, drop trailing commas), then `JSON.parse`. Only if that still
fails, wrap as `{ _raw }`.

**Where:** the duplicated block at `openai-compatible.ts:407-418` and its twins
(`xai.ts:430`, `openrouter.ts:471`, `deepseek.ts:406`, `moonshot.ts:503`,
`minimax.ts:565`, `openai-key.ts:381`, `openai-codex.ts:455`, `_anthropic-shared.ts:363`).
This duplication should be factored into one shared helper (e.g. a new
`src/server/llm/core/parse-tool-args.ts`) and called from every provider. Also reconsider
the silent `if (!state.id || !state.name) continue` drop (`openai-compatible.ts:408`):
synthesize a fallback `id` when the backend omits it so the call is not lost.

**Impact:** High. Directly fixes the most common local-model symptom (fenced / slightly
malformed args). **Effort:** Low (vendor a small repair routine or port `json_repair`;
one helper). **Risk:** Low; strictly more permissive than today. Add unit tests with real
broken-output fixtures.

### R2. Schema-validate tool args + bounded repair-retry (high impact, medium effort) — IMPLEMENTED

**Status:** done. `validateToolArgs` (`src/server/services/tool-arg-validation.ts`, with
tests) runs in `executeSingleTool` before the tool executes: malformed arguments are
rejected with a precise, model-facing error (the offending field paths) instead of the
tool failing deep inside `execute`. The `{ _raw }` salvage from R1 is caught explicitly
(`isRawToolArgs`) with a "not valid JSON" message. Two deliberate scoping choices: (1) only
Zod schemas are validated (every native tool has one; MCP / custom tools with a plain JSON
Schema are skipped, since the host ships no JSON-Schema validator and they validate their
own input); (2) secret-expanding tools are skipped, because a `{{secret:...}}` placeholder
can fail a refinement like `.url()` before the real value is substituted. No separate
retry loop or new config was added: the existing multi-step agent loop already re-prompts
after a tool error, so a rejected call becomes the repair-retry, bounded by the existing
`config.tools.maxSteps`. Rejections are logged at debug for measuring small-model impact.

**What:** Before executing a tool, validate the parsed args against the tool's Zod schema
(`asSchema` already has the schema). On failure, do a bounded re-prompt: feed the model
the validation error and ask it to re-emit the call, N times (small N, e.g. 1 to 2) with
backoff, before surfacing an error. This is the Instructor pattern and the single biggest
lever against "tool argument rot."

**Where:** add validation in `executeSingleTool` (`tool-executor.ts:243-395`, before the
`execute` call at `:366`) using the registration's schema; add the repair loop in the
agent loop around `runStreamStep` / `executeToolBatch` (`agent-engine.ts:1627-1719`,
mirrored in the quick-session loop `:2378-2474` and `tasks.ts`). Today the only feedback
is the implicit tool-error path; this makes it explicit and bounded.

**Impact:** High. **Effort:** Medium (touches the shared loop; needs a retry budget
distinct from `config.tools.maxSteps`). **Risk:** Medium; must cap retries and avoid
infinite loops and token blow-ups. New config keys (see R6).

### R3. Constrained decoding when the backend supports it (highest ceiling, medium effort)

**What:** When the model emits a tool call, pass the backend's native structured-output
knob so invalid JSON is impossible:
- Ollama: `format` = the tool's JSON Schema.
- vLLM: `guided_json` (or set `tool_choice: "required"`, which auto-enables guided
  decoding), migrating to `structured_outputs`.
- llama.cpp: a GBNF `grammar` derived from the schema (llama-server can also do this from
  JSON Schema directly).
- OpenAI / compatible aggregators: `response_format: { type: "json_schema", ... }` where
  advertised.

**Where — the dialect is a server property, so configure it at the provider, not per
request.** The same weights run under Ollama, vLLM, or llama.cpp, each with a different
knob (§R3/R4 boundary above), and that choice never changes for the life of a provider.
So it belongs in the openai-compatible provider config, set once when the provider is
added, ideally auto-detected with a manual override. Three pieces:

1. **A `backend` config field** in `CONFIG_SCHEMA` (`openai-compatible.ts:74`), values
   `auto` (default) / `ollama` / `vllm` / `llamacpp` / `openai` / `none`. Note: the SDK's
   `ConfigField` union (`packages/sdk/src/index.ts:628-663`) today only has `secret` /
   `path` / `url` / `text` — there is **no `select` type**. So this needs either a new
   `select` variant in the union (plus its UI renderer) or, cheaper, a `text` field with
   documented allowed values. Small decision, flagged below.
2. **Auto-detection at connection time.** `authenticate()` (`openai-compatible.ts:439-466`)
   already probes `GET /models` as the reachability check; extend it to also fingerprint
   the backend (Ollama `/api/version` at the host root, llama.cpp `/props`, vLLM's
   `/version` or the `owned_by` shape from `/models`). One caveat: `authenticate()` returns
   only `AuthResult` (`valid` / `error`) and does not write config, so persisting the
   detected value needs a path back into the saved config (simplest: the UI runs detection
   and pre-fills the `backend` field, leaving it user-editable).
3. **Read it in `chat()`.** `chat(model, request, config)` (`openai-compatible.ts:493`)
   already receives `config` and reads `config['baseUrl']` / `config['apiKey']`, so
   selecting the knob from `config['backend']` is a local change with **no per-request SDK
   plumbing** (no `ChatRequest` field needed). On `auto` with no detection, or on a `400`
   from a wrong knob, fall back silently to plain mode (then R1/R2 catch the rest).

This unifies the earlier A/B/C options into one UX: auto-detect by default, user-correctable,
safe fallback — and it rescues local models models.dev cannot identify, because we still
know the *server* even when we know nothing about the *model*.

**Impact:** Highest ceiling (Ollama reports near-100% parse success). **Effort:** Medium
(per-backend knob handling reintroduces some vendor-specific surface the file was written
to avoid, but it is contained to one config field + `authenticate` + `chat`, with no
SDK/request plumbing). **Risk:** Medium; a wrong knob is a `400`, mitigated by the `auto`
fallback. Pair with R1/R5 as the safety net. **Needs a product decision** (see below) on
adding backend awareness to the generic provider and on the `select`-vs-`text` field shape.

### R4. Per-model reliability profile / capability flags (enabler, medium effort)

**What:** Extend the model capability metadata so the strategy is picked automatically:
`supportsNativeTools`, `supportsJsonMode` / `structuredOutputMode`
(`none|response_format|ollama_format|vllm_guided|gbnf`), `preferPromptToolProtocol`,
`recommendedTemperature`, plus the existing `contextWindow` / `maxTools`. Default
unknown/local models to the conservative, most-tolerant strategy.

**Where:** `LLMModel` flags (`packages/sdk/src/index.ts:881-937`); model classification in
each provider's `listModels` / classifier and `model-registry.ts` (models.dev). Today only
`maxTools` affects what is sent; this is the hook that makes R3/R5 automatic instead of
manual.

**Impact:** Medium on its own; **multiplier** for R3 and R5. **Effort:** Medium. **Risk:**
Low. **Product decision:** whether profiles are inferred, user-overridable, or both.

#### Why R3 and R4 are two separate efforts: model capability vs backend dialect

R3 (constrained decoding) and R4 (capability profiles) look like one problem but are not,
and the reason is what our metadata source can and cannot know. Verified against the
`models.dev` schema (`models.dev/api.json`):

models.dev describes the **model**, and it does carry the capability flags R4 needs:

- `tool_call` (bool) — does the model do native function-calling
- `structured_output` (bool) — does it support a JSON / structured-output mode
- `temperature` (bool), `reasoning`, `reasoning_options`, `modalities`, `limit.context`,
  `cost`, etc.

Today Hivekeep ingests only a subset (`model-registry.ts`, `PINNABLE_FIELDS`:
`contextWindow`, `maxOutput`, `supportsImageInput`, `supportsPdfInput`,
`supportsToolCall`, `thinking`, `pricing`). **`structured_output` is available upstream
but not ingested.** Reading it is a near-free win for R4: it tells us, per model, whether
constraining is even worth attempting. `tool_call` already maps to `supportsToolCall`
(via `apiSeedFromModel`, `maxTools === 0`).

What models.dev **cannot** give us is the backend dialect R3 needs (`format` vs
`guided_json` vs `grammar`), and this is structural, not an omission. **The dialect is a
property of the inference server, not the model.** The same `gemma-12b` weights run under
Ollama, vLLM, or llama.cpp, each with a different knob. models.dev keys metadata to the
model and puts protocol info at the provider level (`api` / `npm` fields), never per
model. So no model-metadata source can tell us which server is answering.

Two further consequences for our exact audience:

- For a custom local tag (a `gemma-12b` pulled into Ollama), models.dev often has **no
  matching entry** or only a low-confidence match, so even the model-level flags may be
  absent. The default for unmatched models must be the conservative, most-tolerant
  strategy (native off / repair-heavy), not an optimistic one.
- Therefore R4 (the "what can this model do" axis, partly answerable from models.dev) and
  R3 (the "which server am I talking to" axis, only answerable by backend detection:
  probe `/api/version`, an explicit config field, or try-and-fallback) are independent and
  must ship as separate work. R4 can land from metadata alone; R3 cannot proceed without
  backend detection regardless of how complete the model metadata is.

| Question | Answerable from models.dev? |
|---|---|
| Does this model do native tool calls? | Yes (`tool_call`, already ingested as `supportsToolCall`) |
| Does this model support a JSON / structured-output mode? | Yes (`structured_output`, **not yet ingested**) |
| Which structured-output knob to send (Ollama / vLLM / llama.cpp)? | **No, and structurally cannot** — it is a server property, needs backend detection |

### R5. Prompt-based tool-call fallback for weak native function-calling (high impact, high effort)

#### Why an alternative protocol exists, and its limits

Worth being explicit, because it explains why R5 is a fallback and not the plan A. "Native
function-calling" is not a token-level model capability; it is three things that must
align: the model was **trained** on a specific tool-call format, the inference server
**injects** the tools using that model's chat template, and the server **re-parses** the
output back into structured `tool_calls`. On Claude / GPT all three are rock-solid. On a
local stack all three are outside our control and often broken: small models are weakly
trained for tools, the bundled chat template may be generic or wrong, and the
OpenAI-compat shim's parser is immature (it is what drops id-less calls at
`openai-compatible.ts:408`). When any link breaks server-side, Hivekeep receives only
empty or garbage output and cannot even see what the model attempted.

A prompt-based protocol moves the format and the parsing **into the application**: we spell
out the call format in the prompt as plain text and parse it ourselves with tolerant logic.
That buys four things: we control the format (no dependency on special tokens or the
server template), we control the parser (the flaky server-side `tool_calls` accumulator is
bypassed), it degrades gracefully (the text always arrives as content, so the
"prose-as-final-answer" loss becomes a parseable call), and it is universal (any
instruction-following model can emit a text format, whereas native works only on models
trained for it).

The honest catch: Hermes works largely because its models are **trained** on that exact
`<tool_call>` format. The win is "a format the model knows + a parser we control", not
"text beats native" in the abstract. An untrained model (a random Gemma) is trained on
neither native tools nor our text format, so a text protocol alone is not magic for it.
And it has costs: it spends prompt tokens spelling out every tool signature (heavy on a
small context window), it needs carefully chosen delimiters to avoid colliding with
legitimate content, and it produces free text unless paired with constrained decoding
(R3). So the value is conditional: highest as a targeted fallback for models/servers where
native is broken or absent, or for models already trained on an emittable text format
(Hermes, some Qwen). For a model trained on neither, **R3 (server-side constrained
decoding) is the stronger lever**, since it forces validity without depending on the
model's training. This is why R5 is gated behind R4 and never the default.

**What:** A selectable Hermes-style protocol: list tool signatures in the system prompt
and instruct the model to emit `<tool_call>{...}</tool_call>`; parse that delimited block
from the text stream instead of relying on native `tool_calls`. Selectable per
provider/model via R4 (`preferPromptToolProtocol`). This also rescues the
"prose-as-final-answer" failure (`stream-runner.ts:341-367`), because narrated calls
become parseable.

**Where:** new emit path in the prompt builder (a tool-signature block, parallel to
`prompt-builder.ts:1130-1152`); new parse path in `stream-runner.ts` (detect and extract
`<tool_call>` spans from buffered text) feeding the same `tool-use` chunk shape; tool
attachment in `openai-compatible.ts` switches between native `tools` and prompt injection.

**Impact:** High for models that simply cannot do native tools. **Effort:** High (a
second tool channel end to end). **Risk:** Medium to high; needs careful testing so it
does not regress strong models. Gate strictly behind R4.

### R6. Tune sampling + scope the tool surface + size-check the prompt (medium impact, low/medium effort)

Three smaller, independent wins:

- **Sampling: IMPLEMENTED.** `toolTurnSampling` (`src/server/services/tool-sampling.ts`,
  with tests) pins `config.tools.temperature` (default `0`, env `TOOLS_TEMPERATURE`, `off`
  to defer to the backend) on tool-enabled turns, applied at all three request sites
  (`agent-engine.ts` main + quick-session, `tasks.ts`). Reasoning-capable models are
  exempted (they advertise `thinking.efforts`): OpenAI o-series 400 on a custom
  temperature and Anthropic requires 1 when thinking is on, while small/local models have
  no efforts and are exactly the ones helped. Still open as a product call: the default
  value and a user-facing override (deferred to R4's per-model profile).
- **Tool scoping:** for small models, reduce the surface to a relevant subset rather than
  the numeric `capTools` truncation (`agent-engine.ts:110-187`). Options: a relevance pass,
  smaller default toolboxes for local models, or a much lower `maxTools` default keyed off
  R4. Medium effort. Mirrors Odysseus's per-session tool toggling. The first cheap step is
  simply lowering the default `maxTools` for unknown/local models.
- **Prompt slimming + pre-call size check:** add a compact prompt variant (drop or shrink
  the ~5 to 6k-token `## Internal instructions` block, `prompt-builder.ts:1304-1436`) for
  small-context / small models, and compare estimated tokens
  (`estimateContextTokens`, `agent-engine.ts:613-677`) against `contextWindow` *before* the
  call to trim or warn, instead of only reacting to a provider error
  (`agent-engine.ts:466`, `:2028-2058`). Medium effort, low risk.

### Suggested sequencing

1. **R1** (tolerant parse + repair) and the **R6 sampling default** first: low effort,
   high immediate relief, no product decisions blocking R1.
2. **R2** (validate + repair-retry): the structural fix for argument rot.
3. **R4** (capability profiles) as the enabler, then **R3** (constrained decoding) for the
   backends that support it, with **R5** (prompt-based protocol) for the models that need
   it.
4. **R6 tool-scoping and prompt-slimming** alongside, since they help every tier.

### Decisions that need the maintainer / product

- Whether to add **backend awareness** to the deliberately vendor-neutral
  `openai-compatible.ts` (required for R3). The proposed shape is a `backend` provider
  config field, auto-detected at connection time with a manual override (see R3). Two
  sub-decisions: accepting some vendor-specific surface back into the file, and whether to
  add a `select` variant to the SDK `ConfigField` union or use a plain `text` field.
- Default **temperature / top_p** for tool turns, and whether users can override.
- Whether per-model **reliability profiles** (R4) are inferred, user-set, or both, and how
  much UI to expose.
- How aggressively to **scope the tool surface** for small models (a smaller default
  toolbox changes the out-of-box agent's capabilities).
- The **repair-retry budget** (R2) and its interaction with `config.tools.maxSteps` and
  per-turn token cost.

---

## Sources

- llama.cpp: [grammar & structured output](https://deepwiki.com/ggml-org/llama.cpp/8.1-grammar-and-structured-output) · [grammars/README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md) · [constrained decoding guide](https://www.aidancooper.co.uk/constrained-decoding/)
- vLLM: [structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/) · [tool calling](https://docs.vllm.ai/en/v0.8.3/features/tool_calling.html) · [Red Hat write-up](https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses)
- Ollama: [structured outputs blog](https://ollama.com/blog/structured-outputs) · [docs](https://docs.ollama.com/capabilities/structured-outputs) · [Instructor + Ollama](https://python.useinstructor.com/integrations/ollama/)
- Libraries: [json_repair](https://github.com/mangiucugna/json_repair) · [llm-json-repair](https://github.com/gcrabtree/llm-json-repair) · [structured output libraries ranked](https://techsy.io/en/blog/best-llm-structured-output-libraries) · [BAML vs Instructor](https://www.glukhov.org/post/2025/12/baml-vs-instruct-for-structured-output-llm-in-python/) · [reliable structured output](https://mljourney.com/how-to-get-reliable-structured-output-from-llms/) · [resilient JSON handling](https://medium.com/@gtdevice/architecting-resilient-llm-interactions-a-definitive-guide-to-robust-json-handling-in-java-0caa6947ea73)
- Peers: [Hermes Agent](https://hermes-agent.nousresearch.com/) · [Hermes Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) · [Hermes JSON mode](https://deepwiki.com/NousResearch/Hermes-Function-Calling/3-json-mode-system) · [Odysseus](https://pewdiepie-archdaemon.github.io/odysseus/)
</content>
</invoke>
