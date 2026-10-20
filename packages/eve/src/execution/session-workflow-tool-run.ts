import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import { openSessionSandboxStep } from "#execution/tools/workflow/open-session-sandbox-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { AppliedRunMessage } from "#execution/tools/workflow/apply-run-messages-step.js";
import {
  runMessageBatchBudget,
  type WorkflowToolAskRequest,
  type WorkflowToolRunMessage,
  type WorkflowToolRunOutcomeMessage,
  type WorkflowToolRunRef,
  type WorkflowToolRunRequestMessage,
  type WorkflowToolRunWithdrawMessage,
  type WorkflowToolSandboxReply,
} from "#execution/tools/workflow/messages.js";
import { findTask, isTaskWorking, readTaskTable } from "#execution/tasks/table.js";
import {
  withdrawFinishedRunQuestionsStep,
  withdrawWorkflowToolRunQuestionStep,
} from "#execution/tools/workflow/withdraw-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { isWorkflowMessage, type SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { isTaskRunMessage } from "#execution/tasks/session.js";
import {
  workflowToolRunOutcomeToToolResult,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";
import {
  findBlockingWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { SessionStateMap } from "#harness/types.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

export function isAppliedRunMessage(message: WorkflowToolRunMessage): message is AppliedRunMessage {
  return message.kind === "agent-started" || message.kind === "report" || isTaskRunMessage(message);
}

/**
 * Removes the applied run messages at the front of the inbox, in arrival
 * order, while `admits` takes them. One batch's caller passes its budget on.
 */
export function takeLeadingAppliedRunMessages(
  inbox: SessionInboxReader,
  admits = runMessageBatchBudget(),
): AppliedRunMessage[] {
  return inbox.takeLeading(
    (payload): payload is AppliedRunMessage =>
      isWorkflowMessage(payload) && isAppliedRunMessage(payload) && admits(payload),
  );
}

/**
 * Handles a run message the session does not apply as it reads it: a
 * question, its withdrawal, or an `execute` run's outcome.
 */
export async function handleWorkflowToolRunMessage(
  input: HandlerInput<Exclude<WorkflowToolRunMessage, AppliedRunMessage>>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
    // Only task runs report started, reply, or usage, and the session applies those as it reads them.
    case "started":
    case "reply":
    case "usage":
      return undefined;
    case "outcome":
      return await handleWorkflowToolRunOutcome({ ...input, message });
    case "request":
      await handleWorkflowToolRunRequest({ ...input, message });
      return undefined;
    case "withdraw":
      await handleWorkflowToolRunWithdraw({ ...input, message });
      return undefined;
  }
}

/**
 * Settles a workflow tool run outcome against the turn's recorded runs and
 * returns the runtime action result the turn should accept, or `undefined`
 * when the outcome does not bind to a run this turn owns. Requests the run
 * relayed are withdrawn first, since nobody can answer them anymore.
 */
async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { cursor, message } = input;
  const state = cursor.sessionState.snapshot.session.state;
  const recorded = findBlockingWorkflowToolRun(state, message.from.callId, message.from.turnId);
  if (recorded?.address.runId !== message.from.runId) return undefined;

  const result = workflowToolRunOutcomeToToolResult(message);
  if (!isInboxToolResultFromRecordedWorkflowToolRun(state, result)) return undefined;

  if (cursor.sessionState.hasProxyInputRequests) {
    const { runId } = message.from;
    await cursor.advance((current) => withdrawFinishedRunQuestionsStep({ ...current, runId }));
  }
  return result;
}

async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message } = input;
  if (message.request.kind === "sandbox-request") {
    // Only a run still serving a call gets a sandbox, so a late request never opens one for nobody.
    // The reply follows the recording, so no step uses a sandbox the session could lose.
    const reply: WorkflowToolSandboxReply = isServingRun(
      cursor.sessionState.snapshot.session.state,
      message.from,
    )
      ? (await cursor.advance((state) => openSessionSandboxStep(state))).reply
      : {
          kind: "failed",
          message:
            'ctx.getSandbox() in a "use step" function could not open the session\'s sandbox: ' +
            "the call that asked for it is no longer running.",
        };
    await resumeHookStep(message.replyTo, reply, { ifPresent: true });
    return;
  }
  if (message.request.kind === "authorization-request") {
    const request = message.request;
    await deliverWorkflowAuthorization({ ...message, request }, async () => {
      await cursor.advance((state) =>
        runProxySubagentEventStep({ hookPayload: request.event, ...state }),
      );
    });
    return;
  }
  await cursor.advance((state) =>
    runProxySubagentEventStep({
      ...(message.request.kind === "ask" && {
        workflowAsk: createWorkflowAskRoute(message.request),
      }),
      hookPayload: workflowToolRunRequestToInputRequestPayload(message),
      runId: message.from.runId,
      ...state,
    }),
  );
}

/**
 * A run asks to withdraw a `ctx.ask()` question. The session decides: it
 * withdraws the question unless it already accepted an answer or stopped
 * offering it, and tells the run either way.
 */
async function handleWorkflowToolRunWithdraw(
  input: HandlerInput<WorkflowToolRunWithdrawMessage>,
): Promise<void> {
  const { cursor, message } = input;
  await cursor.advance((state) =>
    withdrawWorkflowToolRunQuestionStep({
      ...state,
      control: message.control,
      requestId: message.replyTo,
      runId: message.from.runId,
    }),
  );
}

function createWorkflowAskRoute(ask: WorkflowToolAskRequest): WorkflowAskRoute {
  return { control: ask.control };
}

/** Whether `from` is the run of a call a turn waits on, or of a task still working. */
function isServingRun(state: SessionStateMap | undefined, from: WorkflowToolRunRef): boolean {
  if (from.taskId === undefined) {
    return (
      findBlockingWorkflowToolRun(state, from.callId, from.turnId)?.address.runId === from.runId
    );
  }
  const task = findTask(readTaskTable(state), from.taskId);
  return task !== undefined && isTaskWorking(task) && task.run?.runId === from.runId;
}
