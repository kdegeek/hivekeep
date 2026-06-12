---
title: Your First Agent
description: Create your first AI agent in Hivekeep.
---

A **Agent** is a persistent AI agent with its own identity, memory, and tools. Unlike disposable chat sessions, an Agent remembers every conversation and builds knowledge over time.

## Creating an Agent

1. Open Hivekeep in your browser (default: `http://localhost:3000`)
2. Complete onboarding with Queenie (set up your admin account and first AI provider)
3. Click **New Agent** in the sidebar
4. Give it a **name**, **description**, and optionally a **system prompt**
5. Choose an AI **model** from your configured providers
6. Start chatting

## What makes an Agent?

| Property | Description |
|---|---|
| **Name** | Display name (e.g. "Research Assistant") |
| **Description** | What this Agent does |
| **System prompt** | Instructions, personality, expertise domain |
| **Model** | Which AI model to use (can be changed anytime) |
| **Avatar** | Visual identity (auto-generated or custom) |

## Key concepts

### Persistent memory

Every conversation is automatically stored. Agents extract important facts into long-term memory and can recall them later using vector similarity + full-text search.

### Session compacting

When a conversation gets long, Hivekeep automatically summarizes older messages to stay within token limits. Original messages are always preserved: compacting is non-destructive and reversible.

### Tools

Agents come with 100+ built-in tools out of the box: web search, memory management, file handling, sub-agent delegation, cron jobs, and more. See [Tools](/docs/agents/tools/) for the full list.

### Collaboration

Agents can talk to each other, delegate tasks to sub-agents, and work on cron schedules. They're not isolated chatbots, they're a team.

## Next steps

- [Configure](/docs/getting-started/configuration/) environment variables and providers
- Learn about [System Prompts](/docs/agents/system-prompts/) for shaping Agent behavior
- Explore [Mini-Apps](/docs/mini-apps/overview/): interactive UIs built by Agents
- Set up [Channels](/docs/channels/overview/) (Telegram, Discord, etc.)
