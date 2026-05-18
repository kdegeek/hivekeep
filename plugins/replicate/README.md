# 🦜 Replicate plugin for KinBot

Brings [Replicate](https://replicate.com)-hosted models to KinBot via a single API token. One plugin contributes **all three native provider families** — LLM, Image, and Embedding. The catalogue is sourced from Replicate's own curated collections (`language-models`, `text-to-image`, `embedding-models`), **not** a hardcoded list in this plugin — when Replicate adds or retires a model, KinBot sees the change on the next `listModels()` call.

## Setup

1. Grab an API token from [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens).
2. In KinBot, go to **Settings → Providers → Add provider**, pick **Replicate**, paste the token.
3. Save. KinBot creates one provider row per family (LLM, Image, Embedding) — all share the same token.

## What this plugin demonstrates

This plugin doubles as a real-world reference for [`@kinbot-developer/sdk`](https://www.npmjs.com/package/@kinbot-developer/sdk):

- **Three native providers in one plugin.** Same SDK contract as Anthropic / OpenAI built-ins — `LLMProvider`, `ImageProvider`, `EmbeddingProvider` from `@kinbot-developer/sdk`.
- **`listModels()` reads Replicate's collections.** No hardcoded model IDs in the plugin; the catalogue stays in sync with what Replicate curates upstream. Per-model metadata (max output tokens, image-input support) is read from each model's OpenAPI schema when available, left undefined otherwise.
- **`ctx.http.fetch` everywhere.** No raw `globalThis.fetch`. The manifest's `http:api.replicate.com` and `http:replicate.delivery` permissions are enforced + audited by KinBot.
- **No KinBot-internal imports.** The whole module graph imports from `@kinbot-developer/sdk` only — exactly what a third-party plugin published on npm would look like.

## Caveats

- **Not streamed.** The current implementation uses Replicate's `Prefer: wait` sync mode and emits the whole response as one `text-delta` followed by `finish`. Real SSE streaming is a follow-up.
- **No tool calling.** Replicate-hosted open models don't have a uniform tool-calling format, so this provider doesn't advertise tools. Use the built-in Anthropic / OpenAI providers if your Kin needs tool use.
- **Async generation is bounded.** Image generation can exceed the 60s `Prefer: wait` window; the plugin then polls for up to 5 minutes before giving up.

## Tests

`bun test ./plugins/replicate` — 14 unit tests cover the LLM streaming shape, image download flow, embedding output normalisation, and permission auditing through `ctx.http.fetch`.
