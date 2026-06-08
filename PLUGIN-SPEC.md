# Hivekeep Plugin Spec

This document used to be the canonical plugin specification. It has been **superseded by the developer guide on the docs site**:

→ **[Developing Plugins](https://marlburrow.github.io/hivekeep/docs/plugins/developing/)**

That page covers everything a plugin author needs:

- The manifest (`plugin.json`)
- The `ctx` API (`log`, `storage`, `http`, `vault`, `cards`, typed `config`)
- Tools, channels, providers (native `LLMProvider` / `EmbeddingProvider` / `ImageProvider`)
- Hooks (with typed payloads per hook name)
- Cards (`PluginCardPrimitive` + `card.*` builders)
- Lifecycle, local testing, publishing

The doc tree on the site (`docs-site/src/content/docs/plugins/`) is the single source of truth. This file is kept only so old links resolve.
