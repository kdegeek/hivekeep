---
title: Vault and secrets
description: "How Hivekeep stores secrets encrypted at rest, how Agents and plugins read them, and how secure input keeps API keys out of the conversation."
---

The Vault is where Hivekeep keeps anything sensitive: API keys, bot tokens, passwords, credentials a custom tool needs, and structured entries like logins or cards. Everything in the Vault is encrypted at rest, and secret values never enter the model at all: an Agent references a secret with a **placeholder** like `{{secret:GITHUB_TOKEN}}`, and Hivekeep substitutes the real value at the moment a tool executes. The Agent never sees, and never needs, the raw value.

## Why it matters

Your Agents act on your behalf. They send messages through Discord, call APIs, run scripts, and connect to providers. All of that needs credentials. Without a vault, those credentials would end up pasted into the chat, copied into the conversation history, and eventually swept into the compacted summaries the LLM sees on every turn. The Vault exists so that:

- Secrets live encrypted on disk, not in plaintext config files or in the message log.
- The model only ever handles placeholders. The real value is injected just before a tool runs (an HTTP call, a shell command, a file write) and scrubbed from the tool's output on the way back, so it never reaches the conversation history, the LLM provider, or your screen.
- If a secret does end up in the conversation (you pasted it, or it slipped through before being vaulted), the Agent can scrub every trace of it from the entire history with one call.

## How secrets are stored

Secrets are encrypted with **AES-256-GCM** before they touch the database. Each value gets a fresh random 12-byte IV, and the stored blob is `IV + ciphertext + authentication tag` encoded as base64. The same scheme encrypts file attachments (stored on disk as `.enc` files) and provider configurations.

### The encryption key

Encryption uses a single 256-bit key. Hivekeep resolves it in this order:

1. The `ENCRYPTION_KEY` environment variable, if set.
2. A persisted key file at `$DATA_DIR/.encryption-key` (where `$DATA_DIR` is your data directory, `HIVEKEEP_DATA_DIR`, default `./data`).
3. Otherwise Hivekeep generates a random key, writes it to `$DATA_DIR/.encryption-key` with `0600` permissions, and logs that it did so.

This means a fresh install just works: the first boot creates the key and reuses it on every subsequent start. You do not have to configure anything.

:::caution
The encryption key is not recoverable. If you lose it, every Vault secret, encrypted attachment, and provider config becomes permanently undecryptable. Back up `$DATA_DIR/.encryption-key` together with your database (`$DATA_DIR/hivekeep.db`), and keep them together: a database restored next to a different key is useless.
:::

### Pinning the key explicitly

For most single-host setups the auto-generated file is fine. You may want to pin `ENCRYPTION_KEY` instead when:

- You run Hivekeep in an environment where the data directory is ephemeral but your secrets manager is not (for example, injecting the key from a container orchestrator or a `.env` you control).
- You want the key kept outside the data directory entirely.

The value is a hex string. To generate one:

```bash
openssl rand -hex 32
```

Set it before the first boot, and keep it stable. Changing the key after secrets exist will make existing secrets fail to decrypt, because the old ciphertext was sealed with the old key.

:::note
`ENCRYPTION_KEY` doubles as the fallback for Better Auth's session secret when `BETTER_AUTH_SECRET` is not set. Rotating it therefore also invalidates active login sessions.
:::

## Managing the Vault from the UI

As an admin you manage Vault entries from **Settings, Vault**. You can:

- Create, edit, and delete entries.
- Choose an entry type. Built-in types are `text`, `credential`, `card`, `note`, and `identity`; you can also define custom types with their own field schema.
- Mark entries as favorites and search by key or description.
- See when each secret was last used by an Agent (stamped on every placeholder expansion).
- Attach files to an entry (encrypted at rest, with per-entry size and count limits, see [Configuration](/docs/getting-started/configuration/)).

A plain secret (the `text` type) is just a key and an encrypted value. Typed entries store a small JSON object of fields (encrypted as one blob) so a login can carry a username, URL, and password together.

## How Agents access secrets

Agents never see secret values. They learn that a secret exists by its key and description, and they use it through its placeholder:

1. The Agent calls `get_secret("GITHUB_TOKEN")` and receives `{{secret:GITHUB_TOKEN}}` (plus usage instructions), never the value.
2. It inserts the placeholder verbatim in any tool argument: an HTTP header, a shell command, a file it writes.
3. Just before the tool executes, Hivekeep replaces the placeholder with the decrypted value. The substitution only happens for tools whose arguments leave the platform (HTTP, shell, file writes, custom tools, MCP tools); everywhere else the placeholder stays inert text, so a secret can never be smuggled into memories or notes that would re-enter the prompt later.
4. On the way back, the tool's result is scanned for the value (an `echo`, an API error that mirrors your auth header) and any occurrence is replaced by the placeholder again.

If a placeholder references a key that does not exist, the tool is not executed at all and the Agent gets an actionable error: Hivekeep fails closed rather than sending a literal placeholder over the network.

### Restricting where a secret can go

Each secret can carry two optional restrictions, set in the entry's edit form:

