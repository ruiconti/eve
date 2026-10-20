import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionBundle } from "#execution/agent-sessions/context.js";
import type { AuthorizationResult, AuthorizationSignal } from "#harness/authorization.js";
import type { SandboxState } from "#sandbox/state.js";

export type WorkflowStepAuthorizationResult = AuthorizationResult & {
  readonly attemptId: string;
  readonly name: string;
};

export interface WorkflowStepContext {
  readonly callId: string;
  readonly toolName: string;
  readonly session: SessionContext["session"];
  readonly abortSignal: AbortSignal;
  readonly baseUrl: string;
  readonly token: string;
  readonly authorizationResults: readonly WorkflowStepAuthorizationResult[];
  readonly sandbox: WorkflowStepSandbox;
}

/** Where `ctx.getSandbox()` finds the calling session's sandbox: its agent and sandbox session. */
export interface WorkflowStepSandbox {
  readonly bundle: AgentSessionBundle;
  /** The session whose sandbox the caller uses: its own, or the owner's it inherits. */
  readonly sessionId: string;
  /**
   * The session's sandbox state when the call was made. A step resumes it, as
   * the session's later turns do, instead of rerunning the sandbox definition
   * on a sandbox the session already set up.
   */
  readonly state?: SandboxState;
}

export type WorkflowStepResult = {
  readonly authorized: readonly string[];
  /** The state of the session's sandbox when the step started it, which the session records. */
  readonly sandboxState?: SandboxState;
} & (
  | { readonly kind: "result"; readonly output: unknown }
  | { readonly kind: "authorization-required"; readonly signal: AuthorizationSignal }
);

/** Compiler-owned envelope; contextIndexes marks arguments replaced with step-local context. */
export interface WorkflowStepInvocation {
  readonly args: readonly unknown[];
  readonly context: WorkflowStepContext;
  readonly contextIndexes: readonly number[];
}
