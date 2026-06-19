---
title: Files — browse & edit agent workspaces
description: A built-in file browser and editor for your Agents' workspaces — view, edit, organize, upload, and share files without going through an Agent.
---

Every Agent has a **workspace**: a directory on your server where it reads and writes files with its filesystem tools. The **Files** section gives you direct access to those workspaces from the app — browse, edit, organize, upload, and share files yourself, in the browser, without asking an Agent and without downloading/re-uploading anything.

The typical moment: an Agent says "I saved the report in `reports/q2.md`" and you want to tweak it yourself, right now. Open Files (or click the path in the chat), edit, save. None of this triggers an LLM turn — it is a direct view of the disk.

Files is available to all authenticated users, from the activity bar (folder icon) or at `/files`. Beyond Agent workspaces, the same browser also opens **project repositories** (including their git worktrees) and **arbitrary server folders** you add — see [Browse sources](#browse-sources).

## The layout

The page works like a lightweight code editor:

- **Source selector** — a grouped dropdown at the top of the left panel switches between three kinds of source: **Agents** (each Agent's workspace), **Projects** (a project's cloned repo), and **Folders** (any folder on the server you add yourself). The last source you visited is remembered. See [Browse sources](#browse-sources) below.
- **File tree** — folders load lazily as you expand them (a workspace can contain a cloned repo with `node_modules`; nothing is walked until you open it). Everything on disk is shown, dotfiles included. On mobile the tree lives in a slide-in drawer.
- **Tabs** — every opened file gets a tab, with a dirty indicator for unsaved changes. Tabs are remembered per workspace for the session. Closing a dirty tab asks for confirmation, and the browser warns you before leaving the page with unsaved work.
- **Editor / viewers** — the server decides how a file is displayed: text files open in the code editor (with syntax highlighting by extension), images and PDFs render inline, binary or oversized files show a metadata panel with a download button.

You can also jump straight to a specific Agent's files from its agent card or from the conversation header menu ("Browse files").

## Browse sources

The same browser, editor, tabs, search and file operations work over three kinds of source, picked from the grouped selector:

- **Agents** — an Agent's workspace (`data/workspaces/<agentId>/`). This is the default and the only source with the chat integrations (Share, Insert in chat, `@` mentions), since those are tied to a conversation.
- **Projects** — the cloned repository of a [project](/docs/features/projects/) that has a GitHub repo attached (only repos that finished cloning appear). You can edit the repo directly from the browser. When the repo has **git worktrees** (created for sub-task work), a second selector under the source picker lets you switch between the base clone and each live worktree. A small **branch badge** shows the current branch and the number of uncommitted changes — editing the base checkout makes it git-dirty, which the badge surfaces. Worktrees are ephemeral: they come and go as sub-tasks run, and the list reflects whatever git reports right now.
- **Folders** — any absolute folder on the server. Click **Add a folder…** in the selector, give it a name and an absolute path, and it shows up for everyone. Folders are full read/write like a workspace. Use the same dialog to remove a folder later. (Because a folder has no owning Agent, the chat-only actions are hidden for folder sources.)

Project repos and folders are deep-linkable as `/files/project/<id>` and `/files/folder/<id>` (with `?path=` and, for projects, `?worktree=`). Every source goes through the exact same strict path confinement described under [Security notes](#security-notes).

## Editing and conflicts

Editing is explicit: change the file, then save with the **Save** button or `Ctrl/Cmd+S`. There is no auto-save.

Because **the Agent may write the same file while you have it open**, saves use optimistic concurrency: the editor remembers the modification time it read, and if the file changed on disk in between, the save is rejected and a conflict banner appears — *"The file changed on disk since you opened it"* — with two choices: **Reload** (take the disk version) or **Overwrite** (keep yours). If a file you are editing is deleted on disk, the tab stays open with a banner and `Ctrl+S` recreates it; clean tabs close automatically.

The tree itself stays live: file operations made by Agents (writes, edits, downloads into the workspace) are pushed over SSE, so you see files appear and change in real time. Mutations made through a raw shell command are the one gap — the refresh button and re-expanding a folder cover those.

### Markdown preview

Markdown files get an **Edit / Preview** toggle, so you can proofread a report the way it will actually render.

## File operations

Right-click a file or folder (or use the always-visible "⋯" menu on touch devices):

- **New file / New folder** — created inline in the tree. Creating a file never silently overwrites an existing one.
- **Rename** (`F2`) and **move** — drag and drop onto a folder, or cut/paste.
- **Copy / Cut / Paste** (`Ctrl+C/X/V` when the tree is focused) — the clipboard is application-level and works **across workspaces**: copy a file in one Agent's workspace, switch workspace, paste. The copy happens server-side, disk to disk. Name collisions get an automatic ` (copy)` / ` (copy 2)` suffix.
- **Delete** (`Del`) — with confirmation; deleting a folder is recursive.
- **Upload** — drop files from your OS anywhere on the tree (the hovered folder becomes the destination), or use the upload action. Collisions get the ` (copy N)` suffix; an upload never overwrites.
- **Download** — any file, including binaries.
- **Copy relative path** — puts the path on your clipboard.

Recursive copies are budgeted (size and entry count) so a misplaced copy of a giant folder fails fast instead of filling the disk — see [limits](#configurable-limits) below.

## Sharing a file

**Share…** creates a **snapshot** of the file in the [file storage](/docs/agents/tools/) (the same mechanism as the Agents' `store_file` tool) and copies the share URL to your clipboard. You get the usual options: public or private, password, expiration, read-and-burn.

It is a frozen copy — later changes to the workspace file are not reflected in the shared link. The shared file then appears in Settings → File storage, where you can manage or revoke it.

## Files in the chat

The Files section and the conversation are wired together in both directions:

- **Mention a file in the composer** — type `@` and the mention palette gains a **Files** group that searches the current Agent's workspace by name. Selecting a file inserts its relative path in backticks (e.g. `` `reports/q2.md` ``), which the Agent reads with its normal filesystem tools.
- **Clickable paths in messages** — when an Agent (or you) writes a workspace path in a message, it becomes a clickable chip that opens the file in the Files section. Existence is verified server-side, so dead paths stay plain text. Agents are told about this convention in their system prompt, which nudges them to point at files instead of pasting whole contents into the chat.
- **Insert in chat** — from the tree's context menu, append a file's path to the message draft of that Agent's conversation.

## Quick open and shortcuts

`Ctrl/Cmd+P` opens a quick-open dialog that searches the workspace by file name or path — same results as the `@` palette. All shortcuts are listed in the in-app keyboard shortcuts dialog (`?`):

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+S` | Save the active tab |
| `Ctrl/Cmd+P` | Quick open |
| `F2` | Rename the selected tree entry |
| `Del` | Delete the selection (with confirmation) |
| `Ctrl/Cmd+C` / `X` / `V` | Copy / cut / paste (tree focused) |
| `Alt+W` (or middle-click a tab) | Close the active tab |

## Configurable limits

The Files section has a few server-side limits, all overridable by environment variable (see the [configuration reference](/docs/getting-started/configuration/#workspace-files-files-section)):

| Variable | Default | What it bounds |
|---|---|---|
| `WORKSPACE_FILES_MAX_EDITABLE_SIZE` | `5` MB | Above this, a text file is download-only |
| `WORKSPACE_FILES_MAX_UPLOAD_SIZE` | `100` MB | Per-file upload size (`0` = unlimited) |
| `WORKSPACE_FILES_MAX_COPY_SIZE` | `500` MB | Byte budget of a recursive folder copy |
| `WORKSPACE_FILES_COPY_MAX_ENTRIES` | `5000` | Entry budget of a recursive folder copy |
| `WORKSPACE_FILES_SEARCH_MAX_RESULTS` | `50` | Hard cap on search results |
| `WORKSPACE_FILES_SEARCH_MAX_ENTRIES` | `20000` | Files walked per search request |

## Security notes

The HTTP API behind this section is **stricter than the Agents' own filesystem tools**: a path can never leave the target source root (no absolute paths, no `..`, no symlink escape) — and that holds identically for agent workspaces, project repos and folders. Raw file serving never lets the browser sniff content types, and only inert formats (images, PDF, plain text) are ever displayed inline — active formats like SVG or HTML are always downloaded instead.

One deliberate trade-off: a **Folder** source points at an arbitrary absolute path on the server, and (like Agent workspaces) folders are visible and editable by every authenticated user. Add a folder only when you are comfortable with that. The path is canonicalized and re-checked on every browse, so a folder removed from disk fails cleanly rather than escaping its root.

## Related

- [Native Tools](/docs/agents/tools/) — the filesystem tools Agents use on the same workspaces.
- [Configuration](/docs/getting-started/configuration/) — environment variables, including the limits above.
