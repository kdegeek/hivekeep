---
title: Signal
description: Connect your Agent to Signal using signal-cli.
---

Signal integration uses the [signal-cli REST API](https://github.com/bbernhard/signal-cli-rest-api) as a bridge between Hivekeep and the Signal protocol.

## Prerequisites

You need a running instance of **signal-cli-rest-api** with a registered phone number. This acts as the Signal "bot" identity.

## Setup

1. **Deploy signal-cli-rest-api** (Docker recommended):
   ```bash
   docker run -d --name signal-cli \
     -p 8080:8080 \
     -v signal-cli:/home/.local/share/signal-cli \
     bbernhard/signal-cli-rest-api
   ```
2. **Register a phone number** with signal-cli (see signal-cli docs)
3. In Hivekeep, add a Signal channel:
   - **API URL:** The URL of your signal-cli REST API instance (e.g., `http://localhost:8080`)
   - **Phone Number:** The registered phone number in E.164 format (e.g., `+1234567890`)
4. Optionally, restrict to specific group IDs or phone numbers with the allowlist

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| API URL | ✅ | signal-cli REST API base URL (stored encrypted) |
| Phone Number | ✅ | Registered Signal number (E.164 format) |
| Allowed Chat IDs | ❌ | Restrict to specific groups or numbers |

## How It Works

- **Inbound:** Hivekeep receives messages via signal-cli's webhook/polling mechanism. The adapter extracts text, attachments, and sender info, routing them to the Agent.
- **Outbound:** Messages are sent via the signal-cli REST API. Long messages (>2,000 chars) are split. Attachments are uploaded as base64.

## Features

- Text messages
- Image, document, audio, and video attachments
- Group and direct message support
- Automatic message chunking

## Requirements

- A running signal-cli REST API instance
- A registered Signal phone number
- Network connectivity between Hivekeep and signal-cli
