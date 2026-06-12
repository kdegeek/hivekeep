---
title: Plugin Registry
description: Discover and install Hivekeep plugins published to npm via the hivekeep-plugin keyword.
---

Hivekeep has no central server-side plugin store. Instead, discovery is decentralized: any package published to **npm** with the `hivekeep-plugin` keyword shows up in the in-app registry, and installs happen straight from npm. This keeps the catalog open. Anyone can publish a plugin, and there is no gatekeeper to approve listings.

## How Discovery Works

When you open **Settings → Plugins → Browse**, Hivekeep queries the public npm registry for every package tagged with the `hivekeep-plugin` keyword:

```
https://registry.npmjs.org/-/v1/search?text=keywords:hivekeep-plugin
```

Each result is enriched best-effort from the package's `plugin.json` (served via unpkg) to pull its display name and logo. Results already installed on your instance are flagged so you can tell them apart at a glance. Search results are cached briefly per query, and a refresh control re-queries npm on demand.

Adding free-text alongside the keyword narrows the search, so `keywords:hivekeep-plugin weather` finds weather-related plugins.

## Publishing So Others Can Find Your Plugin

To make a plugin discoverable in the registry, publish it to npm with the keyword in its `package.json`:

```json
{
  "name": "my-hivekeep-plugin",
  "version": "1.0.0",
  "keywords": ["hivekeep-plugin", "hivekeep"],
  "peerDependencies": {
    "@hivekeep/sdk": "^0.10.0"
  }
}
```

The scaffolder (`bunx create-hivekeep-plugin`) sets the keyword for you. See [Developing Plugins](/docs/plugins/developing/) for the full build-and-publish workflow.

## Installing

Plugin management is admin-only. From **Settings → Plugins** an admin can:

| Method | How | Use Case |
|--------|-----|----------|
| **npm registry** | Browse → search → Install | Published plugins (tagged `hivekeep-plugin`) |
| **Git URL** | Install from URL | Unpublished, private, or in-development plugins |
| **Manual** | Drop a folder into `plugins/` | Local development |

Installing from the registry runs `npm install` for the chosen package inside an isolated workspace, validates its `plugin.json`, checks host-version compatibility, then activates it. Updates are detected by comparing the installed version against the latest published version on npm.

## Next Steps

- [Plugins Overview](/docs/plugins/overview/): what plugins can do and how they are managed
- [Developing Plugins](/docs/plugins/developing/): build and publish your own
- [Plugin API](/docs/plugins/api/): full API reference
