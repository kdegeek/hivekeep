---
title: Feedback
description: Star Hivekeep on GitHub and send written feedback (bugs, suggestions, experience) straight from the app.
---

Hivekeep has a built-in way to tell the maintainers what you think, without leaving the app. It covers two things: a quick **GitHub star** call to action, and **written feedback** (a bug, a suggestion, or just how it is going).

## Where to find it

- **Permanent entry**: a Feedback button sits at the bottom of the left navigation rail (and in the user menu on mobile). It is always available, click it whenever you want.
- **Proactive banner**: after you have actually used Hivekeep for a while, a discreet, dismissible banner appears at the top of the chat with three choices: star the repo, give feedback, or "later". It never blocks anything, and "don't ask again" hides it for good.

## What gets sent

Written feedback is relayed to a central collector run by the maintainers. To keep it privacy-friendly, a submission carries only:

- your message and chosen type (bug / suggestion / experience),
- an optional email (only if you want a reply),
- the Hivekeep version,
- an anonymous, per-install identifier (no account or personal data),
- your UI language, for triage.

No secrets, no conversation content, nothing else leaves your instance. Sending feedback is always an explicit click, never automatic.

## Turning it off

Self-hosters who would rather not phone home can disable the whole feature by setting the feedback endpoint to an empty string:

```bash
HIVEKEEP_FEEDBACK_ENDPOINT=
```

With it empty, the Feedback entries and the banner disappear entirely. The thresholds for the proactive banner are configurable too. See [Configuration](/getting-started/configuration/) and the `HIVEKEEP_FEEDBACK_*` variables.
