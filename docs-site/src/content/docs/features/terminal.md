---
title: Terminal — a shell on your server
description: An admin-only web terminal on the Hivekeep host (or inside the container under Docker), straight from the app.
---

The **Terminal** section gives administrators a real shell on the machine running Hivekeep — the host itself, or the container when you run the Docker image. It is a full PTY rendered with xterm.js: interactive programs, colors, tab completion, `htop`, `vim`, everything works as in a native terminal.

The typical moment: an Agent just wrote files to its workspace, a cron failed, or you want to check disk usage — open Terminal from the activity bar and look for yourself, without SSH-ing into the box.

Terminal is **admin-only**: the entry only appears for admin users, and the server rejects non-admin connections regardless of what the client does.

## Persistent sessions, on every device

Terminal works like a lightweight tmux. Shells run server-side and **survive disconnects**: close the laptop, open Hivekeep on your phone, and the sessions sidebar shows the same running shells — pick one and you are back where you left off, recent output replayed. This is ideal for long-running interactive work, like driving one or more `claude code` instances directly on the machine that hosts Hivekeep.

The sidebar lists your sessions (sessions are private to each user). From there you can:

- **Create** a new session (the + button) — each gets an auto name like "Session 2", rename it to something meaningful ("claude code prod") via the row menu.
- **Switch** between sessions — a green dot marks sessions that currently have a client attached.
- **Close** a session (row menu, with confirmation) — this kills the shell and everything running in it.

A session only ends when its shell exits, when you close it from the sidebar, or when the server restarts (sessions live in process memory). If you prefer idle detached sessions to be reaped automatically, set `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` to a number of seconds (off by default).

Several tabs or devices can view the **same session at once**: output mirrors to every attached client and any of them can type, exactly like a shared tmux session. As in tmux, the terminal is sized to the smallest attached viewer so line wrapping stays coherent everywhere.

## What runs where

- **Bare-metal / systemd installs**: the shell runs as the user the Hivekeep process runs as, starting in its home directory. It sees exactly what the server process sees.
- **Docker**: the shell runs *inside the container*. You get the container's filesystem and tools, which is usually what you want for inspecting `/app/data`, logs, or the workspace volumes. It is not a shell on the Docker host.

## Security notes

A web terminal is equivalent to giving shell access on the server. Hivekeep mitigates this by restricting it to admins, but keep in mind:

- Anyone with an admin account on your instance can run arbitrary commands as the server user.
- If your instance is exposed to the internet, make sure admin accounts have strong passwords.
- You can disable the feature entirely with `HIVEKEEP_TERMINAL_ENABLED=false` — the section then refuses connections and explains why.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HIVEKEEP_TERMINAL_ENABLED` | `true` | Kill-switch for the whole feature. |
| `HIVEKEEP_TERMINAL_SHELL` | `$SHELL`, then `/bin/bash` | Shell binary spawned for each session. |
| `HIVEKEEP_TERMINAL_SCROLLBACK_KB` | `256` | Output kept server-side per session, replayed on reattach. |
| `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` | `0` (never) | Auto-kill a session after this long with no client connected. `0` keeps detached sessions until explicitly closed. |
| `HIVEKEEP_TERMINAL_MAX_SESSIONS` | `10` | Cap of concurrently running shells across all users. |
