# KinBot — Email accounts

Connect email accounts so Kins can **read** (list / read / search) and **send**
mail. v1 ships **Gmail** only, but email is a first-class, pluggable **provider
family** — adding Microsoft / IMAP / Proton later is one `EmailProvider`
implementation, no core refactor.

## Model: an email account *is* a provider row

An email account is a row in the `providers` table with capability `email`
(no new table, no migration):

| Column | Email account |
|---|---|
| `type` | `'gmail'` (later `'microsoft'`, `'imap'`, `plugin:x:proton`) |
| `name` | label (defaults to the address) |
| `slug` | stable id used by tools (`gmail-perso`, `gmail-pro`) |
| `capabilities` | `["email"]` |
| `config_encrypted` | `{ email_address, refresh_token, scopes, send_mode, allowed_kin_ids }` |

Multi-account falls out for free: several rows of the same `type`. Credentials
never leave the encrypted config — the tools resolve an account, inject a fresh
access token, and hand the provider only what it needs.

## Provider family (SDK)

`EmailProvider` lives in `@kinbot-developer/sdk`, alongside `LLMProvider` /
`SearchProvider`. The host detects the family by the presence of
`sendMessage` + `listMessages` (`detectProviderFamily` in `plugins.ts`), so a
plugin contributes an email provider exactly like any other provider.

```ts
interface EmailProvider extends ProviderUIHints {
  type: string                  // 'gmail'
  displayName: string
  configSchema: ProviderConfigSchema   // password/IMAP fields; empty for pure-OAuth
  capabilities: EmailCapabilities      // supportsOAuth / ServerSearch / Labels / Threads
  oauth?: OAuthProfile                 // endpoints + scopes; the host runs the OAuth2 dance
  authenticate(config): Promise<AuthResult>
  listMessages(opts, config): Promise<EmailListResult>
  getMessage(id, config): Promise<EmailFull>
  searchMessages?(query, config): Promise<EmailSummary[]>
  sendMessage(params, config): Promise<SendEmailResult>
}
```

Registry: `src/server/email/registry.ts` (`register/get/list/unregister`),
mirroring the other families. Built-ins register at boot via
`registerBuiltinEmailProviders()` (`src/server/email/register.ts`).

## OAuth (the only net-new infra)

The host owns a single generic OAuth2 authorization-code flow
(`src/server/services/oauth.ts`). A provider declares **only** its endpoints +
scopes (`oauth` profile); the host never bakes in provider-specific OAuth.

- **App credentials** (operator-level, per provider type): client id in
  `app_settings` (`oauth_client:<type>:client_id`), client secret in the
  **vault** (`oauth_client:<type>:secret`).
- **Connect**: `POST /api/email-accounts/connect/:type` → authorize URL →
  browser redirect → `GET /api/email-accounts/oauth/callback` → exchange code →
  store the account (refresh token in encrypted config) → redirect to
  `/?email_connected=<addr>`.
- **Token lifecycle**: `email-token-manager.ts` caches access tokens in memory
  per account and refreshes from the durable refresh token on demand. The
  provider only ever sees a fresh `config.accessToken`.

> ⚠️ **Operator setup**: create a Google Cloud OAuth app (Gmail scopes) and
> register the redirect URI `<host>/api/email-accounts/oauth/callback`. Google
> only allows `http` on `localhost`/loopback — a LAN IP needs `https`.

## Tools + toolbox

Native tools (`src/server/tools/email-tools.ts`), gated by the built-in `email`
toolbox:

| Tool | Flags | |
|---|---|---|
| `list_email_accounts` | readOnly, concurrencySafe | accounts this Kin may use |
| `list_emails` | readOnly | folder listing (summaries) |
| `read_email` | readOnly | full message by id |
| `search_emails` | readOnly | structured filters or `raw` provider query |
| `send_email` | destructive | send / reply in-thread, with attachments (workspace paths) |
| `download_email_attachment` | — | save an attachment to the workspace |

Each calls `resolveEmailProvider({ slug?, kinId })`: explicit slug → default
(`app_settings.default_email_provider_id`) → first valid; enforces the
per-account allow-list against the calling Kin; injects a fresh access token.

## Per-account settings

- **`send_mode`** (`direct` | `approval`) — `direct` sends immediately;
  `approval` queues the message in `pending_email_sends` + a notification, and the
  user approves (→ actually sends) or rejects it in Settings → Email accounts.
- **`allowed_kin_ids`** — `null`/empty = global (any Kin with the `email`
  toolbox); a non-empty list restricts the account to those Kins.

## UI

Settings → **Connections → Email accounts** (its own section, *not* the AI
Providers list). Per-provider connect card (configure the Google app creds, then
"Connect Gmail") + a card per connected account (address, status, send-mode,
disconnect).

## Adding a provider later

1. Implement `EmailProvider` (native in `src/server/email/providers/` or in a
   plugin's `providers: [...]`).
2. For OAuth, declare an `oauth` profile + configure its app credentials.
3. Done — registry, dispatcher, tools, toolbox, and UI are provider-agnostic.

## Config / env

| Key | Where | |
|---|---|---|
| `oauth_client:<type>:client_id` | app_settings | OAuth app client id |
| `oauth_client:<type>:secret` | vault | OAuth app client secret |
| `default_email_provider_id` | app_settings | account used when a tool omits `account` |

## Out of v1 (fast-follows)

Contacts / calendar ·
Microsoft / IMAP providers · agentic inbound (a light-model cron polling new
mail; push when the provider supports it).
