import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { stampTestEvents } from "#internal/testing/events.js";
import { emitStreamContent } from "#harness/emission.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import type { HarnessEmitFn } from "#harness/types.js";

const EMISSION_STATE: TurnPosition = {
  sequence: 0,
  sessionStarted: true,
  stepIndex: 0,
  turnId: "turn_0",
};

function createEmitStub(): HarnessEmitFn {
  return vi.fn(async () => {});
}

describe("emitStreamContent provider completion", () => {
  it.each([
    { providerExecuted: false, sawFinish: false },
    { providerExecuted: false, sawFinish: true },
    { providerExecuted: true, sawFinish: false },
    { providerExecuted: true, sawFinish: true },
  ])(
    "preserves reducer order and tool outcomes ($providerExecuted, $sawFinish)",
    async ({ providerExecuted, sawFinish }) => {
      let modelCallCompleted = false;
      let release!: () => void;
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedTail!: () => void;
      const tailReached = new Promise<void>((resolve) => {
        reachedTail = resolve;
      });
      const emit = createEmitStub();
      async function* stream(): AsyncIterable<TextStreamPart<ToolSet>> {
        yield { id: "a", text: "A", type: "text-delta" };
        for (const [toolCallId, text] of [
          ["tool1", "B"],
          ["tool2", "C"],
        ] as const) {
          yield {
            type: "tool-call",
            toolCallId,
            toolName: "web_search",
            input: { query: toolCallId },
            providerExecuted,
          };
          yield {
            type: "tool-result",
            toolCallId,
            toolName: "web_search",
            input: { query: toolCallId },
            output: { saved: toolCallId },
            providerExecuted,
          };
          yield { id: text, text, type: "text-delta" };
        }
        reachedTail();
        await pause;
        modelCallCompleted = sawFinish;
        yield { finishReason: "stop", type: "finish-step" } as TextStreamPart<ToolSet>;
      }
      const run = emitStreamContent(emit, EMISSION_STATE, stream(), {
        excludedActionToolNames: new Set(),
        isModelCallComplete: () => modelCallCompleted,
        tools: new Map([
          [
            "web_search",
            {
              name: "web_search",
              description: "Search",
              inputSchema: jsonSchema({ type: "object" }),
            },
          ],
        ]),
      });
      await tailReached;
      await vi.waitFor(() => expect(vi.mocked(emit).mock.calls).toHaveLength(1));
      expect(vi.mocked(emit).mock.calls[0]?.[0]).toMatchObject({
        type: "message.appended",
        data: { messageDelta: "A" },
      });
      release();
      await run;
      const events = vi.mocked(emit).mock.calls.map(([event]) => event);
      expect(
        events
          .filter((event) => event.type === "action.result")
          .map((event) => event.data.result.callId),
      ).toEqual(["tool1", "tool2"]);
      const reducer = defaultMessageReducer();
      const data = stampTestEvents(events).reduce(
        (state, event) => reducer.reduce(state, event),
        reducer.initial(),
      );
      const projection = data.messages
        .flatMap((message) => message.parts)
        .flatMap((part) =>
          part.type === "text"
            ? [part.text]
            : part.type === "dynamic-tool"
              ? [part.toolCallId]
              : [],
        );
      expect(projection).toEqual(
        sawFinish ? ["A", "tool1", "B", "tool2", "C"] : ["A", "tool1", "tool2"],
      );
      expect(events.filter((event) => event.type === "message.completed")).toHaveLength(
        sawFinish ? 3 : 0,
      );
    },
  );

  it.each([false, true])(
    "streams initial deltas but holds the tail at the first completion until provider finish (%s)",
    async (sawFinish) => {
      let modelCallCompleted = false;
      let release!: () => void;
      const pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      const emit = createEmitStub();
      async function* stream(): AsyncIterable<TextStreamPart<ToolSet>> {
        yield { id: "reasoning", text: "Thinking", type: "reasoning-delta" };
        yield { id: "answer", text: "Partial answer", type: "text-delta" };
        await pause;
        modelCallCompleted = sawFinish;
        // The SDK emits this even when the provider never finished.
        yield { finishReason: "other", type: "finish-step" } as TextStreamPart<ToolSet>;
      }
      const run = emitStreamContent(emit, EMISSION_STATE, stream(), {
        excludedActionToolNames: new Set(),
        isModelCallComplete: () => modelCallCompleted,
        tools: new Map(),
      });
      await vi.waitFor(() => {
        expect(
          vi.mocked(emit).mock.calls.some(([event]) => event.type === "reasoning.appended"),
        ).toBe(true);
      });
      expect(vi.mocked(emit).mock.calls.map(([event]) => event.type)).toEqual([
        "reasoning.appended",
      ]);
      release();
      await run;
      const completions = vi
        .mocked(emit)
        .mock.calls.map(([event]) => event.type)
        .filter((type) => type === "message.completed" || type === "reasoning.completed");
      expect(completions).toEqual(sawFinish ? ["reasoning.completed", "message.completed"] : []);
    },
  );
});
