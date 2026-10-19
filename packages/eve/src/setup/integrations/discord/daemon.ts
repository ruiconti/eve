import { readFile } from "node:fs/promises";

import { isErrnoCode, isObject } from "#shared/guards.js";
import { DEFAULT_CONNECT_PACKAGE_VERSION } from "#setup/scaffold/version-tokens.js";
import {
  formatEveDependencySpecifier,
  resolveEvePackageContract,
} from "#setup/scaffold/create/project.js";

/** Name of the Vercel Daemon that holds the Discord Gateway connection. */
export const DISCORD_DAEMON_NAME = "discord-gateway";

/** Directory of the relay, relative to the project root. */
export const DISCORD_DAEMON_ROOT = "daemon";

// Exactly one instance: each Gateway connection receives every message.
const DISCORD_DAEMON = {
  root: DISCORD_DAEMON_ROOT,
  entrypoint: "Dockerfile",
  instances: { iad1: 1 },
};

/** The relay's files, by path relative to {@link DISCORD_DAEMON_ROOT}. */
export function discordDaemonFiles(connectorUid: string): Readonly<Record<string, string>> {
  const packageJson = {
    private: true,
    type: "module",
    dependencies: {
      "@vercel/connect": DEFAULT_CONNECT_PACKAGE_VERSION,
      eve: formatEveDependencySpecifier(resolveEvePackageContract().version),
    },
  };
  return {
    ".dockerignore": "node_modules\n",
    Dockerfile: `FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY main.ts ./
USER node
CMD ["node", "main.ts"]
`,
    "main.ts": `import { connectDiscordCredentials } from "@vercel/connect/eve";
import { runDiscordGatewayRelay } from "eve/channels/discord/gateway";

await runDiscordGatewayRelay({
  credentials: connectDiscordCredentials(${JSON.stringify(connectorUid)}),
  // Set to true after enabling Message Content Intent under Bot in the Discord
  // Developer Portal, so thread follow-ups that don't mention the bot arrive with their text.
  messageContent: false,
  // Defaults to the project's production URL; set EVE_URL to relay to \`eve dev\`.
  url: process.env.EVE_URL,
});
`,
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
  };
}

/** The `daemons` entry to add by hand to a project configured through `vercel.ts`. */
export function discordDaemonEntry(): string {
  return `daemons: ${JSON.stringify({ [DISCORD_DAEMON_NAME]: DISCORD_DAEMON })}`;
}

/**
 * `vercel.json` with the relay's daemon added, given its current contents or
 * `undefined` when there is none. Returns `undefined` when a daemon of the same
 * name already exists, so the file is left as it is.
 */
export function withDiscordDaemon(vercelJson: string | undefined): string | undefined {
  let config: Record<string, unknown> = { $schema: "https://openapi.vercel.sh/vercel.json" };
  if (vercelJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(vercelJson);
    } catch {
      throw new Error("vercel.json contains invalid JSON; fix it, then run the setup again.");
    }
    if (!isObject(parsed)) throw new Error("vercel.json must contain a JSON object.");
    config = parsed;
  }
  if (config.daemons !== undefined && !isObject(config.daemons)) {
    throw new Error(
      "vercel.json has a `daemons` value that isn't an object; fix it, then run the setup again.",
    );
  }
  const daemons = isObject(config.daemons) ? config.daemons : {};
  if (daemons[DISCORD_DAEMON_NAME] !== undefined) return undefined;
  return `${JSON.stringify({ ...config, daemons: { ...daemons, [DISCORD_DAEMON_NAME]: DISCORD_DAEMON } }, null, 2)}\n`;
}

/** Reads a text file, or `undefined` when there is none. */
export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
}
