---
title: Matrix
description: Connect your Agent to Matrix rooms.
---

Matrix integration uses the [Client-Server API](https://spec.matrix.org/latest/client-server-api/) with long-poll sync for real-time message delivery.

## Setup

1. **Create a Matrix account** for your bot on any homeserver (e.g., matrix.org, or your own Synapse/Dendrite)
2. **Get an access token** — you can use the login API or extract it from Element's settings
3. **Invite the bot** to the rooms you want it to participate in
4. In Hivekeep, add a Matrix channel with the access token and homeserver URL
5. Optionally, restrict to specific room IDs with the allowlist

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| Access Token | ✅ | Matrix access token (stored encrypted) |
| Homeserver URL | ✅ | e.g., `https://matrix.org` |
| Allowed Room IDs | ❌ | Restrict to specific rooms |

## How It Works

- **Inbound:** Hivekeep uses Matrix's `/sync` endpoint with long-polling to receive events in real time. It filters for `m.room.message` events, extracts text and media, and routes to the Agent.
- **Outbound:** Messages are sent via the `PUT /rooms/{roomId}/send` endpoint. Long messages (>4,096 chars) are split. Images use `m.image` message type, other files use `m.file`.

## Features

- Text messages with HTML formatting
- Image and file attachments (via Matrix content repository)
- Room and DM support
- Automatic message chunking
- Typing indicator
- Long-poll sync (no webhook needed, works behind NAT/firewalls)

## Advantages

- **No public URL required** — Matrix uses client-side long-polling, so Hivekeep doesn't need to be publicly reachable
- **Federated** — works with any Matrix homeserver
- **Self-hostable** — run your own homeserver for full control
