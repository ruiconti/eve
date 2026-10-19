---
"eve": patch
---

`eve add channel/discord` now asks whether the agent should also answer DMs, mentions, and threads. Choosing it scaffolds the Discord Gateway relay in `daemon/`, registers it as a Vercel Daemon in `vercel.json`, enables `gateway` on the channel, and prints an install URL with the thread permissions. Non-interactive runs answer `discord-messages` with `"gateway"` or `"commands"`.
