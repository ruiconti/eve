import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import { applyDiscordSetup, prepareDiscordSetup, type DiscordSetupDeps } from "./setup.js";

const ANSWERS = {
  "discord-bot-token": " bot-token ",
  "discord-command-name": "ask",
  "discord-command-description": "Ask the eve agent",
  "discord-messages": "commands",
};
function deps(): DiscordSetupDeps {
  return {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    provisionConnector: vi.fn(async () => ({ id: "connector", uid: "discord/agent" })),
    readVercelJson: vi.fn(async () => '{ "framework": "eve" }'),
    registerCommand: vi.fn(async () => {}),
    resolveApplication: vi.fn(async () => ({ id: "app", name: "Agent", publicKey: "key" })),
    writeTextFile: vi.fn(async () => {}),
  };
}
function contexts(
  answers: Record<string, unknown>,
  resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" })),
  auth: Parameters<typeof integrationSetupEnvironment>[0] = "authenticated",
) {
  return createSetupContexts({
    appRoot: "/project",
    asker: withAnswers(answers)(headlessAsker()),
    environment: integrationSetupEnvironment(auth, { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject,
  });
}

describe("Discord setup", () => {
  it("prepares all input before applying", async () => {
    const effects = deps();
    const ctx = contexts(ANSWERS);
    const plan = await prepareDiscordSetup(ctx.prepare, effects);
    expect(effects.resolveApplication).not.toHaveBeenCalled();
    const completion = await applyDiscordSetup(plan, ctx.apply, effects);
    expect(effects.resolveApplication).toHaveBeenCalledWith("bot-token");
    expect(completion.facts).toContainEqual({
      kind: "url",
      label: "Discord bot install URL",
      value:
        "https://discord.com/oauth2/authorize?client_id=app&scope=bot%20applications.commands&permissions=3072",
    });
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/discord.ts",
      expect.stringContaining("discord/agent"),
      { force: undefined },
    );
  });
  it("scaffolds the Gateway relay when the agent should answer messages", async () => {
    const effects = deps();
    const ctx = contexts({ ...ANSWERS, "discord-messages": "gateway" });
    await applyDiscordSetup(await prepareDiscordSetup(ctx.prepare, effects), ctx.apply, effects);

    const written = new Map(
      vi.mocked(effects.writeTextFile).mock.calls.map(([path, content]) => [path, content]),
    );
    expect(written.get("/project/agent/channels/discord.ts")).toContain("gateway: {},");
    expect(written.get("/project/daemon/main.ts")).toContain(
      'runDiscordGatewayRelay({\n  credentials: connectDiscordCredentials("discord/agent")',
    );
    expect([...written.keys()]).toEqual(
      expect.arrayContaining([
        "/project/daemon/Dockerfile",
        "/project/daemon/package.json",
        "/project/daemon/.dockerignore",
      ]),
    );
    expect(JSON.parse(written.get("/project/vercel.json")!)).toEqual({
      daemons: {
        "discord-gateway": { entrypoint: "Dockerfile", instances: { iad1: 1 }, root: "daemon" },
      },
      framework: "eve",
    });
  });
  it("refuses missing input before mutation", async () => {
    const effects = deps();
    await expect(prepareDiscordSetup(contexts({}).prepare, effects)).rejects.toMatchObject({
      prerequisite: { kind: "environment", variable: "DISCORD_BOT_TOKEN" },
    });
    expect(effects.resolveApplication).not.toHaveBeenCalled();
  });
  it("requires a linked project", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => {
      throw new Error("eve link");
    });
    await expect(
      prepareDiscordSetup(contexts(ANSWERS, resolveVercelProject).prepare, effects),
    ).rejects.toThrow("eve link");
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });
  it("routes logged-out setup through the project resolver", async () => {
    const effects = deps();
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));

    await expect(
      prepareDiscordSetup(contexts(ANSWERS, resolveVercelProject, "logged-out").prepare, effects),
    ).resolves.toMatchObject({ project: { orgId: "team", projectId: "project" } });
    expect(resolveVercelProject).toHaveBeenCalledWith("Discord");
  });
});
