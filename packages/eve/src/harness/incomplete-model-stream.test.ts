import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  completedToolMessages,
  IncompleteModelStreamError,
} from "#harness/incomplete-model-stream.js";
import { classifyModelCallError } from "#harness/model-call/errors.js";

const call = {
  input: {},
  toolCallId: "executed",
  toolName: "work",
  type: "tool-call" as const,
};
const result = {
  output: { type: "json" as const, value: { saved: true } },
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  type: "tool-result" as const,
};

describe("incomplete model stream", () => {
  it("never classifies an incomplete stream as an automatic retry", () => {
    const error = Object.assign(new IncompleteModelStreamError(), { isRetryable: true });
    expect(classifyModelCallError(error)).toBe("recoverable");
  });

  it("retains completed call/result pairs without partial text or unanswered calls", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Partial" },
          call,
          { ...call, toolCallId: "unanswered" },
          { type: "tool-approval-request", approvalId: "pending", toolCallId: "unanswered" },
        ],
      },
      { role: "tool", content: [result] },
    ];
    expect(completedToolMessages(messages)).toEqual([
      { role: "assistant", content: [call] },
      { role: "tool", content: [result] },
    ]);
    expect(messages[0]?.content).toHaveLength(4);
  });

  it("retains pre-request approval results whose call is already in prompt history", () => {
    expect(
      completedToolMessages([
        { role: "tool", content: [result] },
        { role: "assistant", content: "Partial" },
      ]),
    ).toEqual([{ role: "tool", content: [result] }]);
  });

  it("retains provider-executed inline results and tool errors", () => {
    const errorResult = { ...result, output: { type: "error-text" as const, value: "Failed" } };
    expect(
      completedToolMessages([
        { role: "assistant", content: [call, errorResult, { type: "text", text: "Partial" }] },
      ]),
    ).toEqual([{ role: "assistant", content: [call, errorResult] }]);
  });
});
