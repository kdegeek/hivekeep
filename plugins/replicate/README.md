# 🦜 Replicate plugin for KinBot

Brings [Replicate](https://replicate.com)-hosted models to KinBot via a single API token. One plugin contributes **all three native provider families**:

| Family | Models |
|---|---|
| **LLM** | `meta/meta-llama-3-8b-instruct`, `meta/meta-llama-3-70b-instruct`, `mistralai/mixtral-8x7b-instruct-v0.1`, `mistralai/mistral-7b-instruct-v0.2` |
| **Image** | `black-forest-labs/flux-schnell`, `black-forest-labs/flux-dev`, `stability-ai/stable-diffusion-3.5-medium` |
| **Embedding** | `replicate/all-mpnet-base-v2` |

## Setup

1. Grab an API token from [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens).
2. In KinBot, go to **Settings → Providers → Add provider**, pick **Replicate**, paste the token.
3. Save. KinBot creates one provider row per family (LLM, Image, Embedding) — all share the same token.

## What this plugin demonstrates

This plugin doubles as a real-world reference for [`@kinbot-developer/sdk`](https://www.npmjs.com/package/@kinbot-developer/sdk):

- **Three native providers in one plugin.** Same SDK contract as Anthropic / OpenAI built-ins — `LLMProvider`, `ImageProvider`, `EmbeddingProvider` from `@kinbot-developer/sdk`.
- **Curated `listModels()`.** Replicate hosts tens of thousands of models — the plugin ships a hand-picked list rather than dumping everything.
- **`ctx.http.fetch` everywhere.** No raw `globalThis.fetch`. The manifest's `http:api.replicate.com` and `http:replicate.delivery` permissions are enforced + audited by KinBot.
- **No KinBot-internal imports.** The whole module graph imports from `@kinbot-developer/sdk` only — exactly what a third-party plugin published on npm would look like.

## Caveats

- **Not streamed.** The current implementation uses Replicate's `Prefer: wait` sync mode and emits the whole response as one `text-delta` followed by `finish`. Real SSE streaming is a follow-up.
- **No tool calling.** Replicate-hosted open models don't have a uniform tool-calling format, so this provider doesn't advertise tools. Use the built-in Anthropic / OpenAI providers if your Kin needs tool use.
- **Async generation is bounded.** Image generation can exceed the 60s `Prefer: wait` window; the plugin then polls for up to 5 minutes before giving up.

## Tests

`bun test ./plugins/replicate` — 14 unit tests cover the LLM streaming shape, image download flow, embedding output normalisation, and permission auditing through `ctx.http.fetch`.
