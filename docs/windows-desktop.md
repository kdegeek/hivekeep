# Windows desktop packaging

Hivekeep ships a Windows desktop shell for users who want a native window,
system-tray presence, and a quick panel without running Hivekeep inside a normal
browser tab. The desktop app is a thin client: it packages the same web UI in a
Windows WebView/Tauri shell and connects to a reachable Hivekeep server. It does
not start, install, or embed the Bun/Hono server.

## Architecture

- The desktop shell loads the built Hivekeep client and stores the configured
  server origin locally on the Windows user profile.
- API and SSE calls still go to the selected Hivekeep server under `/api/*`.
  The server owns authentication, agent execution, queues, files, database
  state, provider secrets, and background jobs.
- The native layer is limited to desktop affordances: app windows, tray menu,
  quick panel, startup/update integration, installer metadata, and optional
  Windows notifications.
- A desktop install can point at a local server such as `http://localhost:3000`
  or a remote/self-hosted HTTPS origin. For shared or remote use, prefer HTTPS.

Because the server remains authoritative, updating or uninstalling the Windows
app does not remove server data, models, providers, agents, workspaces, or the
Hivekeep service/container that users may already run separately.

## Prerequisites

- Bun dependencies installed with `bun install`.
- A Windows development host for local installer builds.
- Rust stable, Cargo, and the Tauri CLI/tooling used by the desktop package.
- Microsoft C++ Build Tools / Visual Studio Build Tools with the Windows SDK.
- Microsoft Edge WebView2 Runtime on the target machine. Current Windows 10/11
  installations usually already have it; older images may need the Evergreen
  Runtime installed before launching the app.
- A reachable Hivekeep server. The desktop shell is a client and does not start
  or embed the Bun/Hono server.
- For signed release installers only: Windows code-signing credentials and any
  updater signing key configured by the packaging workflow.

## Development run

Start the Hivekeep server in one terminal:

```bash
bun run dev:server
```

Then run the desktop shell in a second terminal:

```bash
bun run desktop:dev
```

The desktop dev command is expected to wrap Tauri's dev flow: it starts or
reuses the Vite dev server for the web UI and opens a WebView-backed native
window. Keep the server terminal running while testing login, realtime updates,
and tray behavior. If you also want a normal browser tab for comparison, run
`bun run dev` instead of `bun run dev:server` and make sure the desktop command
reuses the existing Vite port rather than starting a second one.

For a local server, `http://localhost:3000` is valid from the same Windows
machine. If the desktop app is pointed at another machine, use that server's LAN
hostname/IP or public HTTPS URL instead of `localhost`.

## Bundling a Windows installer

Build the production desktop bundle from a clean checkout:

```bash
bun install
bun run desktop:build
```

The desktop build runs the production web build first, then packages the static
client assets into the Windows shell. Release artifacts are produced by the
Tauri bundler, typically under:

```text
src-tauri/target/release/bundle/
```

Depending on the enabled bundle targets, expect an `.exe` setup program and/or
an `.msi` package. Use a fresh Windows VM or test user profile to validate the
installer before publishing it.

## Installer behavior

The Windows installer installs only the desktop client shell.

- It does not install Bun, configure providers, create a database, or start the
  Hivekeep server. Users still need an existing self-hosted server or a server
  installed through the normal Hivekeep install path.
- It registers Start Menu/Desktop shortcuts according to the bundle settings.
- It may launch Hivekeep after installation when the installer option is
  selected.
- Upgrades replace the desktop shell while preserving the user-local desktop app
  state, including the saved server URL and WebView storage.
- Uninstalling removes the desktop shell and shortcuts, but not the external
  Hivekeep server or any server-side data.
- Signed updates must keep using the same signing identity and updater key so
  Windows and the app updater can trust the replacement package.

## Tray quick panel

The desktop app includes a system-tray entry for quick access while Hivekeep is
running in the background.

- Opening the tray quick panel shows a compact view for current work: unread
  notifications, active/running tasks, and shortcuts back into the main window.
- The quick panel uses the same configured server and authenticated session as
  the main desktop window.
- Closing the main window may leave the tray process running, depending on the
  desktop shell settings. Use the tray menu's quit action when you want to stop
  the desktop client completely.
- Tray state is client-side convenience only. Agent execution, scheduled jobs,
  notification records, and SSE events still come from the server.
