import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";

import { writeTaskTable } from "#execution/tasks/table.js";
import { createUserMessage } from "#harness/messages.js";
import type { SuspendedStep } from "#harness/session-machine/state.js";
import { repairToolHistory } from "#harness/tool-history-repair.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import type { InputRequest } from "#shared/input.js";

const call = {
  type: "tool-call" as const,
  toolCallId: "old-call",
  toolName: "eve__tool",
  input: {},
};
const calling: ModelMessage = { role: "assistant", content: [call] };
const user = createUserMessage("user", "Continue");
const result: ToolResultPart = {
  type: "tool-result",
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  output: { type: "json", value: { saved: true } },
};
const approval: InputRequest = {
  action: { kind: "tool-call", callId: call.toolCallId, toolName: "work", input: {} },
  kind: "tool-approval",
  prompt: "Approve?",
  requestId: "approval",
};
const suspended: SuspendedStep = {
  event: { sequence: 1, stepIndex: 0, turnId: "previous-turn" },
  messages: [calling],
  requests: [],
  tasks: [],
};

function repair(
  messages: readonly ModelMessage[],
  options: Partial<Omit<Parameters<typeof repairToolHistory>[0], "messages">> = {},
) {
  return repairToolHistory({
    messages,
    state: undefined,
    view: { turn: { grants: [], suspended: [] }, projection: initialSessionProjection() },
    ...options,
  });
}

describe("historical tool-result repair", () => {
  it("fills only missing parallel results, retains catalog names, and is idempotent", () => {
    const sibling = { ...call, toolCallId: "sibling" };
    const messages: ModelMessage[] = [
      { role: "assistant", content: [call, sibling] },
      { role: "tool", content: [{ ...result, toolCallId: "sibling" }] },
      user,
    ];
    const original = structuredClone(messages);
    const repaired = repair(messages, { insertionIndex: 2 });
    expect(repaired.insertionIndex).toBe(2);
    expect(repaired.messages).toEqual([
      messages[0],
      {
        role: "tool",
        content: [
          { ...result, toolCallId: "sibling" },
          {
            ...result,
            output: {
              type: "error-text",
              value: expect.stringContaining("execution outcome is unknown"),
            },
          },
        ],
      },
      user,
    ]);
    expect(repair(repaired.messages, { insertionIndex: repaired.insertionIndex })).toEqual(
      repaired,
    );
    expect(messages).toEqual(original);
  });

  it("moves a single late result without changing its output and remaps the context boundary", () => {
    const late: ModelMessage = { role: "tool", content: [result] };
    const repaired = repair([calling, user, late], { insertionIndex: 1 });
    expect(repaired).toEqual({ messages: [calling, late, user], insertionIndex: 2 });
    expect(repair([calling, user, late], { insertionIndex: 3 }).insertionIndex).toBe(3);
  });

  it.each(["provider-call", "inline-result", "sdk-approval"])(
    "does not rewrite %s history",
    (kind) => {
      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content:
            kind === "provider-call"
              ? [{ ...call, providerExecuted: true }]
              : kind === "inline-result"
                ? [call, result]
                : [
                    call,
                    {
                      type: "tool-approval-request",
                      approvalId: "approval",
                      toolCallId: call.toolCallId,
                    },
                  ],
        },
        user,
      ];
      expect(repair(messages).messages).toEqual(messages);
    },
  );

  it.each(["duplicate-call", "duplicate-result", "provider-metadata", "result-before-call"])(
    "leaves ambiguous %s layouts unchanged",
    (kind) => {
      const tool: ModelMessage = {
        role: "tool",
        content: kind === "duplicate-result" ? [result, result] : [result],
      };
      const messages: ModelMessage[] =
        kind === "duplicate-call"
          ? [calling, calling, user]
          : kind === "provider-metadata"
            ? [calling, user, { ...tool, providerOptions: { test: { marker: "keep" } } }]
            : kind === "result-before-call"
              ? [tool, calling, user]
              : [calling, user, tool];
      expect(repair(messages).messages).toEqual(messages);
    },
  );

  it.each(["approval", "approved-sign-in", "workflow", "task-control"])(
    "preserves a suspended %s call",
    (kind) => {
      const pending: SuspendedStep =
        kind === "approval"
          ? { ...suspended, requests: [approval] }
          : kind === "approved-sign-in"
            ? {
                ...suspended,
                approved: [
                  {
                    ...approval,
                    signIns: [
                      {
                        name: "connection",
                        challenge: { instructions: "Sign in." },
                        hookUrl: "https://example.com/callback",
                      },
                    ],
                  },
                ],
              }
            : kind === "workflow"
              ? {
                  ...suspended,
                  tasks: [
                    {
                      kind: "workflow-task",
                      callId: call.toolCallId,
                      toolName: "work",
                      workflowId: "workflow",
                      input: {},
                      entry: { entryPoint: "execute" },
                    },
                  ],
                }
              : {
                  ...suspended,
                  messages: [
                    { role: "assistant", content: [{ ...call, toolName: "eve__task_wait" }] },
                  ],
                };
      const messages = [calling, user];
      const view = {
        turn: { grants: [], suspended: [pending] },
        projection: initialSessionProjection(),
      };
      expect(repair(messages, { view }).messages).toEqual(messages);
    },
  );

  it("preserves a registered workflow even without a suspended transcript", () => {
    const { state } = registerWorkflowToolRun(
      { state: undefined },
      {
        callId: call.toolCallId,
        toolName: "work",
        origin: { turnId: "previous-turn", stepIndex: 0 },
        address: { runId: "run", hookToken: "hook" },
      },
    );
    expect(repair([calling, user], { state }).messages).toEqual([calling, user]);
  });

  it.each([false, true])("preserves task ownership (result awaiting delivery: %s)", (ready) => {
    const calls = [{ callId: call.toolCallId, turnId: "previous-turn" }];
    const { state } = writeTaskTable(
      { state: undefined },
      {
        tasks: [
          {
            id: "task",
            kind: "agent",
            name: "agent",
            resumable: false,
            calls: ready ? [] : calls,
            results: ready ? [{ calls, status: "completed", output: "done" }] : [],
          },
        ],
      },
    );
    expect(repair([calling, user], { state }).messages).toEqual([calling, user]);
  });

  it("preserves open input and live action ownership not present in a suspended transcript", () => {
    const projection = initialSessionProjection();
    const inputView = {
      turn: { grants: [], suspended: [] },
      projection: {
        ...projection,
        inputs: {
          approval: {
            request: approval,
            status: "open" as const,
            sequence: 1,
            stepIndex: 0,
            turnId: "previous-turn",
          },
        },
      },
    };
    expect(repair([calling, user], { view: inputView }).messages).toEqual([calling, user]);
    const liveView = {
      turn: { grants: [], suspended: [] },
      projection: {
        ...projection,
        calls: {
          [call.toolCallId]: {
            callId: call.toolCallId,
            name: "work",
            status: "running" as const,
            stepIndex: 0,
            turnId: "previous-turn",
          },
        },
      },
    };
    expect(repair([calling, user], { view: liveView }).messages).toEqual([calling, user]);
  });
});
