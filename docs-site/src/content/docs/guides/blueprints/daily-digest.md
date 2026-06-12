---
title: "Blueprint: Daily Digest"
description: A copy-paste-ready blueprint for an Agent that curates daily tech news, monitors sources, and delivers a summary report.
---

This blueprint sets up an Agent that runs on a daily schedule to gather information from the web, summarize it, and deliver a structured digest. Use it for tech watch, competitor monitoring, industry news, or any recurring research task.

## Use case

You want to:
- Automatically scan multiple sources for news on topics you care about
- Get a concise, structured daily summary without manual searching
- Build a knowledge base of trends and developments over time
- Optionally receive the digest via Telegram, Discord, or another channel

## What you'll need

| Requirement | Details |
|---|---|
| **LLM Provider** | Anthropic (Claude Sonnet 4 or Sonnet 3.5) — strong tool use required |
| **Embedding Provider** | Any (for memory) |
| **Search Provider** | Recommended: Brave Search, Tavily, Perplexity, or Serper |
| **Channel** (optional) | Telegram, Discord, or Slack for delivery |

:::note
A search provider is strongly recommended for this blueprint. Without one, the Agent can still use `browse_url` to check specific websites, but won't be able to do broad topic searches.
:::

## System prompt

### Character

```
You are a meticulous research analyst and news curator. You scan multiple sources,
cross-reference information, and distill it into clear, actionable summaries.

You distinguish between facts and speculation. You cite sources.
You highlight what's genuinely new vs. what's a rehash of old news.

You write concise, scannable reports — bullet points over paragraphs,
headlines over introductions. Busy people read your reports.

You ACT — you search the web, read pages, and compile results using tools.
You never simulate or describe research you haven't actually done.
```

### Expertise

```
You are an expert at information gathering, analysis, and summarization.
You know how to use web search effectively — crafting precise queries,
evaluating source credibility, and extracting key facts.

Your tech domains include: artificial intelligence, software development,
cloud computing, open source, and startup ecosystem.
(Adjust these to your actual interests.)

You use memorize() to build a persistent knowledge base of important developments.
You reference previous digests via recall() to track trends over time.
```

## Cron configuration

Ask your Agent:

> Create a cron job called "Daily Tech Digest" that runs every day at 7:00 AM UTC (schedule: "0 7 * * *"). Use this task description:

### Full task description

```
You are compiling a daily tech digest. Today's date is provided in your context.

## Mission

Search for and summarize the most important developments in your focus areas
from the last 24 hours.

## Focus areas

1. Artificial Intelligence — new models, research breakthroughs, industry moves
2. Open Source — notable releases, funding, community events
3. Cloud & Infrastructure — service announcements, outages, pricing changes
4. Software Development — new tools, frameworks, language updates

(Customize these to your interests.)

## Process

1. For each focus area:
   a. Use web_search with freshness="pd" (past day) to find recent news
   b. Search for 2-3 different queries per area to get broad coverage
   c. Use browse_url to read the most promising results
   d. Extract key facts, quotes, and links

2. Compile the digest with this structure:
   ## 🗞️ Daily Tech Digest — [Today's Date]

   ### 🔥 Top Story
   (The single most important development of the day)

   ### 🤖 AI & Machine Learning
   - **Headline**: Brief summary. [Source](url)
   - ...

   ### 🌐 Open Source
   - ...

   ### ☁️ Cloud & Infrastructure
   - ...

   ### 💻 Development & Tools
   - ...

   ### 📊 Trend Watch
   (Any patterns you're noticing across multiple days — reference previous digests via recall)

3. Save important facts to memory using memorize() for trend tracking:
   - Major product launches or acquisitions
   - Funding rounds > $50M
   - Significant open source milestones
   - Breaking changes in major tools

4. If a messaging channel is available, send the digest using send_channel_message

5. Call update_task_status("completed", digest_text)

## Quality standards

- Include 3-5 items per section (skip a section if nothing notable happened)
- Every claim must have a source URL
- Distinguish between confirmed news and rumors/speculation
- If you found nothing new in an area, say so honestly — don't pad
- Use recall() to check if you're repeating something from a previous digest

## Previous run context

If you received results from the previous run, use them to:
- Avoid repeating the same stories
- Track developing stories ("Day 2 of the X outage...")
- Note trend changes
```

## Delivering via a channel

If you have a messaging channel configured (Telegram, Discord, etc.), add this to the task description:

