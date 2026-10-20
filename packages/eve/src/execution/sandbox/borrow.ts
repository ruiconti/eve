import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import {
  providerWithoutSessionReopen,
  releaseSessionSandboxHandle,
} from "#execution/sandbox/session-reopen.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxAccess, SandboxState } from "#sandbox/state.js";

/** A session's sandbox, opened by a caller that does not own it. */
export interface BorrowedSandbox {
  readonly access: SandboxAccess;
  /** Lets go of this caller's handle. The sandbox itself stays for the session. */
  release(): Promise<void>;
}

/**
 * Opens a session's sandbox for a caller outside its turns, on the first
 * `get()`: resumed from `state` when the session recorded one, or else found
 * or created through the provider's `start`, which then must reopen it by
 * session id, so it is the sandbox the session's own `start` finds. The
 * caller never owns the sandbox: a failed start never deletes it, `delete()`
 * throws, and `release` only lets go of this caller's handle, so an
 * overlapping caller keeps its own.
 */
export async function borrowSessionSandbox(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
  readonly state?: SandboxState;
  /** `false` when the session's own handle for the sandbox is tracked in this process. */
  readonly tracksHandle?: boolean;
  /**
   * The error for a provider whose `start` cannot reopen a session's sandbox,
   * for a caller that may start it. Omit it when `state` is always recorded.
   */
  readonly unsupported?: (providerName: string) => Error;
}): Promise<BorrowedSandbox> {
  const { registry } = input;
  const inner = await ensureSandboxAccess({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
    ownsSandbox: false,
    registry,
    sessionId: input.sessionId,
    state: input.state ?? null,
    tracksHandle: input.tracksHandle,
  });
  return {
    access: {
      ...inner,
      async get() {
        if (input.unsupported !== undefined) {
          const providerName = providerWithoutSessionReopen(registry);
          if (providerName !== undefined) throw input.unsupported(providerName);
        }
        return await inner.get();
      },
    },
    async release() {
      const handle = await inner.detach();
      if (handle !== undefined) await releaseSessionSandboxHandle(registry, handle);
    },
  };
}
