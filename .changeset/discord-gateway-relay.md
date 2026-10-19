---
"eve": patch
---

The Discord channel can now answer DMs, mentions, and thread replies. `discordChannel({ gateway: {} })` accepts messages forwarded from the Discord Gateway, and `runDiscordGatewayRelay` from the new `eve/channels/discord/gateway` entry point holds that connection, for example in a Vercel Daemon. `defaultDiscordMessageAuth` gives a message's author the same principal `defaultDiscordAuth` gives them for commands and button presses.
