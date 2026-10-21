import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ParentSessionKey } from "#context/keys.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepFn, ToolLoopHarnessConfig } from "#harness/types.js";
import { foldingHandler, parkedSteps, withParkedStep } from "#internal/testing/session-machine.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const call = {
  input: {},
  toolCallId: "call-1",
  toolName: "work",
  type: "tool-call" as const,
};
const text: StreamPart[] = [
  { id: "text", type: "text-start" },
  { delta: "Partial answer", id: "text", type: "text-delta" },
  { id: "text", type: "text-end" },
];

function session(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "integrity-test" },
      system: "Test assistant",
      tools: [{ name: "work", description: "Do work", inputSchema: { type: "object" } }],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:integrity-test",
    history: [],
    sessionId: "integrity-test",
  };
}

function harness(parts: StreamPart[], delegated = false) {
  const events: UnstampedMessageStreamEvent[] = [];
  const execute = vi.fn(async () => ({ saved: true }));
  const doStream = vi.fn(async () => ({
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  }));
  const model: LanguageModel = new MockLanguageModelV4({ doStream });
  const config: ToolLoopHarnessConfig = {
    handleEvent: foldingHandler(async (event) => {
      events.push(event);
    }),
    resolveModel: async () => model,
    tools: new Map([
      [
        "work",
        {
          name: "work",
          description: "Do work",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute,
        },
      ],
    ]),
  };
  const step = createToolLoopHarness(config);
  const run: StepFn = async (state, input) => {
    const ctx = new ContextContainer();
    if (delegated)
      ctx.set(ParentSessionKey, {
        callId: "parent-call",
        rootSessionId: "root",
        sessionId: "parent",
        turn: { id: "parent-turn", sequence: 0 },
      });
    enterSessionProjection(ctx, state.state);
    return contextStorage.run(ctx, () => step(state, input));
  };
  return { doStream, events, execute, run };
}

function expectIncomplete(events: UnstampedMessageStreamEvent[]) {
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "step.failed",
      data: expect.objectContaining({ code: "MODEL_STREAM_INCOMPLETE" }),
    }),
  );
  expect(events.some((event) => event.type === "step.completed")).toBe(false);
  expect(
    events.filter(
      (event) => event.type === "message.completed" && event.data.finishReason !== "tool-calls",
    ),
  ).toEqual([]);
}

