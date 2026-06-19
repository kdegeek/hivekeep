---
title: WhatsApp
description: Connect your Agent to WhatsApp using the Cloud API or QR-code pairing.
---

Hivekeep offers two ways to connect WhatsApp:

- **WhatsApp** (this page's main setup): the official [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). Requires a Meta app, a business phone number, and a webhook. Best for businesses already on the Cloud API.
- **WhatsApp (QR)**: links your **personal** WhatsApp number by scanning a QR code, like WhatsApp Web. No Meta app, no business account, nothing to install. See [QR-code pairing](#qr-code-pairing-no-cloud-api) below.

## QR-code pairing (no Cloud API)

The **WhatsApp (QR)** platform connects through the WhatsApp **web multi-device** protocol (via [Baileys](https://github.com/WhiskeySockets/Baileys)) over a long-lived socket, exactly like the WhatsApp Web app on a desktop.

1. In Hivekeep, **Add channel** and pick **WhatsApp (QR)**. Choose the Agent and a name (there is no token to enter).
2. Click **Show QR code**. A QR appears in the dialog.
3. On your phone, open **WhatsApp > Settings > Linked devices > Link a device** and scan the code.
4. Once scanned, the channel turns **active**. The session is saved on the server, so it reconnects automatically after a restart.

If the QR expires before you scan it, click **New QR code**. If WhatsApp later reports the device as logged out, the channel flips to an error state; click the **Re-pair** (QR) button on the channel to scan a fresh code.

You can also just **ask Queenie** to connect WhatsApp: she opens the QR as an in-chat card, so you scan it right from the conversation.

**Notes and limits:**

- The session lives on the server under the data directory (`WHATSAPP_WEB_DIR`, default `data/whatsapp-web/<channel-id>`). Deleting the channel removes it.
- This uses an unofficial protocol. Use a number you control and review WhatsApp's terms; it is not a substitute for the official Cloud API for high-volume business use.
- Inbound currently handles text (including image/video captions); outbound supports text plus image/document attachments.

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
