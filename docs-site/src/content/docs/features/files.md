---
title: Files — browse & edit agent workspaces
description: A built-in file browser and editor for your Agents' workspaces — view, edit, organize, upload, and share files without going through an Agent.
---

Every Agent has a **workspace**: a directory on your server where it reads and writes files with its filesystem tools. The **Files** section gives you direct access to those workspaces from the app — browse, edit, organize, upload, and share files yourself, in the browser, without asking an Agent and without downloading/re-uploading anything.

The typical moment: an Agent says "I saved the report in `reports/q2.md`" and you want to tweak it yourself, right now. Open Files (or click the path in the chat), edit, save. None of this triggers an LLM turn — it is a direct view of the disk.

Files is available to all authenticated users, from the activity bar (folder icon) or at `/files`.

## The layout

The page works like a lightweight code editor:

- **Workspace selector** — a dropdown at the top of the left panel switches between Agents. Each Agent has exactly one workspace; the last one you visited is remembered.
- **File tree** — folders load lazily as you expand them (a workspace can contain a cloned repo with `node_modules`; nothing is walked until you open it). Everything on disk is shown, dotfiles included. On mobile the tree lives in a slide-in drawer.
- **Tabs** — every opened file gets a tab, with a dirty indicator for unsaved changes. Tabs are remembered per workspace for the session. Closing a dirty tab asks for confirmation, and the browser warns you before leaving the page with unsaved work.
- **Editor / viewers** — the server decides how a file is displayed: text files open in the code editor (with syntax highlighting by extension), images and PDFs render inline, binary or oversized files show a metadata panel with a download button.

You can also jump straight to a specific Agent's files from its agent card or from the conversation header menu ("Browse files").

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

The HTTP API behind this section is **stricter than the Agents' own filesystem tools**: a path can never leave the target workspace (no absolute paths, no `..`, no symlink escape). Raw file serving never lets the browser sniff content types, and only inert formats (images, PDF, plain text) are ever displayed inline — active formats like SVG or HTML are always downloaded instead.

## Related

- [Native Tools](/docs/agents/tools/) — the filesystem tools Agents use on the same workspaces.
- [Configuration](/docs/getting-started/configuration/) — environment variables, including the limits above.
