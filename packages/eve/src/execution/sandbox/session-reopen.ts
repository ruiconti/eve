import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { SandboxProviderHandle, SandboxProviderRuntime } from "#shared/sandbox-provider.js";

/*
 * Keyed tool sessions and workflow steps open a session's sandbox outside its
 * turns through the provider's own `start`, which must find that sandbox again
 * from the session id alone. Only eve's bindings that do so opt in, and the
 * marker stays internal so the public provider API is unchanged.
 */

/** What a binding whose `start` reopens a session's sandbox tells the callers that use it. */
export interface SessionSandboxReopenSupport {
  /**
   * Frees what a caller's handle holds in this process once the caller is
   * done, leaving the session's sandbox for later and overlapping callers.
   * Absent when a handle holds nothing of its own, such as a client to a
   * remote sandbox.
   */
  releaseHandle?(handle: SandboxProviderHandle): Promise<void>;
}

// `Symbol.for`, not a module-local WeakMap: a workflow step can run from a
// different bundled copy of this module than the one that marked the binding.
const SUPPORT = Symbol.for("eve.sandbox.session-reopen");

type MarkedImplementation = { readonly [SUPPORT]?: SessionSandboxReopenSupport };

/** Marks a binding whose `start` reopens a session's sandbox by session id. */
export function withSessionSandboxReopen<Implementation extends object>(
  implementation: Implementation,
  support: SessionSandboxReopenSupport = {},
): Implementation {
  Object.defineProperty(implementation, SUPPORT, {
    configurable: true,
    enumerable: false,
    value: support,
  });
  return implementation;
}

/** The registry's sandbox provider name when its `start` cannot reopen a session's sandbox. */
export function providerWithoutSessionReopen(registry: RuntimeSandboxRegistry): string | undefined {
  const provider = registeredProvider(registry);
  return provider !== undefined && supportOf(provider) === undefined
    ? provider.providerName
    : undefined;
}

/** Frees what a caller's handle holds in this process; the sandbox itself stays. */
export async function releaseSessionSandboxHandle(
  registry: RuntimeSandboxRegistry,
  handle: SandboxProviderHandle,
): Promise<void> {
  const provider = registeredProvider(registry);
  if (provider === undefined) return;
  await supportOf(provider)?.releaseHandle?.(handle);
}

function supportOf(provider: SandboxProviderRuntime): SessionSandboxReopenSupport | undefined {
  return (provider.implementation as MarkedImplementation)[SUPPORT];
}

function registeredProvider(registry: RuntimeSandboxRegistry): SandboxProviderRuntime | undefined {
  const registered = registry.sandbox;
  const definition = registered?.inheritance?.definition ?? registered?.definition;
  if (definition?.kind !== "independent") return undefined;
  return getSandboxEnvironmentRuntime(definition.environment);
}
