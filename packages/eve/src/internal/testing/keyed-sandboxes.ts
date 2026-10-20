import { type Mock, vi } from "vitest";

import { withSessionSandboxReopen } from "#execution/sandbox/session-reopen.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineParentSandbox, defineSandbox } from "#public/definitions/sandbox.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

/**
 * A provider whose `start` reopens a session's sandbox by session id, as
 * Vercel Sandbox and just-bash do, opted in unless `reopensBySessionId` is
 * false. Like a Vercel sandbox name, the sandbox key also covers the options
 * the definition opens it with (`openOptions`). With `inherited`, the
 * registry is a child's that shares its owner's sandbox definition. Each open
 * hands out its own handle over the shared sandbox, as just-bash runs one
 * interpreter per handle; `released` records which handles a caller let go
 * of, `stopped` which were stopped through the sandbox API, and `shutDown`
 * which the runtime's shutdown stopped.
 */
export function keyedSandboxes(
  options: {
    readonly failSelector?: () => boolean;
    readonly inherited?: boolean;
    readonly openOptions?: Record<string, string>;
    readonly reopensBySessionId?: boolean;
  } = {},
) {
  const live = new Map<string, { sandbox: ReturnType<typeof mockSandbox> }>();
  const starts: string[] = [];
  const handles: object[] = [];
  const released: object[] = [];
  const shutDown: object[] = [];
  const stopped: Mock<() => Promise<void>> = vi.fn(async () => {});
  const deleted: Mock<(key: string) => void> = vi.fn((key: string) => void live.delete(key));
  const reopen = (key: string) => {
    let entry = live.get(key);
    if (entry === undefined) {
      starts.push(key);
      entry = { sandbox: mockSandbox() };
      live.set(key, entry);
    }
    const handle = {
      sandbox: entry.sandbox.session,
      onRuntimeShutdown: async () => void shutDown.push(handle),
      onSandboxDelete: async () => deleted(key),
      onSandboxStop: stopped,
    };
    handles.push(handle);
    return handle;
  };
  const provider = defineSandboxProvider({
    name: "keyed",
    environment: () => {
      const implementation = {
        prepare: async () => null,
        resume: async (_context: unknown, _artifact: unknown, state: { readonly key: string }) =>
          reopen(state.key),
        start: async (context: { readonly session: { readonly id: string } }, open?: object) => {
          const key =
            open === undefined
              ? context.session.id
              : `${context.session.id}:${JSON.stringify(open)}`;
          return { handle: reopen(key), state: { key } };
        },
      };
      return options.reopensBySessionId === false
        ? implementation
        : withSessionSandboxReopen(implementation, {
            releaseHandle: async (handle) => void released.push(handle),
          });
    },
  });
  const environment = provider.environment();
  const definition: ResolvedSandboxDefinition = {
    environment,
    kind: "independent",
    logicalPath: "sandbox.ts",
    revisionHash: "hash",
    selector: defineSandbox(async () => {
      const sandbox = await (
        environment.open as (open?: object) => ReturnType<typeof environment.open>
      )(options.openOptions);
      if (options.failSelector?.() === true) throw new Error("selector failed");
      return sandbox;
    }),
    sourceId: "sandbox",
    sourceKind: "module",
  };
  const workspaceResourceRoot = { logicalPath: "", rootEntries: [] };
  const registry: RuntimeSandboxRegistry = {
    sandbox:
      options.inherited === true
        ? {
            definition: {
              kind: "parent",
              logicalPath: "subagents/child/sandbox.ts",
              revisionHash: "child-hash",
              selector: defineParentSandbox(),
              sourceId: "child-sandbox",
              sourceKind: "module",
            },
            inheritance: { definition, nodeId: "__root__", workspaceResourceRoot },
            workspaceResourceRoot,
          }
        : { definition, workspaceResourceRoot },
  };
  return {
    deleted,
    environment,
    handles,
    live,
    provider,
    registry,
    released,
    shutDown,
    starts,
    stopped,
  };
}
