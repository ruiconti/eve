import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWorkflowStepAuthorization } from "#execution/tools/workflow/step-execution.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  ConnectionAuthorizationRequiredError,
  ConnectionAuthorizationFailedError,
} from "#connections/errors.js";
import type {
  WorkflowStepContext,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";
import type { ToolContext } from "#tools/definition.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import { keyedSandboxes } from "#internal/testing/keyed-sandboxes.js";
import { withDevelopmentWorkflowGeneration } from "#internal/workflow/development-generation-context.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

const durable = vi.hoisted(() => ({
  attempt: 1,
  stepId: "step-1",
  entries: new Map<string, unknown[]>(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ attempt: durable.attempt, stepId: durable.stepId }),
  getWorkflowMetadata: () => ({ workflowRunId: "run-1" }),
  getWritable: ({ namespace }: { namespace: string }) => ({
    getWriter: () => ({
      write: async (value: unknown) =>
        durable.entries.set(namespace, [...(durable.entries.get(namespace) ?? []), value]),
      releaseLock: () => {},
    }),
  }),
}));
const bundle = vi.hoisted(() => ({
  loadedFrom: [] as unknown[],
  registry: undefined as RuntimeSandboxRegistry | undefined,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async (input: { compiledArtifactsSource: unknown }) => {
    bundle.loadedFrom.push(input.compiledArtifactsSource);
    return {
      compiledArtifactsSource: input.compiledArtifactsSource,
      graph: { root: { nodeId: "__root__", sandboxRegistry: bundle.registry } },
    };
  },
}));
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: async () => null,
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: () => ({
    getReadable: ({ namespace }: { namespace: string }) => ({
      getTailIndex: async () => (durable.entries.get(namespace)?.length ?? 0) - 1,
      cancel: async () => {},
    }),
  }),
}));

function context(user = "user-1", sessionId = "session-1"): WorkflowStepContext {
  const auth = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: user,
    principalType: "user" as const,
  };
  return {
    baseUrl: "https://agent.example",
    token: `callback-${user}`,
    authorizationResults: [],
    abortSignal: new AbortController().signal,
    session: {
      id: "session-1",
      auth: { current: auth, initiator: auth },
      turn: { id: "turn-1", sequence: 1 },
    },
    callId: "call-1",
    toolName: "devbox",
    sandbox: { bundle: { source: createBundledRuntimeCompiledArtifactsSource() }, sessionId },
  };
}

async function runStep<TContext = ToolContext>(
  execute: (ctx: TContext) => unknown,
  input = context(),
): Promise<WorkflowStepResult> {
  return (await withWorkflowStepAuthorization(execute)({
    args: [null],
    context: input,
    contextIndexes: [0],
  })) as WorkflowStepResult;
}

