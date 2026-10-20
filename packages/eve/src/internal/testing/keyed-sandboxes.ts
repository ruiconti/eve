import { type Mock, vi } from "vitest";

import { withToolSessionSandboxes } from "#execution/tool-session/sandbox.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";

/**
 * A provider whose `start` reopens a session's sandbox by session id, as
 * Vercel Sandbox and just-bash do, opted into tool sessions unless
 * `reopensBySessionId` is false. Each open hands out its own handle over the
 * shared sandbox, as just-bash runs one interpreter per handle; `released`
 * records which handles a caller let go of, and `stopped` which were stopped
 * through the sandbox API.
 */
export function keyedSandboxes(
  options: { readonly failSelector?: () => boolean; readonly reopensBySessionId?: boolean } = {},
) {
  const live = new Map<string, { sandbox: ReturnType<typeof mockSandbox> }>();
  const starts: string[] = [];
  const handles: object[] = [];
  const released: object[] = [];
  const stopped: Mock<() => Promise<void>> = vi.fn(async () => {});
  const deleted: Mock<(sessionId: string) => void> = vi.fn(
    (sessionId: string) => void live.delete(sessionId),
  );
  const reopen = (sessionId: string) => {
    let entry = live.get(sessionId);
    if (entry === undefined) {
      starts.push(sessionId);
      entry = { sandbox: mockSandbox() };
      live.set(sessionId, entry);
    }
    const handle = {
      sandbox: entry.sandbox.session,
      onRuntimeShutdown: async () => {},
      onSandboxDelete: async () => deleted(sessionId),
      onSandboxStop: stopped,
    };
    handles.push(handle);
    return handle;
  };
  const environment = defineSandboxProvider({
    name: "keyed",
    environment: () => {
      const implementation = {
        prepare: async () => null,
        resume: async (context: { readonly session: { readonly id: string } }) =>
          reopen(context.session.id),
        start: async (context: { readonly session: { readonly id: string } }) => ({
          handle: reopen(context.session.id),
          state: {},
        }),
      };
      return options.reopensBySessionId === false
        ? implementation
        : withToolSessionSandboxes(implementation, {
            releaseHandle: async (handle) => void released.push(handle),
          });
    },
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(async () => {
          const sandbox = await environment.open();
          if (options.failSelector?.() === true) throw new Error("selector failed");
          return sandbox;
        }),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { deleted, handles, live, registry, released, starts, stopped };
}
