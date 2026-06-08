# Hivekeep Plugin Development

This guide has moved. The CommonJS-era content that used to live here is obsolete and contradicted the current `@hivekeep/sdk`. The plugin docs now live on the docs site:

- **[Plugins Overview](https://marlburrow.github.io/hivekeep/docs/plugins/overview/)**: what a plugin is and the extension points (tools, providers, channels, hooks, cards).
- **[Developing Plugins](https://marlburrow.github.io/hivekeep/docs/plugins/developing/)**: the canonical, step-by-step guide (manifest, `ctx` API, typed config, publishing).
- **[Plugin API Reference](https://marlburrow.github.io/hivekeep/docs/plugins/api/)**: the `@hivekeep/sdk` type surface.
- **[Tutorial: Mistral Provider](https://marlburrow.github.io/hivekeep/docs/plugins/tutorial-mistral/)**: a real, multi-capability provider plugin walked end to end.

The doc tree on the site (`docs-site/src/content/docs/plugins/`) is the single source of truth; this file is kept only so old links resolve.

## Fastest way to start

Scaffold a plugin, then read the generated code alongside the docs above:

```bash
bunx create-hivekeep-plugin
```

A complete, correctly branded reference plugin that exercises every extension point ships with the SDK at `packages/sdk/examples/hello-agent`.