- If the server is unreachable or the session expires, the tray panel should show
  the same reconnect/login path as the full app rather than silently failing.

## Trusted origins and auth

The desktop shell uses the same HTTP-only session cookie and Better Auth-backed
API routes as the browser UI. The server must allow the origin that the Windows
WebView uses when it makes credentialed API requests.

For normal browser/reverse-proxy access, continue to set `PUBLIC_URL` to the URL
users open and use `TRUSTED_ORIGINS` for any additional browser origins. For the
Windows desktop shell, include the desktop WebView origin in the server's trusted
origin/CORS configuration when it differs from `PUBLIC_URL`.

Tauri's default custom-protocol origin is platform dependent. On Windows it is
normally `http://tauri.localhost` unless the desktop configuration opts into an
HTTPS custom-protocol origin; dev builds can also involve `http://localhost:5173`.
If the desktop app cannot log in or API calls fail with CORS/auth errors, verify
that the exact origin shown in WebView devtools is listed in `TRUSTED_ORIGINS`
and in the server's Better Auth trusted origins.

Keep reverse proxies configured to forward cookies and SSE responses. The global
SSE stream remains `GET /api/sse`: one multiplexed EventSource per desktop
client, with no desktop-specific event types required by the server contract.

## Signing secrets

Keep Windows signing material out of git and out of local build logs.

Typical release signing inputs include:

- an Authenticode/code-signing certificate, usually a PFX file or a certificate
  installed in the Windows certificate store;
- the certificate password or key-provider credentials;
- a timestamp server URL so signatures remain valid after certificate expiry;
- the Tauri updater private key and password, if updater signatures are enabled.

Use CI secrets or a local password manager for those values. Do not commit PFX
files, private keys, `.env` files containing passwords, or generated installer
artifacts that include private signing metadata. Losing the updater private key
or changing the Windows signing identity can prevent seamless upgrades from
previously installed desktop releases.

PowerShell example for a local signed build:

```powershell
$env:WINDOWS_CERTIFICATE="C:\secrets\hivekeep-windows.pfx"
$env:WINDOWS_CERTIFICATE_PASSWORD="<certificate password>"
$env:TAURI_SIGNING_PRIVATE_KEY="<updater private key>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<updater key password>"
bun run desktop:build
```

Unset those variables after the build if the terminal session will remain open.

## Manual smoke checklist

Automated Playwright smoke tests cover the desktop build flags, the main desktop
shell, and the quick-panel `?surface=mobile` route. Native tray and window-manager
behavior still needs a real Windows desktop session.

Before publishing a Windows desktop build, verify the following on a clean
Windows account or VM:

- Installer launches, completes without elevation surprises, and creates the
  expected shortcuts.
- First launch prompts for a Hivekeep server URL and rejects an unreachable or
  invalid `/api/health` endpoint.
- A valid local server (`http://localhost:3000`) and a valid remote HTTPS server
  both save successfully.
- Login works and the authenticated session survives app restart.
- Main navigation loads Agents, Projects, Tasks, Files, Settings, and at least
  one chat/agent page without WebView console errors.
- Realtime updates arrive through `/api/sse` after sending a message or changing
  a task from another client.
- Offline/server-down behavior shows a clear reconnect path, then recovers after
  the server returns.
- Signed release installer and upgrade path are accepted by Windows SmartScreen
  and replace a previous version without losing local desktop app state.

### Tray/window behaviors that need manual verification

These checks depend on the Windows tray, focus model, and window manager, so they
are intentionally manual instead of Playwright-only:

- Tray icon appears after launch and does not duplicate after hiding/showing the
  main window.
- Left-clicking the tray icon toggles the quick panel near the cursor and keeps it
  inside the current monitor work area.
- Right-clicking the tray icon opens a menu with Open Hivekeep, Quick Panel,
  Settings / Server URL, and Quit actions.
- Open Hivekeep restores, unminimizes, and focuses the main window.
- Settings / Server URL focuses the main window and opens the settings/server
  configuration path.
- The quick panel hides on blur and does not immediately reopen from the same
  blur/click interaction.
- Closing the main window hides it to the tray instead of exiting the process.
- Reopening the main window preserves its previous valid size and position.
- Quit from the tray fully exits the desktop process and removes the tray icon.