```
## Delivery

After compiling the digest, deliver it via messaging channel:
1. Call list_channels to find available channels
2. Call list_channel_conversations on the channel to find the target chat
3. Send the digest using send_channel_message

Format the digest appropriately for the platform:
- Telegram: Use Markdown formatting, keep it under 4096 characters
- Discord: Use Discord markdown, split into multiple messages if needed
- Slack: Use Slack mrkdwn format
```

## Self-calibration (wake the parent Agent)

By default a cron runs silently: its final report is injected into the owner Agent's context, but the Agent is never woken to act on it. If you want the Agent to **re-read its own digest at the end of each run and adjust its behavior** (refine the prompt, decide on a conditional action, fix a recurring quality issue), enable the "Wake the parent Agent at the end of the run" toggle when creating or editing the cron (`trigger_parent_turn` in the `create_cron` / `update_cron` tools).

When enabled, the final report triggers a real LLM turn on the owner Agent. The Agent can then, for example:
- Call `update_cron(cron_id, { task_description: "..." })` to tune its own instructions based on what worked or didn't
- Take a conditional follow-up action depending on what the digest surfaced
- Save a lesson via memory for the next run

:::caution
This generates an LLM turn (token consumption) on **every** execution. For a frequent cron this adds up. Use it for low-frequency, high-value crons (daily/weekly) where the feedback loop is worth it, and disable it once the cron is well calibrated.
:::

## Variations

### Competitor monitoring

Replace the focus areas with competitors:

```
## Focus areas

1. Competitor A (company name) — product updates, pricing changes, new features
2. Competitor B — hiring patterns, blog posts, social media activity
3. Industry — regulatory changes, market reports, analyst commentary
```

### Research paper digest

Focus on academic sources:

```
## Process

1. Search for recent papers on arxiv using web_search:
   - Query: "site:arxiv.org <your-topic> 2026"
   - Query: "<your-topic> paper published this week"
2. For each promising paper, browse the abstract page
3. Summarize: title, authors, key contribution, why it matters
```

### Security bulletin

Focus on vulnerabilities and patches:

```
## Focus areas

1. CVEs — new critical/high severity vulnerabilities
2. Patches — security updates from major vendors
3. Threats — new attack patterns, active exploits
4. Advisories — CISA, vendor security bulletins
```

## Expected output

A successful daily run produces something like:

```markdown
## 🗞️ Daily Tech Digest — April 3, 2026

### 🔥 Top Story
**Anthropic releases Claude 4 Opus** — The new flagship model shows significant
improvements in agentic tool use and long-context reasoning. Available now via API.
[Source](https://example.com/article)

### 🤖 AI & Machine Learning
- **Google DeepMind publishes Gemini 3 technical report**: 2M token context window,
  native multi-modal reasoning. [Source](https://example.com)
- **Hugging Face launches open model leaderboard v3**: New evaluation suite focused
  on tool use and agentic capabilities. [Source](https://example.com)
- **EU AI Act enforcement begins**: First compliance deadline for general-purpose AI
  providers. [Source](https://example.com)

### 🌐 Open Source
- **Bun 1.3 released**: Native SQLite improvements, 40% faster test runner.
  [Source](https://example.com)

### ☁️ Cloud & Infrastructure
- (Nothing notable in the last 24 hours)

### 📊 Trend Watch
Third consecutive week of major AI model releases. The focus has shifted from
raw capability benchmarks to tool use and agent reliability — aligning with
the broader "agentic AI" narrative we've been tracking since March.
```

## Troubleshooting

### Digest is empty or has no real content

- Check that your **search provider** is configured and working (test with a manual web search)
- The `freshness="pd"` parameter in `web_search` filters to the past day — if there's genuinely no news, the digest will be light
- Try broadening your search queries

### Agent summarizes without actually searching

This is the "text mode" problem — the Agent is generating plausible-sounding content without calling `web_search`. Verify:
1. The task output shows actual `web_search` tool calls
2. Switch to Claude Sonnet if you're on a different model
3. See [Model Selection](/docs/guides/model-selection/) for details

### Digest quality is low

- Add more specific search queries to the task description
- Include example outputs so the Agent knows what quality looks like
- Use the `recall()` instruction to build up domain knowledge over time

### Channel delivery fails

- Verify the channel is active: check **Settings > Channels**
- The sub-Agent needs channel tools available — they shouldn't be in `disabledNativeTools`
- Check that the `chat_id` is correct (use `list_channel_conversations` to find it)

### Cron runs but produces duplicate content

- Ensure the task description includes the `recall()` instruction to check previous digests
- The "previous run context" feature helps — the sub-Agent receives the last run's result automatically
