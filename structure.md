# KinBot — Structure du projet

Monorepo avec frontend, backend, SDK plugin et plugins de référence dans le même dépôt, servi par un seul process Bun (pour le runtime) et un seul workspace `bun` (pour le tooling). Le résultat se déploie en un container Docker unique.

> **À jour pour KinBot 2.0** (post-refactor providers/SDK/plugins). Si une partie de l'arborescence diffère de la réalité, c'est ce fichier qui est obsolète — la réalité fait foi.

---

## Arborescence

```
kinbot/
├── package.json                       # Workspaces Bun (packages/*, plugins/*)
├── tsconfig.json
├── drizzle.config.ts
├── CLAUDE.md                          # Instructions agent + conventions
├── idea.md / api.md / schema.md / …   # Specs (voir CLAUDE.md > Documentation map)
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
│
├── packages/                          # Packages npm publiés
│   ├── sdk/                           # @kinbot-developer/sdk
│   │   ├── src/index.ts               # Surface publique (tools, channels, providers,
│   │   │                              #  hooks, cards, plugin context)
│   │   ├── README.md
│   │   └── examples/hello-kin/        # Plugin minimal de référence
│   └── create-kinbot-plugin/          # Scaffolder `bunx create-kinbot-plugin`
│
├── plugins/                           # Plugins maintenus dans le repo
│   ├── replicate/                     # Pilot — provider LLM/Image/Embedding via SDK
│   ├── twilio-sms/                    # ChannelAdapter SMS
│   ├── teamspeak/                     # ChannelAdapter TeamSpeak
│   └── home-automation/               # Plugin Home Assistant
│
├── src/
│   ├── server/                        # Backend (Bun + Hono)
│   │   ├── index.ts                   # Point d'entrée : Hono app + serve static
│   │   ├── app.ts                     # Configuration Hono (middleware, routes)
│   │   ├── config.ts                  # Configuration centralisée (env vars)
│   │   ├── logger.ts                  # Logger (pino)
│   │   │
│   │   ├── routes/                    # Routes API REST
│   │   │   ├── auth.ts, me.ts, kins.ts, messages.ts, …
│   │   │   ├── providers.ts           # CRUD providers + /:id/test + /:id/models
│   │   │   ├── plugins.ts             # CRUD plugins, manifest, permissions
│   │   │   ├── channel-*.ts           # Webhooks built-in (telegram, slack, signal, …)
│   │   │   └── sse.ts                 # GET /api/sse (connexion SSE globale)
│   │   │
│   │   ├── services/                  # Logique métier
│   │   │   ├── kin-engine.ts          # Orchestration LLM (contexte, appels, streaming)
│   │   │   ├── prompt-builder.ts      # Construction du prompt système
│   │   │   ├── queue.ts               # Queue FIFO par Kin
│   │   │   ├── compacting.ts          # Compacting des sessions
│   │   │   ├── memory.ts              # Mémoire long terme (extraction, recall, search)
│   │   │   ├── consolidation.ts       # Fusion automatique des memories proches
│   │   │   ├── image-generation.ts    # Génération d'image provider-agnostic
│   │   │   ├── vault.ts               # Coffre-fort de secrets (AES-256-GCM)
│   │   │   ├── plugins.ts             # Loader, hot-reload, permissions HTTP
│   │   │   ├── crons.ts, channels.ts, tasks.ts, contacts.ts, …
│   │   │   └── app-settings.ts        # Paramètres globaux persistants
│   │   │
│   │   ├── channels/                  # ChannelAdapters built-in
│   │   │   ├── adapter.ts             # Interface (cf. @kinbot-developer/sdk)
│   │   │   ├── telegram.ts, discord.ts, slack.ts, whatsapp.ts, signal.ts, matrix.ts
│   │   │
│   │   ├── llm/                       # Providers IA natifs (post-Vercel SDK)
│   │   │   ├── core/                  # resolve, run-oneshot, types partagés
│   │   │   ├── llm/                   # Providers chat
│   │   │   │   ├── anthropic-key.ts, anthropic-oauth.ts
│   │   │   │   ├── openai-key.ts, openai-codex.ts
│   │   │   │   ├── registry.ts, register.ts
│   │   │   │   └── _shared / _auth helpers
│   │   │   ├── embedding/             # Providers embeddings
│   │   │   │   └── openai.ts + registry/register
│   │   │   └── image/                 # Providers image generation
│   │   │       └── openai.ts + registry/register
│   │   │
│   │   ├── providers/                 # Dispatcher provider-agnostic
│   │   │   ├── index.ts               # listModelsForProvider, lookupImageModel,
│   │   │   │                          #  describeImageModel, testProviderConnection
│   │   │   └── ADDING_PROVIDERS.md
│   │   │
│   │   ├── tools/                     # Outils natifs exposés aux Kins
│   │   │   ├── index.ts, register.ts, types.ts
│   │   │   ├── memory-tools.ts, contact-tools.ts, history-tools.ts
│   │   │   ├── inter-kin-tools.ts, task-tools.ts, subtask-tools.ts
│   │   │   ├── cron-tools.ts, webhook-tools.ts, vault-tools.ts
│   │   │   ├── filesystem-tools.ts, grep-tools.ts, multi-edit-tools.ts
│   │   │   ├── shell-tools.ts, custom-tool-tools.ts
│   │   │   ├── image-tools.ts         # list_image_models, describe_image_model,
│   │   │   │                          #  generate_image
│   │   │   └── provider-tools.ts      # list_providers, list_models
│   │   │
│   │   ├── db/                        # SQLite + Drizzle
│   │   │   ├── index.ts               # Connexion (bun:sqlite, sqlite-vec, FTS5)
│   │   │   ├── schema.ts              # Schéma Drizzle (toutes les tables)
│   │   │   └── migrations/            # Migrations générées par drizzle-kit
│   │   │
│   │   ├── auth/                      # Better Auth
│   │   ├── sse/                       # Server-Sent Events
│   │   ├── hooks/                     # Event bus + hook system
│   │   ├── mini-app-sdk/              # SDK consommé par les mini-apps des Kins
│   │   ├── utils/                     # Helpers transverses
│   │   └── assets/                    # Assets statiques (base avatar, etc.)
│   │
│   ├── client/                        # Frontend (React + Vite)
│   │   ├── main.tsx, App.tsx
│   │   ├── pages/                     # Pages (dashboard, settings, design-system, …)
│   │   ├── components/                # Composants (ui/, sidebar/, chat/, kin/, …)
│   │   ├── hooks/                     # Hooks React custom
│   │   ├── contexts/                  # Contexts (theme, palette, …)
│   │   ├── lib/                       # Utilitaires client (api, i18n, …)
│   │   ├── locales/                   # Traductions i18n (en, fr)
│   │   └── styles/                    # CSS (Tailwind + design tokens)
│   │
│   └── shared/                        # Code partagé client/serveur
│       ├── types.ts, constants.ts
│       ├── provider-metadata.ts       # PROVIDER_META (display name, capabilities, ...)
│       ├── model-ref.ts               # Parsing providerId:modelId
│       ├── model-context-windows.ts   # Fallback context-window estimates
│       ├── billing.ts                 # Pricing helpers
│       └── contact-display.ts         # Format display names
│
├── docs-site/                         # Documentation publique (Astro + Starlight)
├── site/                              # Site marketing
│
└── data/                              # Données persistantes (gitignored)
    ├── kinbot.db (+ -shm / -wal)
    ├── uploads/                       # Pièces jointes utilisateur
    ├── workspaces/                    # Workspaces des Kins (filesystem isolé)
    ├── mini-apps/                     # Fichiers des mini-apps
    ├── storage/                       # File storage partagé
    ├── browser-states/                # Profils navigateur du tool browser
    └── vault/                         # Pièces jointes du coffre-fort
```

## Conventions

- **Imports** : alias absolus `@/server/...`, `@/client/...`, `@/shared/...`. Plugins consomment uniquement `@kinbot-developer/sdk`.
- **Naming** : `kebab-case.ts` pour les modules, `PascalCase.tsx` pour les composants React, `snake_case` pour les tables SQL.
- **Tests** : co-localisés (`foo.test.ts` à côté de `foo.ts`). Lancés via `bun run test`.
- **Provider agnostic core** : le core (tout sauf `src/server/llm/{provider}/` et `plugins/`) ne doit jamais brancher sur un nom de provider. Les capacités spécifiques sont déclarées par le provider lui-même (cf. `LLMProvider.defaultMaxTools`, `LLMProvider.billing`, `ImageProvider.describeModel`).
- **Migrations Drizzle** : immutables une fois shippées. `bun run db:generate` + `bun run db:migrate`. Pas de `db:push`.
