import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SandboxKey, SessionIdKey, SessionKey } from "#context/keys.js";
import type { SessionContext } from "#context/session-context.js";
import { borrowSessionSandbox, type BorrowedSandbox } from "#execution/sandbox/borrow.js";
import { createLogger, logError } from "#internal/logging.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  hasSameSandboxEnvironmentConfiguration,
  type SandboxEnvironmentIdentity,
} from "#shared/sandbox-environment.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  isAuthorizationSignal,
  PendingAuthorizationResultKey,
  AuthorizationHookKey,
  CallbackBaseUrlKey,
} from "#harness/authorization.js";
import { createAuthorizationContext } from "#runtime/authorization-context.js";
import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { completeWorkflowStepAuthorization } from "#execution/tools/workflow/authorization-completion.js";
import {
  type WorkflowStepContext,
  type WorkflowStepInvocation,
  type WorkflowStepResult,
} from "#execution/tools/workflow/step-context.js";

const log = createLogger("workflow-step");

/** Keeps token capabilities and bearer values inside the executing step. */
export function withWorkflowStepAuthorization(execute: (...args: never[]) => unknown) {
  const wrapped = async function (
    this: unknown,
    invocation: WorkflowStepInvocation,
  ): Promise<unknown> {
    const { args, context: input } = invocation;
    getStepMetadata();
    const context = new ContextContainer();
    context.set(AuthKey, input.session.auth.current);
    context.set(InitiatorAuthKey, input.session.auth.initiator);
    context.set(SessionIdKey, input.session.id);
    context.setVirtualContext(SessionKey, { ...input.session, sessionId: input.session.id });
    context.set(CallbackBaseUrlKey, resolveWorkflowCallbackBaseUrl(input.baseUrl));
    context.setVirtualContext(AuthorizationHookKey, input.token);
    context.setVirtualContext(PendingAuthorizationResultKey, input.authorizationResults);

    const sandbox = borrowStepSandbox(input);
    return contextStorage.run(context, async (): Promise<WorkflowStepResult> => {
      const auth = createAuthorizationContext({
        scope: input.toolName,
        completeAuthorization: completeWorkflowStepAuthorization,
      });
      const base = buildBaseToolContext({
        toolName: input.toolName,
        options: { abortSignal: input.abortSignal, toolCallId: input.callId },
      });
      const ctx = {
        ...base,
        agent: () => unavailableInStep("ctx.agent()", "Call ctx.agent() in the workflow body."),
        ask: () => unavailableInStep("ctx.ask()", "Call ctx.ask() in the workflow body."),
        getSandbox: (async (environment?: SandboxEnvironmentIdentity) => {
          const access = await sandbox.open();
          // The step imports its own copy of the module that declares the
          // environment, so the same provider and configuration match.
          if (
            environment !== undefined &&
            (access.environment === undefined ||
              !hasSameSandboxEnvironmentConfiguration(access.environment, environment))
          ) {
            throw fatal(
              'ctx.getSandbox() in a "use step" function received a sandbox environment the session\'s sandbox does not use. ' +
                "Pass the environment the agent's sandbox definition opens, or call ctx.getSandbox() without one.",
            );
          }
          context.setVirtualContext(SandboxKey, access);
          return await base.getSandbox();
        }) as SessionContext["getSandbox"],
        getToken: auth.getToken,
        requireAuth: auth.requireAuth,
      };
      Object.defineProperty(ctx, "agents", {
        get: () =>
          unavailableInStep(
            "ctx.agents",
            "Read ctx.agents in the workflow body and pass the required serializable metadata into the step.",
          ),
      });
      let output: unknown;
      try {
        output = await auth.run(() =>
          Reflect.apply(
            execute,
            this,
            args.map((arg, index) => (invocation.contextIndexes.includes(index) ? ctx : arg)),
          ),
        );
      } catch (error) {
        // The Workflow SDK recognizes fatal=true; preserve eve's classified error fields.
        if (isConnectionAuthorizationFailedError(error) && !error.retryable) {
          Object.assign(error, { fatal: true });
        }
        if (!sandbox.required) throw error;
      } finally {
        await sandbox.release();
      }
      const remaining = context.get(PendingAuthorizationResultKey) ?? [];
      const authorized = input.authorizationResults
        .filter((result) => !remaining.includes(result))
        .map((result) => result.attemptId);
      // Whatever the step did after asking, it runs again once the session opened its sandbox.
      if (sandbox.required) return { kind: "sandbox-required", authorized };
      return isAuthorizationSignal(output)
        ? { kind: "authorization-required", signal: output, authorized }
        : { kind: "result", output, authorized };
    });
  };
  // The SDK reads retry policy from the registered function at execution time.
  Object.defineProperty(wrapped, "maxRetries", { get: () => Reflect.get(execute, "maxRetries") });
  return wrapped;
}

