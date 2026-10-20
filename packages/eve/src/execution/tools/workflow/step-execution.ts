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
      let sandboxState: SandboxState | undefined;
      try {
        output = await auth.run(() =>
          Reflect.apply(
            execute,
            this,
            args.map((arg, index) => (invocation.contextIndexes.includes(index) ? ctx : arg)),
          ),
        );
        sandboxState = await sandbox.started();
      } catch (error) {
        // The Workflow SDK recognizes fatal=true; preserve eve's classified error fields.
        if (isConnectionAuthorizationFailedError(error) && !error.retryable) {
          Object.assign(error, { fatal: true });
        }
        throw error;
      } finally {
        await sandbox.release();
      }
      const remaining = context.get(PendingAuthorizationResultKey) ?? [];
      const authorized = input.authorizationResults
        .filter((result) => !remaining.includes(result))
        .map((result) => result.attemptId);
      const reported = sandboxState === undefined ? {} : { sandboxState };
      return isAuthorizationSignal(output)
        ? { kind: "authorization-required", signal: output, authorized, ...reported }
        : { kind: "result", output, authorized, ...reported };
    });
  };
  // The SDK reads retry policy from the registered function at execution time.
  Object.defineProperty(wrapped, "maxRetries", { get: () => Reflect.get(execute, "maxRetries") });
  return wrapped;
}

/**
 * The calling session's sandbox, opened on the step's first `ctx.getSandbox()`
 * and let go of when the step ends. The step never owns it: the session keeps
 * it, and the session's turns may be using it, so the step can neither stop
 * nor delete it. A step that never asks for it loads nothing.
 */
function borrowStepSandbox(input: WorkflowStepContext) {
  const { bundle, sessionId, state } = input.sandbox;
  // The step's own context replaces the delivery's, which carries the
  // development generation a development source resolves to.
  const delivery = contextStorage.getStore();
  const resolveSource = () => resolveDurableCompiledArtifactsSource(bundle.source);
  let borrowing: Promise<BorrowedSandbox> | undefined;
  // Only the session that owns its sandbox ends it, so only it records one a step started.
  let callerOwnsSandbox = false;
  const borrow = async (): Promise<BorrowedSandbox> => {
    const compiled = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource:
        delivery === undefined ? resolveSource() : contextStorage.run(delivery, resolveSource),
      nodeId: bundle.nodeId,
    });
    const node = compiled.graph.root;
    callerOwnsSandbox =
      sessionId === input.session.id && node.sandboxRegistry.sandbox?.definition.kind !== "parent";
    return await borrowSessionSandbox({
      compiledArtifactsSource: compiled.compiledArtifactsSource,
      nodeId: node.nodeId,
      registry: node.sandboxRegistry,
      sessionId,
      state,
      unsupported: (providerName) =>
        fatal(
          `ctx.getSandbox() is unavailable inside a "use step" function of tool "${input.toolName}": ` +
            `sandbox provider "${providerName}" cannot reopen the session's sandbox outside its turns. ` +
            "Use Vercel Sandbox or just-bash for the agent's sandbox, or move the sandbox work into a tool defined with defineTool().",
        ),
    });
  };
  const borrowOnce = (): Promise<BorrowedSandbox> => {
    borrowing ??= borrow().catch((error: unknown) => {
      borrowing = undefined;
      throw error;
    });
    return borrowing;
  };
  return {
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
    /**
     * The sandbox's state when the step started it: the session recorded
     * none when it called the tool, and owns the sandbox the step opened.
     */
    async started(): Promise<SandboxState | undefined> {
      if (state?.session !== undefined && state.session !== null) return undefined;
      const borrowed = await borrowing?.catch(() => undefined);
      if (borrowed === undefined || !callerOwnsSandbox) return undefined;
      const opened = await borrowed.access.captureState();
      return opened.session === null ? undefined : opened;
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

function unavailableInStep(capability: string, guidance: string): never {
  throw fatal(`${capability} is unavailable inside a "use step" function. ${guidance}`);
}

/** A misuse a retry would repeat, which the Workflow SDK fails without retrying. */
function fatal(message: string): Error {
  return Object.assign(new Error(message), { fatal: true });
}
