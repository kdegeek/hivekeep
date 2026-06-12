---
title: Telegram
description: Connect your Agent to Telegram using a bot.
---

Telegram integration uses the [Bot API](https://core.telegram.org/bots/api) with automatic transport selection: **webhooks** when a public HTTPS URL is available, or **long polling** for local/development setups.

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token
3. In Hivekeep, go to your Agent's **Channels** tab
4. Click **Add Channel**, select **Telegram**
5. Paste your bot token — it will be encrypted in Hivekeep's vault
6. Optionally, restrict to specific chat IDs with the allowlist

Hivekeep automatically selects the best transport mode based on your configuration.

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| Bot Token | ✅ | Token from BotFather (stored encrypted) |
| Allowed Chat IDs | ❌ | Restrict to specific chats (groups or users) |

## Transport Modes

### Webhook mode (default for production)

When `PUBLIC_URL` is set and starts with `https://`, Hivekeep registers a webhook with Telegram pointing to your instance. Telegram sends updates directly to this endpoint for real-time delivery.

**Requirements:**
- `PUBLIC_URL` must be configured in your Hivekeep environment
- The URL must be HTTPS (Telegram requirement)
- Your instance must be reachable from the internet

### Long polling mode (local/development)

When `PUBLIC_URL` is not set or is not HTTPS, Hivekeep automatically falls back to **long polling** using Telegram's `getUpdates` API. This enables Telegram channels on local or development setups without a public HTTPS endpoint.

**How it works:**
- Hivekeep deletes any existing webhook on the bot (Telegram requirement before using `getUpdates`)
- A per-channel polling loop runs in the background, fetching updates every 30 seconds
- Exponential backoff (up to 30 seconds) handles transient API failures
- No public URL or HTTPS is required

:::tip
Long polling mode is selected automatically — no manual configuration needed. Just leave `PUBLIC_URL` unset or set it to a non-HTTPS URL.
:::

## How It Works

- **Inbound:** Messages are received via webhook or polling. The adapter parses text and attachments (photos, documents, audio, video) and routes them to the Agent.
- **Outbound:** Messages are sent via the Bot API. Long messages (>4,096 chars) are automatically split. File attachments are uploaded as multipart form data.

## Features

- Text messages with Markdown formatting
- Image, document, audio, and video attachments (inbound and outbound)
- File attachment retry logic (1 retry with 500ms delay for transient API failures)
- Reply threading via `reply_to_message_id`
- Automatic message chunking at paragraph/line boundaries
- Typing indicator (`sendChatAction`)
- Group chat support (with optional chat ID filtering)