/**
 * The calling session's sandbox, resumed on the step's first `ctx.getSandbox()`
 * from the state the session recorded, and let go of when the step ends. Only
 * the session allocates its sandbox: without recorded state the step asks the
 * session to open it, and runs again once it has. The step never owns the
 * sandbox: the session's turns may be using it, so the step can neither stop
 * nor delete it. A step that never asks for it loads nothing.
 */
function borrowStepSandbox(input: WorkflowStepContext) {
  const { bundle, sessionId, state } = input.sandbox;
  // The step's own context replaces the delivery's, which carries the
  // development generation a development source resolves to.
  const delivery = contextStorage.getStore();
  const resolveSource = () => resolveDurableCompiledArtifactsSource(bundle.source);
  let borrowing: Promise<BorrowedSandbox> | undefined;
  let required = false;
  const borrow = async (recorded: SandboxState): Promise<BorrowedSandbox> => {
    const compiled = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource:
        delivery === undefined ? resolveSource() : contextStorage.run(delivery, resolveSource),
      nodeId: bundle.nodeId,
    });
    const node = compiled.graph.root;
    return await borrowSessionSandbox({
      compiledArtifactsSource: compiled.compiledArtifactsSource,
      nodeId: node.nodeId,
      registry: node.sandboxRegistry,
      sessionId,
      state: recorded,
      tracksHandle: false,
    });
  };
  const borrowOnce = (): Promise<BorrowedSandbox> => {
    if (state?.session == null) {
      required = true;
      throw new SandboxRequired();
    }
    borrowing ??= borrow(state).catch((error: unknown) => {
      borrowing = undefined;
      throw error;
    });
    return borrowing;
  };
  return {
    /** Whether the step asked for a sandbox the session has not opened yet. */
    get required() {
      return required;
    },
    async open(): Promise<SandboxAccess> {
      const { access } = await borrowOnce();
      return {
        ...access,
        delete: () =>
          unavailableInStep(
            "sandbox.delete()",
            "The step borrows the session's sandbox, and only the session can delete it.",
          ),
        stop: () =>
          unavailableInStep(
            "sandbox.stop()",
            "The session's turns may be using the sandbox; eve lets go of the step's handle when the step ends.",
          ),
      };
    },
    async release(): Promise<void> {
      const borrowed = await borrowing?.catch(() => undefined);
      await borrowed?.release().catch((error: unknown) => {
        logError(log, "failed to release a workflow step's sandbox", error, {
          sessionId: input.sandbox.sessionId,
          toolName: input.toolName,
        });
      });
    },
  };
}

/** Ends a step that asked for the session's sandbox before the session opened it. */
class SandboxRequired extends Error {
  constructor() {
    super("The session has not opened its sandbox yet; the step runs again once it has.");
  }
}

function unavailableInStep(capability: string, guidance: string): never {
  throw fatal(`${capability} is unavailable inside a "use step" function. ${guidance}`);
}

/** A misuse a retry would repeat, which the Workflow SDK fails without retrying. */
function fatal(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}