describe("provider stream integrity with the real SDK", () => {
  it.each([false, true])(
    "rejects a tool call followed by EOF without replay (delegated: %s)",
    async (delegated) => {
      const { run, execute, doStream, events } = harness([{ ...call, input: "{}" }], delegated);
      const result = await run(session(), { message: "Do work" });
      expect(doStream).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(result.next).toBeNull();
      expect(result.settledTurn?.isError).toBe(true);
      expect(result.session.history).toEqual([]);
      expectIncomplete(events);
    },
  );

  it.each(["empty", "text", "reasoning-only", "reasoning-and-text", "text-and-tool"])(
    "does not commit or deliver a truncated %s stream",
    async (shape) => {
      const reasoning: StreamPart[] = [
        { id: "reasoning", type: "reasoning-start" },
        { id: "reasoning", type: "reasoning-delta", delta: "Partial reasoning" },
        { id: "reasoning", type: "reasoning-end" },
      ];
      const parts =
        shape === "reasoning-only"
          ? reasoning
          : shape === "reasoning-and-text"
            ? [...reasoning, ...text]
            : shape === "text-and-tool"
              ? [...text, { ...call, input: "{}" } satisfies StreamPart]
              : text;
      const { run, events, doStream } = harness(shape === "empty" ? [] : parts);
      const result = await run(session(), { message: "Answer" });
      expect(result.next).toBeNull();
      expect(result.session.history).toEqual([]);
      expect(doStream).toHaveBeenCalledTimes(1);
      expect(
        events.some(
          (event) => event.type === "message.appended" || event.type === "reasoning.appended",
        ),
      ).toBe(shape !== "empty");
      expectIncomplete(events);
    },
  );

  it.each(["stop", "other", "length"] as const)(
    "accepts a real provider %s finish",
    async (unified) => {
      const { run, doStream, events } = harness([
        ...text,
        { type: "finish", finishReason: { raw: undefined, unified }, usage },
      ]);
      await run(session(), { message: "Answer" });
      expect(doStream).toHaveBeenCalledTimes(1);
      expect(events.some((event) => event.type === "step.completed")).toBe(true);
      expect(events.filter((event) => event.type === "message.completed")).toHaveLength(1);
      expect(events.some((event) => event.type === "step.failed")).toBe(false);
    },
  );

  it("keeps a real content-filter finish on the existing filtering path", async () => {
    const { run, doStream, events } = harness([
      ...text,
      { type: "finish", finishReason: { raw: undefined, unified: "content-filter" }, usage },
    ]);
    await run(session(), { message: "Answer" });
    expect(doStream).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "step.failed")).toMatchObject({
      data: { code: "MODEL_CALL_FAILED", details: { finishReason: "content-filter" } },
    });
    expect(events.some((event) => event.type === "message.completed")).toBe(false);
  });

  it("executes and retains a tool call when the provider finishes normally", async () => {
    const { run, execute, events } = harness([
      { ...call, input: "{}" },
      { type: "finish", finishReason: { raw: undefined, unified: "tool-calls" }, usage },
    ]);
    const result = await run(session(), { message: "Do work" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(typeof result.next).toBe("function");
    expect(JSON.stringify(result.session.history)).toContain('"saved":true');
    expect(events.some((event) => event.type === "step.failed")).toBe(false);
  });

  it("preserves genuine provider tool results through SDK finalization after incomplete EOF", async () => {
    const { run, execute, doStream, events } = harness([
      ...text,
      { ...call, input: "{}", providerExecuted: true },
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: { saved: true },
      },
      { ...call, toolCallId: "unanswered", input: "{}", providerExecuted: true },
    ]);
    const result = await run(session(), { message: "Do work" });
    expect(doStream).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    const content = result.session.history.flatMap<unknown>((message) =>
      Array.isArray(message.content) ? message.content : [],
    );
    expect(content).toEqual([
      expect.objectContaining({ type: "tool-call", toolCallId: call.toolCallId }),
      expect.objectContaining({
        type: "tool-result",
        toolCallId: call.toolCallId,
        output: { type: "json", value: { saved: true } },
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "action.result",
        data: expect.objectContaining({
          result: expect.objectContaining({ callId: call.toolCallId }),
        }),
      }),
    );
    expectIncomplete(events);
  });

  it.each([false, true])(
    "retains resolved input transcripts and never replays approved work (delegated: %s)",
    async (delegated) => {
      for (const kind of ["approval", "denial", "question"] as const) {
        const isApproval = kind !== "question";
        const resolvedCall = { ...call, toolName: isApproval ? "work" : "ask_question" };
        const { run, execute, doStream, events } = harness(text, delegated);
        const pending = withParkedStep(session(), {
          tasks: isApproval
            ? []
            : [
                {
                  callId: call.toolCallId,
                  entry: { entryPoint: "execute" },
                  input: {},
                  kind: "workflow-task",
                  toolName: resolvedCall.toolName,
                  workflowId: "workflow//./agent/tools/ask_question//execute",
                },
              ],
          requests: isApproval
            ? [
                {
                  action: {
                    callId: call.toolCallId,
                    input: {},
                    kind: "tool-call",
                    toolName: resolvedCall.toolName,
                  },
                  allowFreeform: false,
                  display: "confirmation",
                  kind: "tool-approval",
                  options: [
                    { id: "approve", label: "Approve" },
                    { id: "cancel", label: "Cancel" },
                  ],
                  prompt: "Choose",
                  requestId: "request-1",
                },
              ]
            : [],
          messages: [{ role: "assistant", content: [resolvedCall] }],
        });
        // Questions now execute in workflow tools; their resolved answer reaches
        // the harness as a runtime result, not as an approval input response.
        const result = await run(
          pending,
          isApproval
            ? {
                inputResponses: [
                  { optionId: kind === "approval" ? "approve" : "cancel", requestId: "request-1" },
                ],
              }
            : {
                runtimeActionResults: [
                  {
                    callId: call.toolCallId,
                    kind: "tool-result",
                    toolName: resolvedCall.toolName,
                    output: { status: "answered", optionId: "chosen" },
                  },
                ],
              },
        );
        expect(doStream).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(kind === "approval" ? 1 : 0);
        expect(parkedSteps(result.session)).toHaveLength(0);
        const transcript = JSON.stringify(result.session.history);
        expect(transcript).toContain('"type":"tool-call"');
        expect(transcript).toContain('"type":"tool-result"');
        expect(transcript).toContain(
          kind === "approval"
            ? '"saved":true'
            : kind === "denial"
              ? "denied"
              : '"optionId":"chosen"',
        );
        expect(transcript).not.toContain("Partial answer");
        expect(result.next).toBeNull();
        expect(result.settledTurn?.isError).toBe(true);
        expectIncomplete(events);
        const resumed = await run(result.session, { message: "Continue" });
        expect(execute).toHaveBeenCalledTimes(kind === "approval" ? 1 : 0);
        expect(resumed.session.history).toEqual(result.session.history);
      }
    },
  );
});
