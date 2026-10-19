---
"eve": patch
---

`eve add channel/discord` now first asks whether people reach the agent through DMs, mentions, and threads, or a slash command. The first scaffolds the Discord Gateway relay in `daemon/`, registers it as a Vercel Daemon in `vercel.json`, enables `gateway` on the channel, and skips registering `/ask`; the second keeps today's slash command setup. Non-interactive runs answer `discord-messages` with `"gateway"` or `"commands"`.
