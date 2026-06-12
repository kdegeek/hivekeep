# Transferable channel bindings

## Concept

A Hivekeep channel (Telegram, Discord, Slack, WhatsApp, Signal, Matrix, TeamSpeak,
or any plugin-provided platform) is bound to exactly one Agent at a time via
`channels.agentId`. Before v0.40.x, that binding was effectively immutable: to
hand a conversation over to a different Agent you had to either run everything
through a dispatcher Agent (one extra LLM turn per inbound) or stand up a
dedicated channel per Agent.

Starting with the transferable-binding work, **the binding is mutable at
runtime**. Any Agent can call the `transfer_channel` tool to re-bind a channel
to another Agent. The bot identity on the platform side does not switch yet
(that is Issue 2, see Future work); only the Hivekeep routing changes.

Key invariants:

- One channel = one bound Agent at any moment.
- The bound Agent is always the one whose history receives the next inbound.
- Each Agent keeps its own conversation history. There is no shared context
  dump on transfer; the new Agent sees a short structured handoff note via
  `<channel-context>` on its first inbound, and that is it.
- No LLM turn is triggered at transfer time. The new Agent only acts when the
  user (or any external sender) sends the next message.

## The `transfer_channel` tool

Available to all main Agent agents (not sub-Agents). Not opt-in: any Agent can
hand off.

### Signature

```
transfer_channel({
  channelId?: string,        // UUID; inferred from the current turn if omitted
  targetAgentSlug: string,     // slug or UUID
  reason?: string,           // optional, max 200 chars
}) -> {
  ok: true,
  transferredAt: number,
  previousAgentSlug: string,
  newAgentSlug: string,
} | {
  ok: true,
  noop: true,
  message: 'Channel is already bound to this Agent.',
} | {
  error: string,
}
```

### Parameters

- **`channelId`** (optional). The channel to transfer. When omitted, Hivekeep
  infers it from the current turn's `channelOriginId` (the causal-chain
  pointer set by the channel adapter when it enqueued the inbound that
  triggered the current turn). When the inference fails (e.g. the Agent is
  not currently serving a channel-driven turn), the tool returns a clear
  error and does nothing.
- **`targetAgentSlug`**. Slug or UUID of the destination Agent. Resolved via
  `resolveAgentId`. Unknown slugs return an error.
- **`reason`** (optional). Free-text rationale, capped at 200 characters by
  the Zod schema. Propagated to:
  - The audit-trail rows on both Agents (renderable in the UI).
  - The `<channel-context>` block surfaced to the new Agent on the next
    inbound.
  - The `channel:transferred` SSE event.

### Error cases

| Case | Result |
| --- | --- |
| `channelId` missing and not inferrable | `{ error: "channelId could not be inferred from the current context; please pass it explicitly." }` |
| `channelId` unknown | `{ error: 'Channel "<id>" not found.' }` |
| `targetAgentSlug` unknown | `{ error: 'Agent "<slug>" not found (unknown slug or UUID).' }` |
| Source Agent row dangling | `{ error: 'Source Agent "<id>" not found; refusing to transfer from a dangling binding.' }` |
| Target row dangling after resolution | `{ error: 'Target Agent "<id>" not found after resolution; refusing to transfer to a dangling binding.' }` |
| Already bound to target | `{ ok: true, noop: true, message: '...' }` |
| `reason` over 200 chars | Rejected by Zod before `execute` runs. |

### Example invocation from an Agent

```json
{
  "name": "transfer_channel",
  "arguments": {
    "targetAgentSlug": "kube-master",
    "reason": "Nicolas wants to talk to Kube Master about the cluster"
  }
}
```

The calling Agent does not need to be the channel owner; this is intentional
to support handoffs initiated by any Agent in a multi-Agent instance (e.g. a
dispatcher Agent handing off after triage, or a specialist Agent passing back
to a generalist when done).

## What the new Agent sees

