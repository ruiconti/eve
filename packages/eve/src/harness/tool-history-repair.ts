import type { ModelMessage } from "ai";

import { readTaskTable } from "#execution/tasks/table.js";
import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { stepCallIds, withResult } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

/** Answer orphaned historical calls without executing them or settling runtime-owned work. */
export function repairToolHistory(input: {
  readonly messages: readonly ModelMessage[];
  readonly state: SessionStateMap | undefined;
  readonly view: Pick<SessionView, "turn" | "projection">;
  readonly insertionIndex?: number;
}): { messages: ModelMessage[]; insertionIndex: number | undefined } {
  let messages = [...input.messages];
  let insertionIndex = input.insertionIndex;
  const { turn, projection } = input.view;
  // Any recorded result, even misplaced or inline, belongs to its original history.
  const protectedIds = new Set(extractToolResultCallIds(messages));
  for (const step of turn.suspended) {
    for (const id of stepCallIds(step)) protectedIds.add(id);
    for (const request of [...step.requests, ...(step.approved ?? [])])
      protectedIds.add(request.action.callId);
    for (const task of step.tasks) protectedIds.add(task.callId);
  }
  for (const run of getBlockingWorkflowToolRuns(input.state)) protectedIds.add(run.callId);
  for (const task of readTaskTable(input.state).tasks) {
    for (const call of task.calls) protectedIds.add(call.callId);
    for (const result of task.results) {
      for (const call of result.calls ?? []) protectedIds.add(call.callId);
    }
  }
  for (const pending of Object.values(projection.inputs)) {
    if (pending.status === "settled") continue;
    protectedIds.add(pending.request.action.callId);
    if (pending.callId !== undefined) protectedIds.add(pending.callId);
  }
  for (const call of Object.values(projection.calls)) {
    if (
      call.status === "running" ||
      call.status === "awaiting-input" ||
      call.taskId !== undefined
    ) {
      const status = projection.turns[call.turnId]?.status;
      if (status === undefined || status === "active") protectedIds.add(call.callId);
    }
  }
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request") protectedIds.add(part.toolCallId);
      if (part.type !== "tool-call") continue;
      if (seen.has(part.toolCallId) || part.providerExecuted === true)
        protectedIds.add(part.toolCallId);
      seen.add(part.toolCallId);
    }
  }
  for (const message of input.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call.type !== "tool-call" || protectedIds.has(call.toolCallId)) continue;
      const callIndex = messages.indexOf(message);
      const repaired = withResult(messages, {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          type: "error-text",
          value:
            "The previous attempt ended without a recorded result; execution outcome is unknown; verify external state before repeating side effects.",
        },
      });
      if (
        insertionIndex !== undefined &&
        repaired.length > messages.length &&
        callIndex < insertionIndex
      )
        insertionIndex++;
      messages = repaired;
    }
  }
  return { messages, insertionIndex };
}
