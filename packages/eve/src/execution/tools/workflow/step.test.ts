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
import type {
  WorkflowStepInvocation,
  WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

const hooks = vi.hoisted(() => ({ replies: [] as unknown[] }));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  // Awaiting a hook yields its first payload. Only a reply hook waits for its registration,
  // and it receives the next queued reply.
  createHook: () => {
    let deliver!: (value: unknown) => void;
    const payload = new Promise((resolve) => (deliver = resolve));
    return Object.assign(payload, {
      token: "reply-token",
      getConflict: async () => {
        deliver(hooks.replies.shift());
        return null;
      },
    });
  },
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

it("asks the session for its sandbox once per call and runs the step again with its state", async () => {
  const opened = {
    session: { providerName: "custom", state: { id: "sbx" }, stateProtocolVersion: 1 },
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
  const execute = vi.fn(async (invocation: WorkflowStepInvocation): Promise<WorkflowStepResult> => {
    const { state } = invocation.context.sandbox;
    received.push(state);
    return state?.session == null
      ? { authorized: [], kind: "sandbox-required" }
      : { authorized: [], kind: "result", output: "done" };
  });
  const step = workflowToolStep(vi.fn(), execute);
  const request = {
    from: { callId: "call-a" },
    kind: "request",
    replyTo: "reply-token",
    request: { kind: "sandbox-request" },
  };
  hooks.replies.push({ kind: "opened", state: opened });
  await expect(step(ctx)).resolves.toBe("done");
  // A later step of the same call resumes the state the session sent.
  await expect(step(ctx)).resolves.toBe("done");
  expect(received).toEqual([undefined, opened, opened]);
  expect(sent).toEqual([request]);

  // A serve task's next call asks again; the session's answer can be that it could not open one.
  ctx.callId = "call-b";
  run.from = { callId: "call-b" } as WorkflowToolRunRef;
  hooks.replies.push({ kind: "failed", message: "could not open the session's sandbox: quota" });
  await expect(step(ctx)).rejects.toThrow("could not open the session's sandbox: quota");
  expect(sent).toEqual([request, { ...request, from: { callId: "call-b" } }]);
});