- **Tool restriction**: the list of tools allowed to expand this secret (for example only `http_request`). Any other tool referencing the placeholder is refused before it runs.
- **Host restriction**: the hosts the secret may be sent to by HTTP and browser tools (for example `api.github.com` or `*.example.com`). A request to any other host is refused before it fires.

This is the real defense against prompt injection: even if a malicious page convinces an Agent to send `{{secret:GITHUB_TOKEN}}` to an attacker's server, the placeholder is useless outside the secret's legitimate destination. Host restrictions only apply to tools with an identifiable target URL; to keep a secret away from the shell entirely, use the tool restriction.

Two derivation transforms are available where APIs need them: `{{secret:KEY|base64}}` (for example HTTP Basic auth) and `{{secret:KEY|urlencode}}` (query strings). Anything fancier belongs in a script that reads the secret from an environment variable.

### Revealing a value, with your approval

In the rare case where the placeholder genuinely cannot work, an Agent can call `reveal_secret(key, reason)`. You see an approval card with the Agent's reason; nothing happens until you decide. If you approve, the raw value is given to the model for **that turn only**, then automatically redacted from the history (including anything the value touched in tool calls during the turn; a crashed turn is cleaned up at the next boot). If you deny, the Agent is told not to ask again. This approval can never be bypassed or automated — a prompt-injected Agent cannot exfiltrate a value by politely asking for it.

For shell commands and scripts, the recommended pattern is environment variables, and Agents are taught it: write the script to read `process.env.GITHUB_TOKEN`, then run it with `GITHUB_TOKEN={{secret:GITHUB_TOKEN}} bun run script.ts`. The secret never appears in the script file or in the command the model wrote.

The full tool set available to a main Agent:

| Tool | What it does |
|---|---|
| `get_secret` | Returns the `{{secret:KEY}}` placeholder for a secret, never the value. |
| `search_secrets` | Search keys and descriptions. Returns metadata and placeholders only. |
| `create_secret` | Store a new plain secret. Errors if the key already exists. |
| `update_secret` | Replace the value of an existing secret. |
| `delete_secret` | Delete a secret the Agent created itself. It cannot delete a secret created by someone else. |
| `get_vault_entry` | Read a typed entry's fields by key. |
| `create_vault_entry` | Create a typed entry (text, credential, card, note, identity, or a custom type). |
| `create_vault_type` | Define a custom entry type with a field schema. |
| `get_vault_attachment` | Download an entry's attachment as base64. |
| `redact_secret_leak` | Scrub every occurrence of a vaulted secret's value from the whole history. |

### Scrubbing a leaked secret

If a secret value does end up in the conversation, the Agent calls `redact_secret_leak(key)` with the vault key (never the value). Hivekeep decrypts the value server-side and replaces every occurrence of it, across message contents, tool calls and results, and compacting summaries, in every conversation, with the placeholder. The cleanup is surgical: the rest of each message survives. Connected clients refresh immediately so the value disappears from screens too.

The flow when you paste a secret in chat: the Agent stores it with `create_secret`, then immediately calls `redact_secret_leak` so the pasted value vanishes from the history. Note that the value was already sent to the LLM provider for the turns where it was visible; scrubbing stops the bleeding from the next turn on.

## How plugins access secrets

Plugins get a scoped Vault through their SDK context (`ctx.vault`), built per plugin by name. The scoping rules:

- **Read is permissive.** `ctx.vault.getSecret(key)` reads any Vault key as-is. This lets a plugin read credentials that Hivekeep core stored for it (for example a channel token under a `channel_...` key).
- **Write, delete, and list are namespaced.** `setSecret`, `deleteSecret`, and `listKeys` are confined to a `plugin:<name>:` prefix. A plugin writing `oauth_refresh_token` actually stores `plugin:twilio-sms:oauth_refresh_token`. It cannot overwrite another plugin's secrets or those managed by core, and `listKeys()` returns only its own keys, with the prefix stripped off.

This keeps plugins isolated from each other while still letting them persist their own tokens (for example, an OAuth refresh token) across restarts.

## Secure input: keeping keys out of the chat

When setup needs a credential, Hivekeep does not ask you to paste it into the conversation where it would be logged. Instead an Agent (typically [Queenie](/docs/features/queenie/) during onboarding) opens a **secure popup**. You type the secret into the popup, the server stores it straight in the encrypted Vault or into an encrypted provider config, and the Agent only ever gets back a non-sensitive confirmation of whether it worked. These secure-input tools are admin-only because they create global resources:

- `request_provider_setup`: paste an AI or search provider API key, then auto-configure and test the provider. The key goes into the Vault, never to the LLM.
- `request_channel_setup`: paste a messaging channel token (for example a Discord or Telegram bot token), then create and activate the channel.
- `prompt_secret`: store an arbitrary secret in the Vault under a key (for example `GITHUB_TOKEN`) that a custom tool will later read.

In each case the Agent's turn ends when the popup opens and resumes only once you submit, so the secret never passes through the model.

## Related

- [Configuration](/docs/getting-started/configuration/) for the data directory, Vault attachment limits, and other environment variables.
- [Queenie, guided setup](/docs/features/queenie/) for the onboarding flow that uses secure input.
- [Native tools](/docs/agents/tools/) for the wider tool set Agents can call.
