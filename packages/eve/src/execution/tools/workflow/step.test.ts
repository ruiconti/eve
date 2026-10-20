import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  attachWorkflowToolRunContext,
  type WorkflowToolRunContext,
} from "#execution/tools/workflow/ask.js";
import { workflowToolStep } from "#execution/tools/workflow/step.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import type { WorkflowStepInvocation } from "#execution/tools/workflow/step-context.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: () => ({ token: "callback-token" }),
  getWorkflowMetadata: () => ({ url: "https://agent.example", workflowRunId: "run" }),
}));
vi.mock("#execution/hook-ownership.js", () => ({ disposeHook: async () => {} }));

it("preserves native arguments and receivers for calls without workflow context", async () => {
  const original = vi.fn(async function (this: { prefix: string }, value: string) {
    return `${this.prefix}:${value}`;
  });
  const authorize = vi.fn();
  const wrapped = workflowToolStep(original as (...args: unknown[]) => Promise<unknown>, authorize);
  await expect(wrapped.call({ prefix: "native" }, "argument")).resolves.toBe("native:argument");
  expect(authorize).not.toHaveBeenCalled();
  expect(original).toHaveBeenCalledWith("argument");
});

it("preserves the SDK step reference and bind metadata through serialization", async () => {
  const sdk = dirname(createRequire(import.meta.url).resolve("@workflow/core"));
  const { createUseStep } = await import(pathToFileURL(resolve(sdk, "step.js")).href);
  const { getStepFunctionReducer } = await import(
    pathToFileURL(resolve(sdk, "serialization/reducers/step-function-vm.js")).href
  );
  const original = createUseStep({})("step//./steps//read");
  const wrapped = workflowToolStep(original, vi.fn());
  const reduce = getStepFunctionReducer().StepFunction;
  expect(reduce(wrapped)).toEqual(reduce(original));
  const receiver = { service: "api" };
  expect(reduce(wrapped.bind(receiver, "argument"))).toEqual({
    stepId: original.stepId,
    boundThis: receiver,
    boundArgs: ["argument"],
  });
});

it("resumes a sandbox an earlier step of the same call started, and reports it once", async () => {
  const started = {
    session: { providerName: "keyed", state: { key: "s" }, stateProtocolVersion: 1 },
  };
  const sent: unknown[] = [];
  const run = {
    agentContext: {
      bundle: { source: { kind: "bundled" } },
      sandbox: { sessionId: "session" },
    } as AgentSessionContext,
    from: { callId: "call-a" } as WorkflowToolRunRef,
    owner: { send: async (message: unknown) => void sent.push(message), sent: 0 },
  } as { -readonly [K in keyof WorkflowToolRunContext]: WorkflowToolRunContext[K] };
  const ctx = { abortSignal: new AbortController().signal, callId: "call-a", toolName: "deploy" };
  attachWorkflowToolRunContext(ctx, run);
  const received: unknown[] = [];
  const execute = vi.fn(async (invocation: WorkflowStepInvocation) => {
    received.push(invocation.context.sandbox.state);
    // Only the first step finds the sandbox unopened and starts it.
    return received.length === 1
      ? { authorized: [], kind: "result", output: null, sandboxState: started }
      : { authorized: [], kind: "result", output: null };
  });
  const step = workflowToolStep(vi.fn(), execute);
  await step(ctx);
  await step(ctx);
  // A serve task's next call reads its own state: the session may have deleted the sandbox since.
  ctx.callId = "call-b";
  run.from = { callId: "call-b" } as WorkflowToolRunRef;
  run.agentContext = {
    bundle: { source: { kind: "bundled" } },
    sandbox: { sessionId: "session", state: { session: null } },
  } as AgentSessionContext;
  await step(ctx);
  expect(received).toEqual([undefined, started, { session: null }]);
  expect(sent).toEqual([{ from: { callId: "call-a" }, kind: "sandbox-started", state: started }]);
});
