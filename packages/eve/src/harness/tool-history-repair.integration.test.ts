import { jsonSchema, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { createUserMessage } from "#harness/messages.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { setTurnClientContextState } from "#harness/turn-client-context.js";
import type { HarnessSession } from "#harness/types.js";
import { foldingHandler, withOpenTurn } from "#internal/testing/session-machine.js";

const call = { type: "tool-call" as const, toolCallId: "old-call", toolName: "work", input: {} };
const savedResult = {
  type: "tool-result" as const,
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  output: { type: "json" as const, value: { saved: true } },
};

function harness() {
  const execute = vi.fn(async () => ({ saved: true }));
  const doStream = vi.fn<MockLanguageModelV4["doStream"]>(async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text" });
        controller.enqueue({ type: "text-delta", id: "text", delta: "Continuing safely." });
        controller.enqueue({ type: "text-end", id: "text" });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
            outputTokens: { reasoning: 0, text: 1, total: 1 },
          },
        });
        controller.close();
      },
    }),
  }));
  const step = createToolLoopHarness({
    handleEvent: foldingHandler(),
    resolveModel: async () => new MockLanguageModelV4({ doStream }),
    tools: new Map([
      [
        "work",
        {
          name: "work",
          description: "Save work",
          inputSchema: jsonSchema({ type: "object" }),
          execute,
        },
      ],
    ]),
  });
  const run = (session: HarnessSession) => {
    const ctx = new ContextContainer();
    enterSessionProjection(ctx, session.state);
    return contextStorage.run(ctx, () => step(session, { message: "Continue" }));
  };
  return { execute, doStream, run };
}

function session(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "repair-test" },
      system: "Test assistant",
      tools: [{ name: "work", description: "Save work", inputSchema: { type: "object" } }],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:repair-test",
    history: [
      createUserMessage("user", "Save work"),
      { role: "assistant", content: [call] },
      createUserMessage("user", "What happened?"),
    ],
    sessionId: "repair-test",
  };
}

function results(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
  );
}

describe("historical tool repair with the real SDK", () => {
  it("keeps restored client context after the repaired call/result pair", async () => {
    const { run, doStream } = harness();
    const initial = setTurnClientContextState(
      withOpenTurn(session(), { sequence: 1, turnId: "retry-turn" }),
      { turnId: "retry-turn", insertionIndex: 2, messages: ["Client context"] },
    );
    await run(initial);
    expect(doStream).toHaveBeenCalledOnce();
    const prompt = doStream.mock.calls[0]![0].prompt;
    const contextIndex = prompt.findIndex(
      (message) =>
        message.role === "user" &&
        message.content.some((part) => part.type === "text" && part.text === "Client context"),
    );
    expect(contextIndex).toBeGreaterThan(0);
    expect(prompt[contextIndex - 1]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: call.toolCallId }],
    });
    expect(prompt[contextIndex + 1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "What happened?" }],
    });
  });

  it("retains the repair across a failed model call and the next turn", async () => {
    const { run, doStream, execute } = harness();
    doStream.mockRejectedValueOnce(new Error("Model unavailable"));
    const failed = await run(session());
    expect(failed.next).toBeNull();
    expect(results(failed.session.history)).toEqual([
      {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        type: "tool-result",
        output: {
          type: "error-text",
          value: expect.stringContaining("execution outcome is unknown"),
        },
      },
    ]);
    const resumed = await run(failed.session);
    expect(doStream).toHaveBeenCalledTimes(2);
    expect(results(resumed.session.history)).toEqual(results(failed.session.history));
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(resumed.session.history)).toContain("Continuing safely.");
  });

  it.each([false, true])(
    "continues without rerunning an old call (late result: %s)",
    async (lateResult) => {
      const { execute, doStream, run } = harness();
      const initial = session();
      if (lateResult) initial.history.push({ role: "tool", content: [savedResult] });

      const outcome = await run(initial);

      expect(doStream).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      const prompt = doStream.mock.calls[0]![0].prompt;
      const callingIndex = prompt.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) => part.type === "tool-call" && part.toolCallId === call.toolCallId,
          ),
      );
      const resultIndex = prompt.findIndex(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolCallId === call.toolCallId,
          ),
      );
      const laterUserIndex = prompt.findIndex(
        (message) =>
          message.role === "user" &&
          message.content.some((part) => part.type === "text" && part.text === "What happened?"),
      );
      expect(resultIndex).toBe(callingIndex + 1);
      expect(laterUserIndex).toBeGreaterThan(resultIndex);
      const repaired = results(outcome.session.history);
      expect(repaired).toHaveLength(1);
      expect(repaired[0]).toMatchObject(
        lateResult
          ? savedResult
          : {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              type: "tool-result",
              output: {
                type: "error-text",
                value: expect.stringContaining("execution outcome is unknown"),
              },
            },
      );
      expect(JSON.stringify(outcome.session.history)).toContain("Continuing safely.");
    },
  );
});
