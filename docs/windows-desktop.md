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
- Closing the main window does not exit the app: the close request is intercepted
  and the window is hidden, so Hivekeep keeps running in the tray. Use the tray
  menu's Quit action when you want to stop the desktop client completely.
- Tray state is client-side convenience only. Agent execution, scheduled jobs,
  notification records, and SSE events still come from the server.
- If the server is unreachable or the session expires, the tray panel should show
  the same reconnect/login path as the full app rather than silently failing.

## Auth and trusted origins

Unlike the browser UI (which relies on the Better Auth HTTP-only session cookie),
the Windows desktop shell authenticates with a bearer token. The native runtime
attaches `Authorization: Bearer <token>` to every API and SSE request via
`withNativeAuthTransport` and does not send cookies. The server must therefore
have Better Auth's bearer plugin enabled so it accepts these tokens; this is the
default server configuration.

The WebView origin still has to be in the server's trusted-origins allowlist —
omitting cookies does not exempt a request from CORS. A `fetch()` in the
default `cors` mode needs a matching `Access-Control-Allow-Origin` response
header before the browser will let the page read the response, regardless of
whether credentials are sent. `src/server/auth/origins.ts` ships
`tauri://localhost` (macOS/Linux) and `http://tauri.localhost`
(Windows/Android) in its default `DESKTOP_ORIGINS` list, which feeds both the
CORS middleware and Better Auth's own origin check, so a stock server already
trusts the desktop shell out of the box. If you've overridden
`TRUSTED_ORIGINS`, make sure it still includes those two values — `origins.ts`
always unions your override with `DESKTOP_ORIGINS`, so you don't need to
repeat them yourself. If the WebView ever reports a different literal origin
(check the failing request's `Origin` header in DevTools), that exact string
needs to go in `DESKTOP_ORIGINS`.

The global SSE stream remains `GET /api/sse`: one multiplexed EventSource per
desktop client (authenticated with the same bearer token), with no
desktop-specific event types required by the server contract.

## Native shell capabilities

- **Single instance.** `tauri-plugin-single-instance` is registered first in
  the Rust `Builder` chain (a Tauri requirement). Launching the app again
  while it's already running — including from a Start Menu shortcut while
  hidden in the tray — focuses the existing main window instead of opening a
  second one.
- **External links and OAuth sign-in.** The webview has no shell-open
  permission by default, so a plain link click or `window.open()` used to
  navigate the app's own webview to a dead URL. `src/client/lib/native-links.ts`
  routes external `http(s)` links (provider API-key pages, OAuth authorize
  URLs, release notes, etc.) through `tauri-plugin-opener` into the OS
  browser instead. This only gets a link open in the browser — it does not
  complete an OAuth round trip back into the app (no custom URI scheme /
  deep-link handler is registered), so OAuth "connect account" flows still
  need a manual return to the desktop app after sign-in.
- **Native OS notifications.** `useNativeDesktopNotifications` fires a Windows
  toast via `tauri-plugin-notification` when the server pushes a
  `notification:new` SSE event while the main window is unfocused — e.g. a
  background agent task finishing while Hivekeep is minimized to the tray.
  Focus state comes from a `hivekeep-window-focus` event emitted by Rust on
  `WindowEvent::Focused`, not the page's `document.visibilityState`, which
  isn't a reliable signal once the window is hidden to the tray rather than
  just backgrounded. Catch-up after a dropped/reconnected SSE stream reuses
  the existing `useSSEResync` mechanism against `GET /api/notifications`.
  Clicking a toast does not yet deep-link to the related page (relies on
  Windows' default behavior of focusing the originating app).
- **Auto-update.** The desktop binary checks `plugins.updater.endpoints` in
  `tauri.conf.json` (a GitHub Releases `latest.json`) via `tauri-plugin-updater`
  on launch and offers to download, install, and relaunch. This is separate
  from the web/Docker server-update flow (`UpdateContext`) — that flow
  updates the server the browser talks to; it has no way to replace a
  desktop installer. Publishing a release that the updater can see requires
  `.github/workflows/release-desktop.yml`, which needs `TAURI_SIGNING_PRIVATE_KEY`
  / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets (the keypair generated
  via `tauri signer generate`, public half embedded in `tauri.conf.json`) in
  addition to the Windows code-signing secrets above. Trigger it by pushing a
  `v*.*.*` tag or running it manually via `workflow_dispatch`; it publishes a
  **draft** GitHub Release for review before going live.

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

`scripts/sign-windows-tauri.ps1` reads the certificate from
`WINDOWS_SIGNING_CERTIFICATE_PFX_BASE64` (base64-encoded PFX) and
`WINDOWS_SIGNING_CERTIFICATE_PASSWORD`, or alternatively from
`WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT` for a cert already installed in the
Windows store. Set those exact names, otherwise the script logs a warning and
produces an unsigned installer:

```powershell
$env:WINDOWS_SIGNING_CERTIFICATE_PFX_BASE64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("C:\secrets\hivekeep-windows.pfx"))
$env:WINDOWS_SIGNING_CERTIFICATE_PASSWORD = "<certificate password>"
bun run desktop:build
bun run desktop:bundle:win
```

The Tauri updater private key (`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) is separate: it signs auto-update manifests
and is consumed by Tauri's updater, not by the Authenticode signing script above.

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
