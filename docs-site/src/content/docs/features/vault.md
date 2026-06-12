---
title: Vault and secrets
description: "How Hivekeep stores secrets encrypted at rest, how Agents and plugins read them, and how secure input keeps API keys out of the conversation."
---

The Vault is where Hivekeep keeps anything sensitive: API keys, bot tokens, passwords, credentials a custom tool needs, and structured entries like logins or cards. Everything in the Vault is encrypted at rest, and secret values never appear in an Agent's prompt or in the chat transcript. An Agent reads a secret only when it explicitly calls the `get_secret` tool, and even then it is told never to repeat the value back to you.

## Why it matters

Your Agents act on your behalf. They send messages through Discord, call APIs, run scripts, and connect to providers. All of that needs credentials. Without a vault, those credentials would end up pasted into the chat, copied into the conversation history, and eventually swept into the compacted summaries the LLM sees on every turn. The Vault exists so that:

- Secrets live encrypted on disk, not in plaintext config files or in the message log.
- The raw value is fetched on demand, used, and discarded, never persisted into the prompt.
- If you accidentally paste a secret into the chat, the Agent can move it into the Vault and redact the message.

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
- Attach files to an entry (encrypted at rest, with per-entry size and count limits, see [Configuration](/docs/getting-started/configuration/)).

A plain secret (the `text` type) is just a key and an encrypted value. Typed entries store a small JSON object of fields (encrypted as one blob) so a login can carry a username, URL, and password together.

## How Agents access secrets

Agents do not see secret values in their prompt. They only ever learn that a secret exists by its key and description. To use one, an Agent calls a Vault tool. The full set available to a main Agent:

| Tool | What it does |
|---|---|
| `get_secret` | Fetch a plain secret value by key. The Agent is instructed never to print it. |
| `search_secrets` | Search keys and descriptions. Returns metadata only, never values. |
| `create_secret` | Store a new plain secret. Errors if the key already exists. |
| `update_secret` | Replace the value of an existing secret. |
| `delete_secret` | Delete a secret the Agent created itself. It cannot delete a secret created by someone else. |
| `get_vault_entry` | Read a typed entry's fields by key. |
| `create_vault_entry` | Create a typed entry (text, credential, card, note, identity, or a custom type). |
| `create_vault_type` | Define a custom entry type with a field schema. |
| `get_vault_attachment` | Download an entry's attachment as base64. |
| `redact_message` | Replace secret content already in the chat with a placeholder such as `[REDACTED]`. |

A typical flow: you mention you have a GitHub token, the Agent offers to store it with `create_secret`, then later a script the Agent runs calls `get_secret("GITHUB_TOKEN")` to use it without ever echoing it.

### Redaction and compacting

If a secret ends up in the visible conversation, the Agent can call `redact_message` to overwrite that message's content and mark it redacted. Hivekeep also protects against the value leaking through summarization: a message flagged as pending redaction is excluded from the context Hivekeep sends to the LLM and from compacting, so the secret is not carried forward into a summary.

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