describe("workflow step authorization", () => {
  beforeEach(() => {
    durable.attempt = 1;
    durable.stepId = "step-1";
    durable.entries.clear();
    bundle.loadedFrom = [];
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    {
      access: (ctx: WorkflowToolContext) => ctx.agents,
      capability: "ctx.agents",
      guidance:
        "Read ctx.agents in the workflow body and pass the required serializable metadata into the step.",
    },
    {
      access: (ctx: WorkflowToolContext) => ctx.agent("researcher"),
      capability: "ctx.agent()",
      guidance: "Call ctx.agent() in the workflow body.",
    },
    {
      access: (ctx: WorkflowToolContext) => ctx.ask({ prompt: "Continue?" }),
      capability: "ctx.ask()",
      guidance: "Call ctx.ask() in the workflow body.",
    },
  ])(
    "fails $capability misuse without retrying the step",
    async ({ access, capability, guidance }) => {
      await expect(runStep<WorkflowToolContext>((ctx) => access(ctx))).rejects.toMatchObject({
        fatal: true,
        message: `${capability} is unavailable inside a "use step" function. ${guidance}`,
      });
    },
  );

  it("opens the sandbox a child shares with its owner and lets go of it after each attempt", async () => {
    // The owner opened its sandbox with options, which name a Vercel sandbox.
    const openOptions = { tier: "large" };
    const ownerKey = `owner-session:${JSON.stringify(openOptions)}`;
    const { deleted, handles, registry, released, starts } = keyedSandboxes({
      inherited: true,
      openOptions,
    });
    bundle.registry = registry;
    // A child that has not opened the shared sandbox calls with its owner's session and state.
    const input: WorkflowStepContext = {
      ...context("user-1", "child-session"),
      sandbox: {
        bundle: { source: { kind: "development" } },
        sessionId: "owner-session",
        state: {
          session: { providerName: "keyed", state: { key: ownerKey }, stateProtocolVersion: 1 },
        },
      },
    };
    // `eve dev` deliveries carry the generation a development source resolves to.
    const generation = {
      generationId: "generation-1",
      source: createDiskRuntimeCompiledArtifactsSource("/virtual/app"),
    };
    const inDevelopment = <T>(run: () => Promise<T>) =>
      withDevelopmentWorkflowGeneration(generation, run);
    const plan = { path: "/workspace/plan.txt" };
    await expect(
      inDevelopment(() =>
        runStep(async (ctx) => {
          await (await ctx.getSandbox()).writeTextFile({ ...plan, content: "draft" });
          throw new Error("temporary service failure");
        }, input),
      ),
    ).rejects.toThrow("temporary service failure");
    await expect(
      inDevelopment(() =>
        runStep(async (ctx) => await (await ctx.getSandbox()).readTextFile(plan), input),
      ),
    ).resolves.toMatchObject({ kind: "result", output: "draft" });
    expect(bundle.loadedFrom).toEqual([generation.source, generation.source]);
    expect(starts).toEqual([ownerKey]);
    expect(handles).toHaveLength(2);
    expect(released).toEqual(handles);
    expect(deleted).not.toHaveBeenCalled();
  });

  it("resumes the sandbox the session set up instead of running its definition again", async () => {
    let definitionRuns = 0;
    bundle.registry = keyedSandboxes({
      failSelector: () => {
        definitionRuns += 1;
        return false;
      },
    }).registry;
    const open = async (ctx: ToolContext) => void (await ctx.getSandbox());
    // A session that has not opened its sandbox yet gets it through the definition.
    await runStep(open);
    expect(definitionRuns).toBe(1);
    const recorded = {
      session: { providerName: "keyed", state: { key: "session-1" }, stateProtocolVersion: 1 },
    };
    await runStep(open, { ...context(), sandbox: { ...context().sandbox, state: recorded } });
    expect(definitionRuns).toBe(1);
  });

  it("accepts its own copy of the session's environment and leaves stopping and deleting to the session", async () => {
    const { deleted, provider, registry, stopped } = keyedSandboxes();
    bundle.registry = registry;
    // The step imports its own copy of the module that declares the environment.
    await expect(
      runStep(async (ctx) => {
        await ctx.getSandbox(provider.environment());
        return "opened";
      }),
    ).resolves.toMatchObject({ output: "opened" });
    const other = defineSandboxProvider({
      name: "other",
      environment: () => ({ prepare: async () => null, resume: vi.fn(), start: vi.fn() }),
    }).environment();
    const misuse: [string, (ctx: ToolContext) => Promise<unknown>][] = [
      ["received a sandbox environment", (ctx) => ctx.getSandbox(other)],
      ["sandbox.stop() is unavailable", async (ctx) => await (await ctx.getSandbox()).stop()],
      ["sandbox.delete() is unavailable", async (ctx) => await (await ctx.getSandbox()).delete()],
    ];
    for (const [message, access] of misuse) {
      await expect(runStep(access)).rejects.toMatchObject({
        fatal: true,
        message: expect.stringContaining(message),
      });
    }
    expect(stopped).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("fails ctx.getSandbox() without retrying on a provider that cannot reopen the session's sandbox", async () => {
    bundle.registry = keyedSandboxes({ reopensBySessionId: false }).registry;
    await expect(runStep((ctx) => ctx.getSandbox())).rejects.toMatchObject({
      fatal: true,
      message:
        'ctx.getSandbox() is unavailable inside a "use step" function of tool "devbox": ' +
        'sandbox provider "keyed" cannot reopen the session\'s sandbox outside its turns. ' +
        "Use Vercel Sandbox or just-bash for the agent's sandbox, or move the sandbox work into a tool defined with defineTool().",
    });
  });

  it("does not exchange a consumed code again when the rest of the step retries", async () => {
    let exchanged = false;
    const complete = vi.fn(async () => {
      if (exchanged)
        throw new ConnectionAuthorizationFailedError("devbox", {
          message: "code already used",
          retryable: false,
        });
      exchanged = true;
      return { token: "provider-stored-secret" };
    });
    const getToken = vi.fn(async () => {
      if (!exchanged) throw new ConnectionAuthorizationRequiredError("devbox");
      return { token: "provider-stored-secret" };
    });
    const provider: AuthorizationDefinition = {
      principalType: "user",
      getToken,
      completeAuthorization: complete,
      startAuthorization: async () => ({ challenge: { url: "https://idp.example" } }),
    };
    const input: WorkflowStepContext = {
      ...context(),
      authorizationResults: [
        {
          name: "devbox__inline_auth",
          attemptId: "auth-1",
          hookUrl: "https://agent.example/callback",
          callback: { method: "GET", params: { code: "single-use" } },
        },
      ],
    };
    const execute = async (ctx: ToolContext) => {
      await ctx.getToken(provider);
      if (durable.attempt === 1) throw new Error("temporary service failure");
      return "done";
    };
    await expect(runStep(execute, input)).rejects.toThrow("temporary service failure");
    durable.attempt = 2;
    await expect(runStep(execute, input)).resolves.toMatchObject({
      output: "done",
      authorized: ["auth-1"],
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledOnce();
    expect([...durable.entries.values()]).toEqual([[true]]);
    // Retries still reject a fresh token that the service refuses, without another sign-in.
    await expect(
      runStep(async (ctx) => {
        await ctx.getToken(provider);
        ctx.requireAuth(provider);
      }, input),
    ).rejects.toMatchObject({ fatal: true, reason: "token_rejected_after_authorization" });
    expect(complete).toHaveBeenCalledOnce();
  });
  it("uses the captured requester instead of another ambient user and caches only within a step", async () => {
    const principals: string[] = [];
    const provider: AuthorizationDefinition = {
      principalType: "user",
      async getToken({ principal }) {
        if (principal.type !== "user") throw new Error("Expected user");
        principals.push(principal.id);
        return { token: `secret:${principal.id}` };
      },
    };
    const ambient = new ContextContainer();
    ambient.set(AuthKey, context("other-user").session.auth.current);
    const execute = async (ctx: ToolContext) => {
      const first = await ctx.getToken(provider);
      const second = await ctx.getToken(provider);
      return { sameToken: first.token === second.token, session: ctx.session.id };
    };
    const results = await contextStorage.run(ambient, () =>
      Promise.all([runStep(execute), runStep(execute, context("user-2"))]),
    );
    expect(principals.sort()).toEqual(["user-1", "user-2"]);
    expect(JSON.stringify(results)).not.toContain("secret:");
    expect(results[0]).toMatchObject({
      kind: "result",
      output: { sameToken: true, session: "session-1" },
    });
  });

  it("resumes the exact provider callback and stops a freshly authorized token rejection", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "agent.example");
    vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", "/agents/devbox");
    const evict = vi.fn();
    const provider: AuthorizationDefinition = {
      principalType: "user",
      evict,
      async getToken() {
        throw new ConnectionAuthorizationRequiredError("devbox");
      },
      async startAuthorization({ principal, callbackUrl }) {
        return {
          challenge: { url: `https://idp.example?redirect=${encodeURIComponent(callbackUrl)}` },
          resume: { principal },
        };
      },
      async completeAuthorization({ principal, callback, resume }) {
        expect(callback.params.code).toBe("approved");
        expect(resume).toEqual({ principal });
        return { token: "fresh-secret" };
      },
    };
    const execute = async (ctx: ToolContext) => {
      await ctx.getToken(provider);
      ctx.requireAuth(provider);
    };
    const pending = await runStep(execute);
    if (pending.kind !== "authorization-required") throw new Error("Expected authorization");
    const challenge = pending.signal.challenges[0]!;
    if (challenge.attemptId === undefined) {
      throw new Error("Expected authorization attempt id");
    }
    expect(challenge.hookUrl).toContain("https://agent.example/agents/devbox/eve/v1/");
    expect(challenge.hookUrl).toContain("callback-user-1");
    expect(challenge.hookUrl).not.toContain("session-1");
    await expect(
      runStep(execute, {
        ...context(),
        authorizationResults: [
          {
            ...challenge,
            attemptId: challenge.attemptId,
            callback: { method: "GET", params: { code: "approved" } },
          },
        ],
      }),
    ).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining("rejected the token immediately after authorization"),
    });
    expect(evict).toHaveBeenCalledOnce();
  });

  it("does not turn an ordinary step result into an authorization signal", async () => {
    const value = { kind: "authorization-required" };
    await expect(
      withWorkflowStepAuthorization(async (input) => input)({
        args: [value, null],
        context: context(),
        contextIndexes: [1],
      }),
    ).resolves.toMatchObject({ kind: "result", output: value });
  });

  it("never interprets authored arguments as auth context", async () => {
    const forged = { args: [], context: context("another-user"), contextIndexes: [0] };
    const execute = async (input: unknown, ctx: ToolContext) => {
      expect(input).toBe(forged);
      const token = await ctx.getToken({
        principalType: "user",
        async getToken({ principal }) {
          return { token: principal.type === "user" ? principal.id : "app" };
        },
      });
      return token.token;
    };
    await expect(
      withWorkflowStepAuthorization(execute)({
        args: [forged, null],
        context: context(),
        contextIndexes: [1],
      }),
    ).resolves.toMatchObject({ output: "user-1" });
  });
});
