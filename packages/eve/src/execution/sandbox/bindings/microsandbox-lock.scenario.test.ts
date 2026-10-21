import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { withMicrosandboxLifecycleLock } from "#execution/sandbox/bindings/microsandbox-lock.js";

// The in-memory lifecycle tests isolate framework caches. This test owns the
// independent OS-lock contract: another process must not enter while the lock
// is held, and process death must release the lock.
describe("microsandbox cross-process lifecycle lock", () => {
  it.each(["timer", "unresolved"])(
    "excludes another process and releases the lock when the owner crashes (%s)",
    async (waiting) => {
      const storagePath = await mkdtemp(join(tmpdir(), "eve-microsandbox-lock-"));
      const source = new URL("./microsandbox-lock.ts", import.meta.url).href;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { withMicrosandboxLifecycleLock } from ${JSON.stringify(source)};
      await withMicrosandboxLifecycleLock(${JSON.stringify(storagePath)}, async () => {
        process.stdout.write("held\\n");
        if (${JSON.stringify(waiting)} === "timer") {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
        } else {
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        }
      });
    `,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      let pending: Promise<void> | undefined;
      try {
        const ready = await Promise.race([
          once(child.stdout, "data").then(([data]) => data.toString()),
          exited.then(([code, signal]) => {
            throw new Error(`Lock holder exited: ${code ?? signal}`);
          }),
        ]);
        expect(ready).toBe("held\n");
        let entered!: () => void;
        const acquired = new Promise<void>((resolve) => {
          entered = resolve;
        });
        pending = withMicrosandboxLifecycleLock(storagePath, async () => {
          entered();
        });
        expect(
          await Promise.race([acquired.then(() => "entered"), setTimeout(150, "excluded")]),
        ).toBe("excluded");

        child.kill("SIGKILL");
        await exited;
        await pending;
        await acquired;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        await pending;
        await rm(storagePath, { force: true, recursive: true });
      }
    },
  );
});
