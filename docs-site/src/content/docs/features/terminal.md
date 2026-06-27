---
title: "Terminal: a shell on your server"
description: An admin-only web terminal on the Hivekeep host (or inside the container under Docker), straight from the app.
---

The **Terminal** section gives administrators a real shell on the machine running Hivekeep: the host itself, or the container when you run the Docker image. It is a full PTY rendered with xterm.js: interactive programs, colors, tab completion, `htop`, `vim`, everything works as in a native terminal.

The typical moment: an Agent just wrote files to its workspace, a cron failed, or you want to check disk usage. Open Terminal from the activity bar and look for yourself, without SSH-ing into the box.

Terminal is **admin-only**: the entry only appears for admin users, and the server rejects non-admin connections regardless of what the client does.

## Persistent sessions, on every device

Terminal works like a lightweight tmux. Shells run server-side and **survive disconnects**: close the laptop, open Hivekeep on your phone, and the sessions sidebar shows the same running shells: pick one and you are back where you left off, recent output replayed. This is ideal for long-running interactive work, like driving one or more `claude code` instances directly on the machine that hosts Hivekeep.

The sidebar lists your sessions (sessions are private to each user). From there you can:

- **Create** a new session (the + button). Each gets an auto name like "Session 2"; rename it to something meaningful ("claude code prod") via the row menu.
- **Switch** between sessions. Each card shows what the session is doing so you can tell them apart at a glance: the **running command** (e.g. `vim`, `npm`), the **working directory**, and how long ago it was last active. A green dot marks sessions with a client attached.
- **Close** a session (row menu, with confirmation). This kills the shell and everything running in it.

The sessions sidebar is **resizable**: drag its right edge to give long paths more room (the width is remembered).

## Surviving a restart

Sessions are persisted, so the sidebar and recent output come back after Hivekeep restarts. How much comes back depends on whether **tmux** is installed on the host:

- **With tmux** (bundled in the official Docker image): sessions are backed by a tmux session, whose server keeps running independently of Hivekeep. After an in-place update or a process-only restart, reattaching reconnects to the **live** shell with its running processes intact. A full container recreation (or host reboot) still stops the processes, but the scrollback is restored. The sidebar shows a "Persistent sessions (tmux)" indicator and an anchor icon on each card.
- **Without tmux**: sessions fall back to a plain shell. Their scrollback is saved and replayed, and reattaching opens a **fresh** shell in the session's last working directory. The sidebar then suggests installing tmux for process-surviving sessions. tmux is never required.

Restored sessions appear **dormant** (a moon badge) until you click one, which revives it. A session ends for good only when its shell exits or you close it from the sidebar. If you prefer idle detached sessions to be reaped automatically, set `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` to a number of seconds (off by default).

Several tabs or devices can view the **same session at once**: output mirrors to every attached client and any of them can type, exactly like a shared tmux session. As in tmux, the terminal is sized to the smallest attached viewer so line wrapping stays coherent everywhere.

## On a phone

The terminal is built to be usable from a phone, not just a desktop:

- **A key bar** above the terminal with the keys a soft keyboard lacks: `Esc`, `Tab`, the four arrows, and a `Ctrl` toggle. Tap `Ctrl`, then a letter, to send a control sequence (tap `Ctrl` then `C` to interrupt, `Ctrl` then `R` to search history, and so on). It stays put while you type; tapping a key does not dismiss the keyboard.
- **One-finger drag scrolls** the shell output back through the buffer. (Full-screen programs that take over the screen, like an editor or `claude code`, manage their own scrolling, just as in a desktop terminal.)
- **Auto-reconnect**: locking the phone or switching apps drops the connection, but the session keeps running on the server and reconnects on its own the moment you come back, so you land straight back at the prompt. The `Reconnect` button stays as a manual fallback.

On hosts with tmux, sessions keep a large scrollback (50,000 lines). Selecting text with the mouse copies it natively (so copying long blocks works reliably), and `Ctrl+B [` enters tmux's scroll/copy mode to page back through that history. tmux runs on a dedicated socket, isolated from any personal tmux you run on the host.

## Session presets

If you always start a session the same way (say, `cd ~/projects/app` then a command), save it as a **preset**. The `+` button becomes a menu: a blank session, your presets, and "Manage presets…".

A preset has two parts:

- a **working directory** the session opens in (`~` expands to your home; leave it empty for home);
- an **init script** that runs once when the session is created, exactly as if you had typed it (one command per line, so you can `export` a variable then launch a program).

For example, a "Project + Claude" preset with directory `~/projects/hivekeep` and init script `claude --remote-control --dangerously-skip-permission` opens a shell straight in the repo and launches the command. The init script runs only at creation, never on reconnect (a tmux-backed session keeps its process alive; a respawned shell just restores the directory). Presets are per-user and sync across your devices.

## What runs where

- **Bare-metal / systemd installs**: the shell runs as the user the Hivekeep process runs as, starting in its home directory. It sees exactly what the server process sees.
- **Docker**: the shell runs *inside the container*. You get the container's filesystem and tools, which is usually what you want for inspecting `/app/data`, logs, or the workspace volumes. It is not a shell on the Docker host.

## Security notes

A web terminal is equivalent to giving shell access on the server. Hivekeep mitigates this by restricting it to admins, but keep in mind:

- Anyone with an admin account on your instance can run arbitrary commands as the server user.
- If your instance is exposed to the internet, make sure admin accounts have strong passwords.
- You can disable the feature entirely with `HIVEKEEP_TERMINAL_ENABLED=false`. The section then refuses connections and explains why.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HIVEKEEP_TERMINAL_ENABLED` | `true` | Kill-switch for the whole feature. |
| `HIVEKEEP_TERMINAL_SHELL` | `$SHELL`, then `/bin/bash` | Shell binary spawned for each session. |
| `HIVEKEEP_TERMINAL_SCROLLBACK_KB` | `256` | Output kept server-side per session, replayed on reattach. |
| `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` | `0` (never) | Auto-kill a session after this long with no client connected. `0` keeps detached sessions until explicitly closed. |
| `HIVEKEEP_TERMINAL_MAX_SESSIONS` | `10` | Cap of concurrently running shells across all users. |
| `HIVEKEEP_TERMINAL_TMUX` | auto-detect | Set to `off` to never back sessions with tmux even when it is installed (sessions then only restore their scrollback). |
