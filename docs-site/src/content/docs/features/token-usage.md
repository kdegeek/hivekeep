---
title: Token Usage & Cost
description: "Track how many tokens your Agents burn and an estimated USD cost per model, provider, agent or day — from the Settings → Token Usage view."
---

Every LLM call Hivekeep makes is recorded — tokens in/out, cache reads/writes,
which model, provider, Agent, task or cron it belonged to, and when. The
**Settings → Token Usage** view (admin only) turns that into a readable picture
of where your tokens — and your money — go.

## What it shows

- **Summary cards** for the selected period: estimated **cost**, cache-hit
  tokens (with hit rate), non-cache input, output, and API-call count.
- **A daily sparkline** of input vs output tokens.
- **A breakdown table** grouped by **model**, **provider**, **agent**, **call
  site**, or **day** — each row showing cache-hit / non-cache / output tokens,
  cache-hit %, **cost**, and call count.
- **A detail table** of individual requests (date, agent, model, call site,
  tokens, steps), paginated.

Filter by **period** (24h / 7d / 30d / all), **agent**, and **provider**.

## How cost is estimated

Cost combines recorded token counts with the per-model pricing from the
[Model Registry](/docs/providers/model-registry/) (sourced from models.dev):

```
cost = (input × inputPrice
      + output × outputPrice
      + cacheRead × cacheReadPrice
      + cacheWrite × cacheWritePrice) ÷ 1,000,000
```

(Prices are USD per million tokens.)

### The price is frozen at call time

When a call is recorded, its cost is computed **at the price in effect then and
stored on the row**. A later price change — or a [snapshot refresh](/docs/providers/model-registry/#keeping-it-fresh)
— **never rewrites past costs**; your history stays faithful to what each call
would have cost when it ran. Usage recorded before this feature existed is
backfilled **once** at the then-current price (a best-effort estimate for the
past); everything after is exact-at-call.

## Caveats

It's a **spend estimate, not an invoice**:

- **Cache accounting** assumes the provider reports the non-cached prompt
  separately and prices cache reads/writes at their own rate (Anthropic-style).
  Providers that bundle cache tokens differently may skew slightly.
- **Models with no pricing** in the registry (or whose provider was deleted)
  show no cost — never a fake `$0`. Fix this by mapping/pricing the model in the
  registry, or refreshing the models.dev snapshot.
- Reasoning tokens are counted within output tokens (not double-charged).

## Reducing cost

| Tip | Impact |
|---|---|
| Use a smaller model (e.g. Haiku) for simple, single-step crons | 5–10× cheaper than a flagship |
| Lean on prompt caching (high cache-hit %) | Cache reads are a fraction of fresh input |
| Filter webhook payloads so Agents skip irrelevant events | Fewer runs |
| Keep task descriptions concise; store results in memory, not long outputs | Fewer input tokens per run |

See [Model Selection](/docs/guides/model-selection/) for picking the right model
per Agent, and the [Model Registry](/docs/providers/model-registry/) for editing
or disabling models.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/usage` | Paginated individual usage records + totals (incl. cost). |
| `GET` | `/api/usage/summary?groupBy=…` | Aggregated usage + cost, grouped by `model_id` / `provider_type` / `agent_id` / `call_site` / `day`. |