On the **next inbound** that arrives on the transferred channel, the user
message metadata is enriched with a one-shot `channelTransfer` blob:

```json
{
  "fromAgentId": "uuid-of-previous-agent",
  "fromAgentSlug": "hivekeep-master",
  "fromAgentName": "Hivekeep Master",
  "reason": "Nicolas wants to talk to Kube Master about the cluster",
  "at": 1778534324654
}
```

The agent-engine surfaces this in the existing `<channel-context>` XML tag
that already carries the adapter-supplied channel info, sharing a single
JSON envelope:

```
<channel-context>
{"channel": {...}, "channelTransfer": {"fromAgentSlug": "hivekeep-master", "fromAgentName": "Hivekeep Master", "reason": "...", "at": 1778534324654}}
</channel-context>
```

The hint is **one-shot**: after the first inbound consumes it, subsequent
inbounds carry only the regular `channel` block. The hint lives in an
in-memory sideband (`channelTransferHints` in
`src/server/services/channels.ts`); it is lost on restart, which is
deliberate (a stale post-restart hint would be misleading, while losing
one is harmless because the durable audit-trail rows below survive).

## UI audit trail

The transfer writes two rows into the `messages` table, one per Agent:

| agent     | role     | sourceType | metadata.systemEvent          | metadata payload                                            |
| ------- | -------- | ---------- | ----------------------------- | ----------------------------------------------------------- |
| source  | `system` | `system`   | `channel_transferred_out`     | channelId, channelName, targetAgentId/Slug/Name, reason, at   |
| target  | `system` | `system`   | `channel_transferred_in`      | channelId, channelName, fromAgentId/Slug/Name, reason, at     |

Both rows have `content: null`. The UI is expected to recognize them by
the `metadata.systemEvent` discriminator and render a handoff banner card
("Channel handed off to <target> — reason: ...").

`buildMessageHistory` filters these rows out before assembling the LLM
prompt: they exist purely for the human-readable history view and would
only confuse the model with redundant information that is already conveyed
by the `<channel-context>` hint described above.

## SSE event

The tool broadcasts a `channel:transferred` event (visible to every open
client) so any UI tab showing an Agent sidebar or the channel page can
refresh the binding badge in real time:

```json
{
  "type": "channel:transferred",
  "data": {
    "channelId": "...",
    "channelName": "...",
    "fromAgentId": "...",
    "fromAgentSlug": "...",
    "fromAgentName": "...",
    "toAgentId": "...",
    "toAgentSlug": "...",
    "toAgentName": "...",
    "reason": "..." | null,
    "at": 1778534324654
  }
}
```

It is intentionally broadcast (not `sendToAgent`) because multiple Agent views
may be open and several need to refresh at once.

## Migration

None required. The existing `channels.agentId` column is the same column;
only its mutability semantics changed. Pre-existing channels keep working
unchanged. No DB migration, no data backfill.

The decision to keep `channels.agentId` as the source of truth (rather than
introducing a separate "current Agent" pointer or a binding-history table)
was deliberate: the audit-trail rows give us the history view; the live
binding is just whatever `channels.agentId` currently says.

## Identity switching

A transfer is more than a routing change: when the channel is re-bound,
the bot identity on the external platform should reflect the new Agent so
the human on the other side immediately sees who is speaking. The core
ships two complementary mechanisms.

### The three modes

Every `ChannelAdapter` declares an `identitySwitchMode`:

- **`'native'`** — the adapter implements `onIdentityChange(channelId,
  config, { agentSlug, agentName, avatarUrl })` and pushes the new identity
  to the external platform (display name, avatar, or the closest
  equivalent the platform supports). The core does NOT add a prefix to
  outbound messages on these adapters.
- **`'prefix'`** — the adapter cannot switch identity natively. The core
  prepends `[Agent Name] ` to every outbound text message in
  `deliverChannelResponse`, so the recipient always knows which Agent
  is talking after a handoff.
