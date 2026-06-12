---
title: Adding Custom Providers
description: Extend Hivekeep with custom AI providers via plugins.
---

Beyond the built-in providers, you can ship your own through the **plugin system**. Plugin providers register into the same four native registries as built-ins (LLM, embedding, image, search) and appear alongside them in the Settings UI — there is no second-class plugin shape.

This page is a quick orientation. The full author guide is on the [Developing Plugins](/docs/plugins/developing/) page, including a complete `SearchProvider` example.

## When you need a plugin

- **Proprietary or internal endpoints** — your own model server, an internal RAG service.
- **Specialized search APIs** not shipped as a built-in (Kagi, You.com, Exa, …).
- **Embedding or image services** not in the built-in set.
- **OpenAI-compatible endpoints with custom auth** that the built-in OpenAI provider's base-URL override can't cover.

If your endpoint is plainly OpenAI-compatible (vLLM, llama.cpp server, LocalAI, …), point the built-in OpenAI provider at it with a custom Base URL instead — no plugin needed.

## Provider shape

A plugin exports a `providers` array. Each entry implements one of the four native SDK interfaces (`LLMProvider`, `EmbeddingProvider`, `ImageProvider`, `SearchProvider`) — the same interfaces the built-in Anthropic / OpenAI / Brave / Tavily providers implement.

```typescript
// In your plugin's main file
import type { SearchProvider, PluginContext } from '@hivekeep/sdk'

class MySearchProvider implements SearchProvider {
  readonly type = 'my-search'
  readonly displayName = 'My Search Service'
  readonly apiKeyUrl = 'https://my-service.example/keys'
  readonly configSchema = [
    { key: 'apiKey', type: 'secret', label: 'API key', required: true },
  ] as const
  readonly capabilities = {
    supportsAnswer: false,
    supportsFreshness: true,
    supportsDomainFilter: false,
    supportsLanguage: true,
    supportsLocation: false,
  }

  async authenticate(config) { return { valid: true } }
  async search(request, config) { return { results: [] } }
}

export default function (ctx: PluginContext) {
  return { providers: [new MySearchProvider()] }
}
```

The plugin loader inspects which method each provider exposes (`chat` → LLM, `embed` → embedding, `generate` → image, `search` → search) and registers it into the matching registry. The provider's `type` is prefixed internally to `plugin:<your-plugin-name>:<type>` so it can't collide with built-ins.

Once your plugin is enabled, the provider appears in **Settings > Providers** and Agents can use it through the standard tools (`web_search`, `generate_image`, etc.) — no further wiring needed on the host side.

## OpenAI-Compatible Endpoints

Many self-hosted solutions expose an OpenAI-compatible API. For these, you can often use the built-in **OpenAI** provider with a custom base URL, without needing a plugin:

1. Go to **Settings > Providers > OpenAI**
2. Set the **Base URL** to your endpoint (e.g., `http://localhost:8000/v1`)
3. Set the API key if required

This works with vLLM, llama.cpp server, LocalAI, and other OpenAI-compatible services.
