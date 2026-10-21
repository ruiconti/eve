import { convertReadableStreamToArray, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { IncompleteModelStreamError } from "#harness/incomplete-model-stream.js";
import { withModelStreamIntegrity } from "#harness/model-call/stream-integrity.js";

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const text: StreamPart = { type: "text-delta", id: "text", delta: "Partial answer" };
const finish: StreamPart = {
  type: "finish",
  finishReason: { unified: "other", raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};

function wrap(stream: ReadableStream<StreamPart>) {
  return withModelStreamIntegrity(new MockLanguageModelV4({ doStream: async () => ({ stream }) }));
}

function source(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

describe("provider stream integrity", () => {
  it.each([{ parts: [] }, { parts: [text] }])(
    "appends a typed error at clean EOF without finish ($parts)",
    async ({ parts }) => {
      const { stream } = await wrap(source(parts)).doStream({ prompt: [] });
      expect(await convertReadableStreamToArray(stream)).toEqual([
        ...parts,
        { type: "error", error: expect.any(IncompleteModelStreamError) },
      ]);
    },
  );

  it.each([
    { name: "finish", terminal: finish },
    {
      name: "provider error",
      terminal: { type: "error", error: new Error("upstream") } as StreamPart,
    },
  ])("preserves $name without a second error", async ({ terminal }) => {
    const parts = [text, terminal];
    const { stream } = await wrap(source(parts)).doStream({ prompt: [] });
    expect(await convertReadableStreamToArray(stream)).toEqual(parts);
  });

  it("does not reuse one call's terminal state for another call", async () => {
    const doStream = vi
      .fn()
      .mockResolvedValueOnce({ stream: source([finish]) })
      .mockResolvedValueOnce({ stream: source([text]) });
    const model = withModelStreamIntegrity(new MockLanguageModelV4({ doStream }));
    await convertReadableStreamToArray((await model.doStream({ prompt: [] })).stream);
    expect(
      await convertReadableStreamToArray((await model.doStream({ prompt: [] })).stream),
    ).toEqual([text, { type: "error", error: expect.any(IncompleteModelStreamError) }]);
  });

  it("preserves a thrown stream error rather than replacing it with incomplete EOF", async () => {
    const error = new Error("transport failed");
    const { stream } = await wrap(
      new ReadableStream({
        start(controller) {
          controller.error(error);
        },
      }),
    ).doStream({ prompt: [] });
    await expect(convertReadableStreamToArray(stream)).rejects.toBe(error);
  });

  it("propagates reader cancellation to the provider without synthesizing an error", async () => {
    const cancel = vi.fn();
    const { stream } = await wrap(
      new ReadableStream({
        start(controller) {
          controller.enqueue(text);
        },
        cancel,
      }),
    ).doStream({ prompt: [] });
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(text);
    await reader.cancel("steered");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("steered"));
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("does not classify an aborted provider's clean close as incomplete", async () => {
    const abort = new AbortController();
    const { stream } = await wrap(
      new ReadableStream({
        start(controller) {
          controller.enqueue(text);
          abort.signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      }),
    ).doStream({ prompt: [], abortSignal: abort.signal });
    abort.abort();
    expect(await convertReadableStreamToArray(stream)).toEqual([text]);
  });
});
