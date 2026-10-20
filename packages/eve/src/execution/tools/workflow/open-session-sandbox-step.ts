import { SandboxKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { WorkflowToolSandboxReply } from "#execution/tools/workflow/messages.js";
import { createLogger, logError } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("workflow-step");

/**
 * Opens the session's sandbox for a workflow step that asked for it, exactly
 * as the session's turns open it, and records its state, so the session alone
 * allocates its sandbox and ends it with the session. A sandbox the session
 * already recorded is only handed over: requests run one after another, so
 * concurrent first requests start one sandbox.
 */
export async function openSessionSandboxStep(
  input: SessionStepState,
): Promise<SessionStateTransition & { readonly reply: WorkflowToolSandboxReply }> {
  "use step";
  return await withSessionStateDelta(input, async (current): Promise<OpenedSessionSandbox> => {
    const durable = readDurableSession(current.sessionState);
    if (durable.sandboxState?.session != null) {
      return { reply: { kind: "opened", state: durable.sandboxState } };
    }
    const ctx = await deserializeContext(current.serializedContext);
    const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
    const session = hydrateDurableSession({
      compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
      durable,
      turnAgent: effectiveAgent.turnAgent,
    });
    try {
      const scoped = await withContextScope(ctx, session, async (enriched) => ({
        result: await ctx.get(SandboxKey)?.get(),
        session: enriched,
      }));
      const state = scoped.session.sandboxState;
      if (scoped.result == null || state?.session == null) {
        return { reply: failed("the agent does not define a sandbox") };
      }
      return {
        reply: { kind: "opened", state },
        sessionState: replaceDurableSessionSnapshot({
          session: { ...durable, sandboxState: state },
          state: current.sessionState,
        }),
      };
    } catch (error) {
      logError(log, "failed to open the session's sandbox for a workflow step", error, {
        sessionId: durable.sessionId,
      });
      return { reply: failed(error instanceof Error ? error.message : String(error)) };
    }
  });
}

interface OpenedSessionSandbox {
  readonly reply: WorkflowToolSandboxReply;
  readonly sessionState?: DurableSessionState;
}

function failed(reason: string): WorkflowToolSandboxReply {
  return {
    kind: "failed",
    message: `ctx.getSandbox() in a "use step" function could not open the session's sandbox: ${reason}`,
  };
}
