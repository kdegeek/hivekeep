# Windows desktop installer

Hivekeep also offers a Windows desktop app for people who want the web UI in a native desktop window with Start menu access.

The desktop app is a client for your Hivekeep instance. It does not replace the server install: run Hivekeep with the native installer, Docker, Docker Compose, or a manual install first, then point the Windows app at that server URL.

## Install

1. Install or expose a Hivekeep server.
   - Local machine: `http://localhost:3000`
   - Another machine on your network: `http://<host-or-ip>:3000`
   - Public/reverse-proxied instance: `https://your-domain`
2. Download the Windows installer from the [latest GitHub release](https://github.com/MarlBurroW/hivekeep/releases/latest).
3. Run the `Hivekeep-Setup-*.exe` installer.
4. Open **Hivekeep** from the Start menu and enter your Hivekeep server URL when prompted.

If Windows SmartScreen warns about an unsigned or newly published installer, only continue when you trust the release source.

## Updating

Download and run the newer `Hivekeep-Setup-*.exe` from the latest release. The app keeps using the same Hivekeep server URL after an update.

## Troubleshooting

- **Cannot connect to the server:** confirm the server is running and that the desktop app is using the same URL you can open in a browser.
- **Using another device on your network:** bind the server to `0.0.0.0` and set `PUBLIC_URL` to the LAN or HTTPS URL clients should use.
- **Using HTTPS:** prefer HTTPS for public or remote access so notifications, sign-in, and secure browser features work consistently.

Android APK packaging is documented separately in [`docs/android-apk.md`](android-apk.md).
