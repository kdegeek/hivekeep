---
title: MCP, Model Context Protocol
description: "Connect external MCP servers to Hivekeep so their tools become callable by your Agents, with global scope, toolbox-based granting, and approval controls."
---

The Model Context Protocol (MCP) is an open standard for exposing tools to an LLM through a small server process. Hivekeep can act as an MCP **client**: you register external MCP servers, Hivekeep launches them, discovers the tools they expose, and makes those tools callable by your Agents alongside Hivekeep's own native tools.

This lets you bolt on capabilities Hivekeep does not ship with, a filesystem server, a database server, a third-party API wrapper, without writing a plugin, as long as the capability already exists as an MCP server.

## How the connection works

Hivekeep connects to MCP servers over **stdio**: it runs a local command, and talks to it over standard input and output. A registered server is defined by:

- **name**: a display name (also used to derive the tool prefix).
- **command**: the executable to run, for example `npx`, `node`, or `python`.
- **args**: an optional list of arguments passed to the command.
- **env**: optional environment variables for the process (merged on top of Hivekeep's own environment). This is where you put the server's API keys or paths. Env values are stored and never sent back to the frontend; the UI only shows which keys exist.

On first use Hivekeep spawns the process, performs the MCP handshake (with a 30-second connection timeout), and calls the server's `listTools` to learn what it offers. Connections are pooled and reused; one live connection per server. Individual tool calls have a 2-minute timeout, and if a call fails because the connection died, Hivekeep reconnects once and retries.

:::note
There is no remote or HTTP transport. Hivekeep launches MCP servers as local child processes via stdio, so the server's command must be runnable on the same host as Hivekeep (the binary or package must be present, for example via `npx`). When Hivekeep shuts down it terminates the whole process tree of each server.
:::

## Registering a server

You manage MCP servers from the app (Settings). Provide the command, args, and any environment variables, then save. A typical example, registering the official filesystem server:

- **name**: `Filesystem`
- **command**: `npx`
- **args**: `["-y", "@modelcontextprotocol/server-filesystem", "/data/shared"]`

After registering you can check the connection status or run a fresh connection test from the UI; the test evicts any cached connection and reconnects so you see the live result and the number of tools discovered.

Servers have a status. An `active` server contributes its tools; a `pending_approval` server contributes nothing until approved (see below). Editing a server's command, args, or env disconnects it so the next call reconnects with the new configuration.

## How the tools surface to Agents

Once a server is active, each of its tools is exposed under a stable, sanitised name:

```
mcp_<server-name>_<tool-name>
```

For example a `read_file` tool on a server named `Filesystem` becomes `mcp_filesystem_read_file`. Names are lowercased and non-alphanumeric characters are collapsed to underscores, so the prefix stays stable even if the server name has spaces or punctuation.

MCP servers are **global**: their tools live in the shared tool universe with no per-Agent access gate, and their credentials stay global. Granting works through **toolboxes**, Hivekeep's single tool-grant mechanism. To let a specific Agent call an MCP tool, add that tool's `mcp_*` name to a toolbox attached to the Agent.

:::caution
The catch-all `all` toolbox expands to every **native** tool (plus enabled custom tools), but it does **not** automatically include MCP tools. MCP (and plugin) tools must be listed by their stable name in a toolbox to be granted. So even with the `all` toolbox, an Agent will not call `mcp_filesystem_read_file` unless that name is explicitly in one of its toolboxes.
:::

When an Agent has MCP tools available, its system prompt includes a short summary listing each external server and how many tools it provides, so the Agent knows the tools exist and can call them like any other tool. The Agent calls them by name; Hivekeep forwards the call to the server and returns the result (text content is extracted and passed back to the Agent).

## Agents that manage MCP themselves

Agents can also create and manage MCP servers through tools, not just admins through the UI:

| Tool | What it does |
|---|---|
| `add_mcp_server` | Register a new server (name, command, args, env). It is auto-linked to the calling Agent. |
| `update_mcp_server` | Change a server's name, command, args, or env (env is merged with existing values). |
| `remove_mcp_server` | Delete a server, disconnect it, and remove it from all Agents. |
| `list_mcp_servers` | List every server on the platform with its command and status. |

## Approval

Because an MCP server runs an arbitrary local command, letting an Agent add one is sensitive. The `MCP_REQUIRE_APPROVAL` setting (default **true**) controls this: when on, a server created by an Agent via `add_mcp_server` starts in `pending_approval` and contributes no tools until an admin approves it from the UI. Hivekeep also raises a persistent notification so you know a server is waiting. Set `MCP_REQUIRE_APPROVAL=false` to let Agent-created servers become active immediately (only do this if you trust what your Agents will register).

## Limits and behaviour to expect

- **stdio only.** No remote MCP endpoints; the server must run locally as a child process.
- **Tools only.** Hivekeep consumes the MCP `listTools` and `callTool` surface. Tool inputs are converted from the server's JSON Schema into the internal schema Agents call against; unusual or deeply nested schemas may be simplified, and unknown shapes fall back to accepting any object.
- **Timeouts.** 30 seconds to connect, 2 minutes per tool call. A failed call triggers one reconnect-and-retry before returning an error to the Agent.
- **Granting is explicit.** Servers are global, but a tool is only callable by an Agent whose toolbox lists that tool's `mcp_*` name.

## Related

- [Native tools](/docs/agents/tools/) for the built-in tools MCP tools sit alongside.
- [Plugins overview](/docs/plugins/overview/) for the in-process alternative when you want to ship a tool, provider, or channel as code rather than connect an external server.
- [Configuration](/docs/getting-started/configuration/) for `MCP_REQUIRE_APPROVAL` and related settings.
