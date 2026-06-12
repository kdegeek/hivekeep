---
title: WhatsApp
description: Connect your Agent to WhatsApp using the Cloud API.
---

WhatsApp integration uses the [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) for both inbound and outbound messaging.

## Setup

1. **Create a Meta App** at [developers.facebook.com](https://developers.facebook.com/)
2. Add the **WhatsApp** product to your app
3. In WhatsApp > Getting Started, note your **Phone Number ID** and generate a **Permanent Access Token**
4. Configure the webhook in Meta's dashboard:
   - **Callback URL:** Your Hivekeep webhook endpoint for WhatsApp
   - **Verify Token:** A secret string you choose (stored in Hivekeep's vault)
   - Subscribe to the `messages` webhook field
5. In Hivekeep, add a WhatsApp channel with the access token, phone number ID, and verify token

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| Access Token | ✅ | Permanent access token (stored encrypted) |
| Phone Number ID | ✅ | Your WhatsApp business phone number ID |
| Verify Token | ✅ | Webhook verification token (stored encrypted) |

## How It Works

- **Inbound:** Meta sends webhook events to Hivekeep. The adapter verifies the token, extracts message content and media, and routes to the Agent.
- **Outbound:** Messages are sent via the Graph API (`/messages` endpoint). Long messages (>4,096 chars) are split. Images are sent as media messages, other files as documents.

## Features

- Text messages
- Image, document, audio, and video attachments
- Automatic message chunking
- Webhook verification

## Requirements

- A Meta Business account with WhatsApp API access
- Your Hivekeep instance must be publicly reachable for webhooks
- Configure `PUBLIC_URL` in your Hivekeep environment
- The webhook URL must be configured manually in Meta's developer console
