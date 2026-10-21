import {
  generateText,
  jsonSchema,
  type ModelMessage,
  tool,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { completedToolMessages } from "#harness/incomplete-model-stream.js";
import { prepareModelHistory } from "#harness/model-history.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepFn, ToolLoopHarnessConfig } from "#harness/types.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { foldingHandler } from "#internal/testing/session-machine.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const call = { type: "tool-call" as const, toolCallId: "work-1", toolName: "work", input: "{}" };
const partialText: StreamPart[] = [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "Partial answer" },
  { type: "text-end", id: "text" },
];
const finish: StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: undefined },
  usage,
};

function stream(parts: StreamPart[]): StreamResult {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function session(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "history-test" },
      system: "Test assistant",
      tools: [{ name: "work", description: "Do work", inputSchema: { type: "object" } }],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:history-test",
    history: [],
    sessionId: "history-test",
  };
}

function harness(parts: StreamPart[], toModelOutput?: (output: unknown) => unknown) {
  const execute = vi.fn(async () => ({ saved: true }));
  const sandbox = mockSandbox();
  const events: UnstampedMessageStreamEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: [
      stream(parts),
      stream([
        ...partialText.map((part) =>
          part.type === "text-delta" ? { ...part, delta: "Recovered" } : part,
        ),
        finish,
      ]),
    ],
  });
  const config: ToolLoopHarnessConfig = {
    resolveModel: async () => model,
    handleEvent: foldingHandler(async (event) => {
      events.push(event);
    }),
    tools: new Map([
      [
        "work",
        {
          name: "work",
          description: "Do work",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute,
          toModelOutput,
        },
      ],
    ]),
  };
  const step = createToolLoopHarness(config);
  const run: StepFn = (state, input) => {
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, sandbox.access);
    enterSessionProjection(ctx, state.state);
    return contextStorage.run(ctx, () => step(state, input));
  };
  return { execute, sandbox, events, model, run };
}

function toolParts(messages: readonly ModelMessage[]): (ToolCallPart | ToolResultPart)[] {
  const parts: (ToolCallPart | ToolResultPart)[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call" || part.type === "tool-result") parts.push(part);
    }
  }
  return parts;
}

