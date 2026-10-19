import { join } from "node:path";

import { select, text } from "#setup/ask.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { deriveSlackConnectorSlug } from "#setup/scaffold/index.js";
import { writeTextFile } from "#setup/scaffold/files.js";

import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  configureDiscordInteractionsEndpoint,
  registerDiscordCommand,
  resolveDiscordApplication,
} from "./api.js";
import { provisionDiscordConnector } from "./connect.js";
import {
  DISCORD_DAEMON_ROOT,
  discordDaemonFiles,
  readVercelJson,
  withDiscordDaemon,
} from "./daemon.js";

export interface DiscordSetupDeps {
  configureEndpoint: typeof configureDiscordInteractionsEndpoint;
  deriveConnectorSlug: typeof deriveSlackConnectorSlug;
  provisionConnector: typeof provisionDiscordConnector;
  readVercelJson: typeof readVercelJson;
  registerCommand: typeof registerDiscordCommand;
  resolveApplication: typeof resolveDiscordApplication;
  writeTextFile: typeof writeTextFile;
}

const defaultDeps: DiscordSetupDeps = {
  configureEndpoint: configureDiscordInteractionsEndpoint,
  deriveConnectorSlug: deriveSlackConnectorSlug,
  provisionConnector: provisionDiscordConnector,
  readVercelJson,
  registerCommand: registerDiscordCommand,
  resolveApplication: resolveDiscordApplication,
  writeTextFile,
};

function validateCommandName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Command name is required.";
  if (name.length > 32) return "Command name must be 32 characters or fewer.";
  return /^[a-z0-9_-]+$/.test(name)
    ? null
    : "Use lowercase letters, numbers, hyphens, or underscores.";
}

function connectTemplate(uid: string, gateway: boolean): string {
  return `import { connectDiscordCredentials } from "@vercel/connect/eve";
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
  credentials: connectDiscordCredentials(${JSON.stringify(uid)}),${gateway ? "\n  gateway: {}," : ""}
});
`;
}

/** View Channels and Send Messages, for slash command replies. */
const COMMAND_PERMISSIONS = "3072";
/** Also Read Message History, Create Public Threads, and Send Messages in Threads. */
const GATEWAY_PERMISSIONS = "309237713920";

/** Which messages reach the agent: slash commands only, or also ordinary messages over the Gateway. */
type DiscordMessages = "commands" | "gateway";

interface DiscordSetupPlan {
  botToken: string;
  messages: DiscordMessages;
  commandName: string;
  commandDescription: string;
  project: VercelProjectReference;
  slug: string;
}

export async function prepareDiscordSetup(
  context: SetupPrepareContext,
  deps: DiscordSetupDeps = defaultDeps,
): Promise<DiscordSetupPlan> {
  context.presenter.log.info(
    "Create a Discord application or open an existing one, then go to Bot → Reset Token and copy the new bot token.\nCreate: https://discord.com/developers/applications?new_application=true\nExisting applications: https://discord.com/developers/applications",
  );
  const botToken = (
    await context.asker.ask(
      text({
        key: "discord-bot-token",
        message: "Discord bot token",
        required: true,
        sensitive: true,
        environment: "DISCORD_BOT_TOKEN",
      }),
    )
  ).trim();
  const commandName = await context.asker.ask(
    text({
      key: "discord-command-name",
      message: "Discord command name",
      detected: "ask",
      required: true,
      validate: validateCommandName,
    }),
  );
  const commandDescription = await context.asker.ask(
    text({
      key: "discord-command-description",
      message: "Discord command description",
      detected: "Ask the eve agent",
      required: true,
      validate: (value) =>
        value.trim().length === 0
          ? "Command description is required."
          : value.trim().length > 100
            ? "Command description must be 100 characters or fewer."
            : null,
    }),
  );
  const messages = await context.asker.ask(
    select({
      key: "discord-messages",
      message: "Which Discord messages should the agent answer?",
      options: [
        {
          id: "gateway",
          value: "gateway" as const,
          label: "DMs, mentions, and threads, plus slash commands",
          hint: "Adds a Discord Gateway relay that runs as a Vercel Daemon (beta)",
        },
        {
          id: "commands",
          value: "commands" as const,
          label: "Slash commands only",
          hint: "No long-running process",
        },
      ],
      recommended: "gateway" as const,
      required: true,
    }),
  );
  const project = await context.resolveVercelProject("Discord");
  return {
    botToken,
    messages,
    commandName: commandName.trim(),
    commandDescription: commandDescription.trim(),
    project,
    slug: await deps.deriveConnectorSlug(context.appRoot),
  };
}

export async function applyDiscordSetup(
  plan: DiscordSetupPlan,
  context: SetupApplyContext,
  deps: DiscordSetupDeps = defaultDeps,
) {
  const application = await deps.resolveApplication(plan.botToken);
  const connector = await deps.provisionConnector({
    botToken: plan.botToken,
    log: context.presenter.log,
    project: plan.project,
    projectRoot: context.projectRoot,
    slug: plan.slug,
    signal: context.signal,
  });
  await deps.registerCommand(application.id, plan.botToken, {
    name: plan.commandName,
    description: plan.commandDescription,
  });
  await deps.configureEndpoint(plan.botToken, connector.id);
  const gateway = plan.messages === "gateway";
  await deps.writeTextFile(
    join(context.appRoot, "agent/channels/discord.ts"),
    connectTemplate(connector.uid, gateway),
    { force: context.force },
  );
  if (gateway) {
    for (const [path, content] of Object.entries(discordDaemonFiles(connector.uid))) {
      await deps.writeTextFile(join(context.projectRoot, DISCORD_DAEMON_ROOT, path), content, {
        force: context.force,
      });
    }
    const vercelJson = withDiscordDaemon(await deps.readVercelJson(context.projectRoot));
    if (vercelJson !== undefined) {
      await deps.writeTextFile(join(context.projectRoot, "vercel.json"), vercelJson, {
        force: true,
      });
    }
  }
  const installUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(application.id)}&scope=${encodeURIComponent("bot applications.commands")}&permissions=${gateway ? GATEWAY_PERMISSIONS : COMMAND_PERMISSIONS}`;
  context.presenter.nextSteps([
    gateway
      ? `Install the Discord application, then DM the bot, mention it, or try /${plan.commandName}: ${installUrl}`
      : `Install the Discord application, then try /${plan.commandName}: ${installUrl}`,
    ...(gateway
      ? [
          `Deploy to start the Gateway relay in ${DISCORD_DAEMON_ROOT}/. Daemons are in beta; run one instance per bot.`,
          `To read thread follow-ups that don't mention the bot, enable Message Content Intent under Bot in the Discord Developer Portal, then set messageContent: true in ${DISCORD_DAEMON_ROOT}/main.ts.`,
        ]
      : []),
  ]);
  return {
    deploymentRequired: true as const,
    facts: [
      {
        label: "Discord application dashboard",
        value: `https://discord.com/developers/applications/${application.id}/information`,
        kind: "url" as const,
      },
    ],
  };
}

export const DISCORD_SETUP = defineSetupIntegration({
  kind: "discord",
  label: "Discord",
  hint: "Messages, DMs, and slash commands",
  prepare: prepareDiscordSetup,
  apply: applyDiscordSetup,
});
