import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { SandboxProviderHandle, SandboxProviderRuntime } from "#shared/sandbox-provider.js";

/*
 * Keyed tool sessions and workflow steps reuse a provider's own `start`, which
 * must find the session's sandbox again from the session id alone. Only eve's
 * bindings that do so opt in, and the marker stays internal so the public
 * provider API is unchanged.
 */

/** What a binding that keeps tool-session sandboxes tells the calls that use them. */
export interface ToolSessionSandboxSupport {
  /**
   * Frees what a call's handle holds in this process once the call ends,
   * leaving the session's sandbox for later and overlapping calls. Absent
   * when a handle holds nothing of its own, such as a client to a remote
   * sandbox.
   */
  releaseHandle?(handle: SandboxProviderHandle): Promise<void>;
}

// `Symbol.for`, not a module-local WeakMap: a workflow step can run from a
// different bundled copy of this module than the one that marked the binding.
const SUPPORT = Symbol.for("eve.sandbox.tool-session-support");

type MarkedImplementation = { readonly [SUPPORT]?: ToolSessionSandboxSupport };

/** Marks a binding whose `start` reopens a session's sandbox by session id. */
export function withToolSessionSandboxes<Implementation extends object>(
  implementation: Implementation,
  support: ToolSessionSandboxSupport = {},
): Implementation {
  Object.defineProperty(implementation, SUPPORT, {
    configurable: true,
    enumerable: false,
    value: support,
  });
  return implementation;
}

function supportOf(provider: SandboxProviderRuntime): ToolSessionSandboxSupport | undefined {
  return (provider.implementation as MarkedImplementation)[SUPPORT];
}

/** Raised when a keyed tool session opens a sandbox on a provider that cannot keep it. */
export class ToolSessionSandboxUnsupportedError extends Error {
  constructor(providerName: string) {
    super(
      `Sandbox provider "${providerName}" cannot keep a sandbox between invokeTool calls, ` +
        "so a call with a key cannot open one. Call without a key for a sandbox that lasts " +
        "one call, or use Vercel Sandbox or just-bash.",
    );
    this.name = "ToolSessionSandboxUnsupportedError";
  }
}

/** The registry's sandbox provider name when its `start` cannot reopen a session's sandbox. */
export function unsupportedToolSessionProvider(
  registry: RuntimeSandboxRegistry,
): string | undefined {
  const provider = registeredProvider(registry);
  return provider !== undefined && supportOf(provider) === undefined
    ? provider.providerName
    : undefined;
}

/** Frees what a keyed call's handle holds in this process; the sandbox itself stays. */
export async function releaseToolSessionHandle(
  registry: RuntimeSandboxRegistry,
  handle: SandboxProviderHandle,
): Promise<void> {
  const provider = registeredProvider(registry);
  if (provider === undefined) return;
  await supportOf(provider)?.releaseHandle?.(handle);
}

function registeredProvider(registry: RuntimeSandboxRegistry): SandboxProviderRuntime | undefined {
  const registered = registry.sandbox;
  const definition = registered?.inheritance?.definition ?? registered?.definition;
  if (definition?.kind !== "independent") return undefined;
  return getSandboxEnvironmentRuntime(definition.environment);
}
