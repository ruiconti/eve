import type { ModelMessage, ToolResultPart } from "ai";

import { readTaskTable } from "#execution/tasks/table.js";
import { stepCallIds, withResult } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

/** Repair historical local calls, never executing them or settling work still owned by the runtime. */
export function repairToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly state: SessionStateMap | undefined;
  readonly view: Pick<SessionView, "turn" | "projection">;
  readonly insertionIndex?: number;
}): { messages: ModelMessage[]; insertionIndex: number | undefined } {
  let messages = [...input.messages];
  let insertionIndex = input.insertionIndex;
  const protectedIds = ownedCallIds(input.view, input.state);
  const calls = input.messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "tool-call")
      : [],
  );
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.toolCallId) || call.providerExecuted === true) {
      protectedIds.add(call.toolCallId);
    }
    seen.add(call.toolCallId);
  }
  for (const message of input.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      // Native provider outcomes and SDK approvals keep their own replay semantics.
      if (part.type === "tool-result" || part.type === "tool-approval-request") {
        protectedIds.add(part.toolCallId);
      }
    }
  }

  for (const call of calls) {
    if (protectedIds.has(call.toolCallId)) continue;
    const callIndex = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part === call),
    );
    const results = messages.flatMap((message, index) =>
      message.role === "tool"
        ? message.content.flatMap((part) =>
            part.type === "tool-result" && part.toolCallId === call.toolCallId
              ? [{ part, message, index }]
              : [],
          )
        : [],
    );
    // Ambiguous histories need a separate diagnosis, not another invented result.
    if (results.length > 1) continue;
    const existing = results[0];
    if (existing !== undefined) {
      if (existing.index <= callIndex) continue;
      if (messages.slice(callIndex + 1, existing.index).every((message) => message.role === "tool"))
        continue;
      // Moving message-level provider metadata to a different tool block is not lossless.
      if (existing.message.providerOptions !== undefined) continue;
      const content = existing.message.content.filter((part) => part !== existing.part);
      if (content.length > 0) {
        messages[existing.index] = { ...existing.message, content };
      } else {
        messages.splice(existing.index, 1);
        if (insertionIndex !== undefined && existing.index < insertionIndex) insertionIndex--;
      }
    }
    const result: ToolResultPart = existing?.part ?? {
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: {
        type: "error-text",
        value:
          "The previous attempt ended without a recorded result; execution outcome is unknown; verify external state before repeating side effects.",
      },
    };
    const repaired = withResult(messages, result);
    if (
      insertionIndex !== undefined &&
      repaired.length > messages.length &&
      callIndex + 1 <= insertionIndex
    ) {
      insertionIndex++;
    }
    messages = repaired;
  }
  return { messages, insertionIndex };
}

function ownedCallIds(
  view: Pick<SessionView, "turn" | "projection">,
  state: SessionStateMap | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const step of view.turn.suspended) {
    for (const id of stepCallIds(step)) ids.add(id);
    for (const request of [...step.requests, ...(step.approved ?? [])])
      ids.add(request.action.callId);
    for (const task of step.tasks) ids.add(task.callId);
  }
  for (const run of getBlockingWorkflowToolRuns(state)) ids.add(run.callId);
  for (const task of readTaskTable(state).tasks) {
    for (const call of task.calls) ids.add(call.callId);
    for (const result of task.results) {
      for (const call of result.calls ?? []) ids.add(call.callId);
    }
  }
  for (const input of Object.values(view.projection.inputs)) {
    if (input.status === "settled") continue;
    ids.add(input.request.action.callId);
    if (input.callId !== undefined) ids.add(input.callId);
  }
  for (const call of Object.values(view.projection.calls)) {
    if (
      call.status === "running" ||
      call.status === "awaiting-input" ||
      call.taskId !== undefined
    ) {
      const status = view.projection.turns[call.turnId]?.status;
      if (status === undefined || status === "active") ids.add(call.callId);
    }
  }
  return ids;
}