describe("model history replay with the real SDK", () => {
  it.each(["stored", "unexpected-error"] as const)(
    "prepares completed local file work selected from an incomplete response (%s)",
    async (outcome) => {
      const bytes = pngBytes(8, 8);
      const base64 = bytes.toString("base64");
      const execute = vi.fn(async () => ({ saved: true, image: base64 }));
      const result = await generateText({
        model: new MockLanguageModelV4({
          doGenerate: {
            content: [call],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          },
        }),
        prompt: "Save a chart",
        tools: {
          work: tool({
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute,
            toModelOutput: ({ output }) => ({
              type: "content",
              value: [
                { type: "text", text: `Saved: ${output.saved}` },
                {
                  type: "file",
                  filename: "chart.png",
                  mediaType: "image/png",
                  data: { type: "data", data: output.image },
                },
              ],
            }),
          }),
        },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.response.messages)).toContain(base64);
      const sandbox = mockSandbox();
      const ctx = new ContextContainer();
      ctx.set(SandboxKey, sandbox.access);
      // The current SDK waits for finish before executing local tools. Exercise the
      // shared incomplete-response boundary with its real completed local output.
      const retained = completedToolMessages([
        ...result.response.messages,
        {
          role: "assistant",
          content: [
            { type: "text", text: "Partial answer" },
            { ...call, toolCallId: "unanswered", input: {} },
          ],
        },
      ]);
      const corruption = new TypeError("invalid sandbox path");
      if (outcome === "unexpected-error") {
        vi.spyOn(sandbox.session, "resolvePath").mockImplementation(() => {
          throw corruption;
        });
      }
      const onMediaStagingError = vi.fn();
      const preparation = contextStorage.run(ctx, () =>
        prepareModelHistory({ messages: retained, result, onMediaStagingError }),
      );
      if (outcome === "unexpected-error") {
        await expect(preparation).rejects.toBe(corruption);
        expect(onMediaStagingError).not.toHaveBeenCalled();
        return;
      }
      const prepared = await preparation;
      expect(onMediaStagingError).not.toHaveBeenCalled();
      expect(sandbox.writes).toHaveLength(1);
      expect(sandbox.writes[0]?.content).toEqual(bytes);
      expect(toolParts(prepared.messages)).toEqual([
        expect.objectContaining({ type: "tool-call", toolCallId: call.toolCallId }),
        expect.objectContaining({
          type: "tool-result",
          toolCallId: call.toolCallId,
          output: {
            type: "content",
            value: [
              { type: "text", text: "Saved: true" },
              expect.objectContaining({
                type: "file",
                data: { type: "url", url: expect.objectContaining({ protocol: "eve-sandbox:" }) },
              }),
            ],
          },
        }),
      ]);
      expect(JSON.stringify(prepared.messages)).not.toContain(base64);
      expect(JSON.stringify(prepared.messages)).not.toContain("Partial answer");
      expect(JSON.stringify(prepared.messages)).not.toContain("unanswered");
    },
  );

  it("does not replay an incomplete model call when storing its completed result fails with 503", async () => {
    const base64 = pngBytes(8, 8).toString("base64");
    const { run, model, execute, events, sandbox } = harness(
      [
        ...partialText,
        call,
        {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: { image: base64 },
        },
        { ...call, toolCallId: "saved-2" },
        {
          type: "tool-result",
          toolCallId: "saved-2",
          toolName: call.toolName,
          result: { saved: true },
        },
        { ...call, toolCallId: "unanswered", providerExecuted: true },
      ],
      (output) => {
        const result = output as { image?: string; saved?: boolean };
        return result.image === undefined
          ? { type: "json", value: output }
          : {
              type: "content",
              value: [
                { type: "text", text: "Chart created" },
                {
                  type: "file",
                  filename: "chart.png",
                  mediaType: "image/png",
                  data: { type: "data", data: result.image },
                },
              ],
            };
      },
    );
    const storageError = Object.assign(new Error("sandbox unavailable"), { statusCode: 503 });
    const write = vi.spyOn(sandbox.session, "writeBinaryFile").mockRejectedValue(storageError);
    const incomplete = await run(session(), { message: "Do work" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(incomplete.settledTurn?.isError).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step.failed",
        data: expect.objectContaining({
          code: "MODEL_STREAM_INCOMPLETE",
          details: expect.objectContaining({ statusCode: 503 }),
        }),
      }),
    );
    expect(toolParts(incomplete.session.history)).toEqual([
      expect.objectContaining({ type: "tool-call", toolCallId: call.toolCallId }),
      expect.objectContaining({
        type: "tool-result",
        toolCallId: call.toolCallId,
        output: {
          type: "content",
          value: [
            { type: "text", text: "Chart created" },
            {
              type: "text",
              text: expect.stringMatching(/tool already executed.*could not be stored/i),
            },
          ],
        },
      }),
      expect.objectContaining({ type: "tool-call", toolCallId: "saved-2" }),
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "saved-2",
        output: { type: "json", value: { saved: true } },
      }),
    ]);
    expect(JSON.stringify(incomplete.session.history)).not.toContain(base64);
    expect(JSON.stringify(incomplete.session.history)).not.toContain("Partial answer");
    expect(JSON.stringify(incomplete.session.history)).not.toContain("unanswered");

    const resumed = await run(incomplete.session, { message: "Continue" });
    expect(resumed.settledTurn?.isError).not.toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("replays an inline provider result whose call omitted providerExecuted after EOF", async () => {
    const { run, model, execute, events } = harness([
      ...partialText,
      call,
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: { saved: true },
      },
      { ...call, toolCallId: "unanswered", providerExecuted: true },
    ]);
    const incomplete = await run(session(), { message: "Do work" });
    expect(incomplete.settledTurn?.isError).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step.failed",
        data: expect.objectContaining({ code: "MODEL_STREAM_INCOMPLETE" }),
      }),
    );
    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(toolParts(incomplete.session.history)).toEqual([
      expect.objectContaining({ type: "tool-call", toolCallId: call.toolCallId }),
      expect.objectContaining({
        type: "tool-result",
        toolCallId: call.toolCallId,
        output: { type: "json", value: { saved: true } },
      }),
    ]);
    expect(JSON.stringify(incomplete.session.history)).not.toContain("Partial answer");
    expect(JSON.stringify(incomplete.session.history)).not.toContain("unanswered");

    // A stored transcript is only useful if the SDK accepts it on the next turn.
    const resumed = await run(incomplete.session, { message: "Continue" });
    expect(resumed.settledTurn?.isError).not.toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]?.prompt).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: [expect.objectContaining({ type: "tool-result", toolCallId: call.toolCallId })],
      }),
    );
    expect(JSON.stringify(resumed.session.history)).toContain("Recovered");
    expect(execute).not.toHaveBeenCalled();
  });

  it("stages a genuinely executed local file result and hydrates it on replay", async () => {
    const bytes = pngBytes(8, 8);
    const base64 = bytes.toString("base64");
    const { run, model, execute, sandbox } = harness(
      [call, { ...finish, finishReason: { unified: "tool-calls", raw: undefined } }],
      () => ({
        type: "content",
        value: [
          { type: "text", text: "Saved chart" },
          {
            type: "file",
            filename: "chart.png",
            mediaType: "image/png",
            data: { type: "data", data: base64 },
          },
        ],
      }),
    );
    const completed = await run(session(), { message: "Do work" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.writes[0]?.content).toEqual(bytes);
    expect(JSON.stringify(completed.session.history)).toContain("eve-sandbox:");
    expect(JSON.stringify(completed.session.history)).not.toContain(base64);
    const resumed = await run(completed.session);
    expect(resumed.settledTurn?.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(base64);
    expect(JSON.stringify(resumed.session.history)).not.toContain(base64);
  });
});
