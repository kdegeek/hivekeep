---
title: Windows desktop installer
description: Install Hivekeep as a Windows desktop app connected to your Hivekeep server.
---

Hivekeep can run as a Windows desktop app when you want Start menu access and a native window for your agents.

The Windows desktop app is a client for an existing Hivekeep server. Install or expose Hivekeep first with Docker, Docker Compose, the Linux/macOS native installer, or a manual install, then connect the desktop app to that server URL.

## Install

1. Make sure your Hivekeep server is reachable.
   - Local machine: `http://localhost:3000`
   - Another machine on your network: `http://<host-or-ip>:3000`
   - Public/reverse-proxied instance: `https://your-domain`
2. Download the Windows installer from the [latest GitHub release](https://github.com/MarlBurroW/hivekeep/releases/latest).
3. Run `Hivekeep-Setup-*.exe`.
4. Open **Hivekeep** from the Start menu and enter your Hivekeep server URL when prompted.

If Windows SmartScreen warns about an unsigned or newly published installer, only continue when you trust the release source.

## Update

Download and run the newer `Hivekeep-Setup-*.exe` from the latest release. The desktop app keeps using the same server URL after an update.

## Troubleshooting

- **Cannot connect to the server:** confirm the server is running and that the same URL opens in a browser.
- **Accessing a server on another device:** bind the server to `0.0.0.0` and set `PUBLIC_URL` to the LAN or HTTPS URL clients should use.
- **Public or remote access:** prefer HTTPS so notifications, sign-in, and secure browser features work consistently.

Looking for mobile packaging instead? See the [Android APK guide](https://github.com/MarlBurroW/hivekeep/blob/main/docs/android-apk.md).
