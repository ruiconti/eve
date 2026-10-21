import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { HarnessModelMessage } from "#harness/messages.js";
import { answerOrphanedToolCalls } from "./prompt.js";

const call = (id: string, providerExecuted = false) => ({
  input: {},
  providerExecuted,
  toolCallId: id,
  toolName: "lookup",
  type: "tool-call" as const,
});
const result = (id: string) => ({
  output: { type: "text" as const, value: "ok" },
  toolCallId: id,
  toolName: "lookup",
  type: "tool-result" as const,
});

describe("answerOrphanedToolCalls", () => {
  it("returns the same array when every call has a result", () => {
    const messages: ModelMessage[] = [
      { content: [call("a")], role: "assistant" },
      { content: [result("a")], role: "tool" },
    ];
    expect(answerOrphanedToolCalls(messages as HarnessModelMessage[])).toBe(messages);
  });

  it("inserts an error result right after the assistant message with the orphaned call", () => {
    const messages = [
      { content: [call("a"), call("b")], role: "assistant" },
      { content: [result("a")], role: "tool" },
      { content: [call("c")], role: "assistant" },
      { content: "next", kind: "user", role: "user" },
    ] as HarnessModelMessage[];
    const out = answerOrphanedToolCalls(messages);
    expect(out.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
      "user",
    ]);
    const error = (id: string) => ({
      output: {
        type: "error-text",
        value: "interrupted: the tool call has no result, re-run it if still needed",
      },
      toolCallId: id,
      toolName: "lookup",
      type: "tool-result",
    });
    expect(out[1]).toEqual({ content: [error("b")], role: "tool" });
    expect(out[4]).toEqual({ content: [error("c")], role: "tool" });
  });

  it("leaves provider-executed calls answered inside their assistant message", () => {
    const messages = [
      { content: [call("p", true), result("p")], role: "assistant" },
    ] as HarnessModelMessage[];
    expect(answerOrphanedToolCalls(messages)).toBe(messages);
  });
});
