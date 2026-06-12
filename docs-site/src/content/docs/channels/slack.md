---
title: Slack
description: Connect your Agent to Slack using a bot.
---

Slack integration uses the [Events API](https://api.slack.com/apis/events-api) with webhooks for inbound messages and the [Web API](https://api.slack.com/web) for sending.

## Setup

1. **Create a Slack App** at [api.slack.com/apps](https://api.slack.com/apps)
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `chat:write` — Send messages
   - `files:read` — Read file attachments
   - `files:write` — Upload files
3. Install the app to your workspace and copy the **Bot User OAuth Token**
4. Under **Event Subscriptions**, enable events and set the request URL to your Hivekeep webhook endpoint
5. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`
6. Copy the **Signing Secret** from Basic Information
7. In Hivekeep, add a Slack channel with both the bot token and signing secret

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| Bot Token | ✅ | Bot User OAuth Token (stored encrypted) |
| Signing Secret | ✅ | For webhook request verification (stored encrypted) |
| Allowed Channel IDs | ❌ | Restrict to specific Slack channels |

## How It Works

- **Inbound:** Slack sends events to Hivekeep's webhook endpoint. The adapter verifies the request signature (v0), handles URL verification challenges, and routes messages to the Agent.
- **Outbound:** Messages are sent via `chat.postMessage`. Long messages (>4,000 chars) are split automatically. Files are uploaded via `files.upload`.

## Features

- Text messages with Slack mrkdwn formatting
- File attachments (inbound and outbound)
- Reply threading via `thread_ts`
- Request signature verification for security
- Automatic message chunking
- Channel and DM support

## Requirements

- Your Hivekeep instance must be publicly reachable for Slack event webhooks
- Configure `PUBLIC_URL` in your Hivekeep environment
