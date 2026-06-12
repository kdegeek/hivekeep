---
title: Discord
description: Connect your Agent to Discord using a bot.
---

Discord integration uses the [Gateway API](https://discord.com/developers/docs/events/gateway) (WebSocket) for real-time message delivery, with the REST API for sending messages.

## Setup

1. **Create an application** at the [Discord Developer Portal](https://discord.com/developers/applications)
2. Under **Bot**, create a bot and copy the token
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Generate an invite link with the required permissions and add the bot to your server
5. In Hivekeep, go to your Agent's **Channels** tab
6. Click **Add Channel**, select **Discord**
7. Paste your bot token — it will be encrypted in Hivekeep's vault
8. Optionally, restrict to specific channel IDs with the allowlist

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| Bot Token | ✅ | Discord bot token (stored encrypted) |
| Allowed Channel IDs | ❌ | Restrict to specific Discord channels |

## How It Works

- **Inbound:** Hivekeep maintains a persistent WebSocket connection to Discord's Gateway. It receives message events, ignores its own messages, and routes incoming messages to the Agent.
- **Outbound:** Messages are sent via the REST API. Long messages (>2,000 chars) are automatically split. File attachments are uploaded as multipart form data.

## Gateway Features

The adapter handles all Gateway lifecycle events:

- Heartbeat keepalive
- Session resume on reconnect
- Automatic reconnection on disconnect or invalid session
- Proper identification with required intents

## Required Intents

| Intent | Bit | Purpose |
|--------|-----|---------|
| GUILDS | 1 << 0 | Server/channel info |
| GUILD_MESSAGES | 1 << 9 | Receive messages in servers |
| DIRECT_MESSAGES | 1 << 12 | Receive DMs |
| MESSAGE_CONTENT | 1 << 15 | Read message text (privileged) |

## Features

- Text messages with Discord Markdown
- File attachments (inbound via CDN URLs, outbound via multipart upload)
- Reply threading
- Automatic message chunking
- DM and server channel support
- Typing indicator
- Bot ignores its own messages automatically