- **`'none'`** — neither switch nor prefix. Reserved for cases where
  neither is appropriate (rare).

Default when `identitySwitchMode` is `undefined`: `'prefix'`. Precedence:
`'native'` > `'prefix'` > `'none'`.

The prefix is applied **once**, in the central outbound delivery path
(`deliverChannelResponse`), on Agent replies only. System-driven
outbound calls (approval-pending notices, `/start` welcome,
post-approval notifications) bypass the prefix. Attachments-only
messages (empty content) are also skipped.

### Per-adapter matrix

| Adapter | Mode | Display name | Avatar | Scope | API used |
| --- | --- | --- | --- | --- | --- |
| Telegram (built-in) | `native` | yes | no (BotFather only) | global to the bot | `setMyName` |
| Discord (built-in) | `native` | yes | yes (base64 data URI) | global to the bot user | `PATCH /users/@me` |
| Slack (built-in) | `native` | yes | yes | per-message | `chat.postMessage` `username` + `icon_url` |
| Matrix (built-in) | `native` | yes | yes (mxc:// upload) | global to the bot account | `PUT /profile/{userId}/displayname` + `PUT /profile/{userId}/avatar_url` |
| TeamSpeak (plugin) | `native` | yes (nickname) | no (file-transfer not exposed by ts-bot) | per-server (the bot's nickname) | ts-bot `set_nickname` |
| WhatsApp (built-in) | `prefix` | n/a | n/a | n/a | core prefix |
| Signal (built-in) | `prefix` | n/a | n/a | n/a | core prefix |
| Twilio SMS (plugin) | `prefix` | n/a | n/a | n/a | core prefix |

### Global-scope caveat (Telegram, Discord, Matrix)

On these platforms, the bot identity is a single global property of the
bot user / bot account. There is no per-chat or per-room identity API.
Transferring a channel on a multi-instance bot (e.g. the same Telegram
bot serving several humans, with each human having their own Hivekeep
Agent) flips the displayed name **for everyone**, not just the user who
triggered the transfer. This is a platform limitation that the owner
explicitly accepted when designing the feature; document it for your
users if it matters in your setup.

### Slack: per-message identity

Slack has no global "set bot identity" API: `chat.postMessage` accepts
a per-call `username` and `icon_url`. The adapter stores the latest
identity in a per-channel in-memory sideband (`slackIdentityOverrides`)
and injects it on every outbound text. This avoids the
global-scope caveat but has two consequences:

- `files.upload` does not accept those fields, so attachment-only
  messages still surface under the bot app's default identity.
- After a server restart, the override is lost until the next
  `transfer_channel` call (or the bot app's default identity comes
  back into effect, which is the safer behaviour anyway).

### Avatar URL

The core builds the avatar URL by combining `config.publicUrl` with
the relative `/api/uploads/agents/{id}/avatar.{ext}?v={updatedAtMs}`
path returned by the `agentAvatarUrl` helper. Native adapters fetch
this URL when they need to forward the avatar to the platform. If the
target Agent has no avatar (`agents.avatarPath` is null), `avatarUrl` is
`undefined` and the adapter is free to skip the avatar update.

### Guidance for plugin authors

Pick the mode that matches your platform's capability:

- If the platform exposes a way to flip a bot's display name (and
  ideally its avatar) at runtime, implement `onIdentityChange` and
  declare `identitySwitchMode: 'native'`. Errors from the method are
  caught and logged at warn level by `transfer_channel`; they do not
  fail the transfer, so feel free to throw on genuinely unrecoverable
  conditions.
- If the platform has no such API (SMS, classic webhook-only setups,
  IRC ops with fixed nicks, etc.), declare `identitySwitchMode:
  'prefix'`. Do not implement `onIdentityChange`. The core takes care
  of `[Agent Name] ` automatically.
- Only use `'none'` if neither makes sense, for example a one-way
  receive-only adapter where outbound never happens.

## Migration

None required. The existing `channels.agentId` column is the same column;
only its mutability semantics changed. Pre-existing channels keep working
unchanged. No DB migration, no data backfill.

The decision to keep `channels.agentId` as the source of truth (rather than
introducing a separate "current Agent" pointer or a binding-history table)
was deliberate: the audit-trail rows give us the history view; the live
binding is just whatever `channels.agentId` currently says.

## Cross-Agent send (borrowing another Agent's channel)

`transfer_channel` is a **persistent** operation: it mutates `channels.agentId`,
so the target Agent becomes the new owner and receives every future inbound on
that channel. Cross-Agent send is the **ephemeral** counterpart: an Agent sends a
single message through a channel bound to another Agent **without changing the
binding**. The owner stays the owner; the borrower just posts once.

Use case: VeilleurIA posts a daily AI brief to the Discord bound to Dispatcher
Central, without taking over the channel.

### How it works

- **Discovery.** `list_channels({ scope: 'all' })` returns every channel on the
  instance, each annotated with `ownerAgentId`, `ownerAgentSlug`, `ownerAgentName`,
  and `owned` (true when the caller is the owner). The default `scope: 'mine'`
  preserves the original behaviour (only the caller's channels, no owner fields).
- **Send.** `send_channel_message(channelId, chatId, message)` and
  `send_to_contact(contact, platform, message)` no longer require the caller to
  own the channel. Existence (and `status === 'active'`) is the only gate, since
  a self-hosted instance is single-user and all Agents are under the same control.
- **Automatic `[AgentName]` prefix.** When the sending Agent is **not** the channel
  owner, the message is prefixed with `[SenderAgentName] ` so the human knows who
  is really speaking through the bot. This reuses the same
  `applyAgentNamePrefix` helper as the identity-switch fallback above, but applies
  it **regardless of the adapter's `identitySwitchMode`** (the bot identity on
  the platform belongs to the owner Agent, so even native-switch adapters cannot
  reflect the borrower). The prefix is idempotent (never doubled) and skipped for
  empty / attachments-only content. When the sender **is** the owner, no prefix
  is added (the historical single-Agent behaviour is preserved).
- **Audit.** Every send (cross-Agent or owner) writes a `channel_message_links`
  row with `sent_by_agent_id` set to the Agent that actually sent it, distinct from
  the channel owner (`channels.agent_id`). Proactive sends carry `message_id = NULL`
  (no originating assistant message); auto-delivered Agent replies still link their
  assistant `messages.id` and set `sent_by_agent_id` to the owner. A structured log
  line (`{ channelId, ownerAgentId, senderAgentId, crossAgent, prefix }`) is emitted on
  each send.

### Distinction from `transfer_channel`

| | `transfer_channel` | cross-Agent send |
| --- | --- | --- |
| Effect on binding | mutates `channels.agentId` (persistent) | none (ephemeral) |
| Future inbounds | routed to the new Agent | still routed to the owner |
| Audit | two `role=system` handoff rows | `channel_message_links.sent_by_agent_id` |
| Prefix | identity-switch fallback (mode-dependent) | always when sender ≠ owner |

### V1 scope

No per-channel permission system (`allowedAgentSlugs[]`): the channel is open to
every Agent by default. Justification: single-user self-hosted instance, all Agents
controlled by the same owner, and the `sent_by_agent_id` audit trail is enough for
traceability. An opt-in permission layer can be added in V2 if abuse appears.

## Future work (out of scope for this commit)

- **Issue 3: UI badges.** The sidebar Agent rows and the channel page need
  visible binding badges, and a transfer-history surface (filterable by
  channel or by Agent) so the user can audit past handoffs. The SSE event
  and the audit-trail rows added in Issue 1 are the foundation; the UI
  work consumes them.
- **Cross-Agent send badge.** Surface `sent_by_agent_id` in the channel message
  list ("sent by X") when it differs from the channel owner.
