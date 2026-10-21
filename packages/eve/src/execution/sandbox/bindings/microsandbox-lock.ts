import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

// A pending promise without an event source does not keep its async frame alive
// for GC. Keep the native connection alive until the operation settles.
const activeLocks = new Set<import("node:sqlite").DatabaseSync>();

/** Serialize native lifecycle transitions across processes, including cleanup. */
export async function withMicrosandboxLifecycleLock<T>(
  storagePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  // SQLite's OS lock is released on process death. Heartbeat/stale-file locks
  // can admit two owners when a live process pauses, which would destroy a VM.
  // Keep the database outside session directories and never unlink it: waiters
  // must always lock the same inode, even while cleanup removes a session.
  const directory = join(storagePath, "microsandbox");
  await mkdir(directory, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, "lifecycle.sqlite"));
  activeLocks.add(database);
  const deadline = Date.now() + 10 * 60_000;
  try {
    for (;;) {
      try {
        database.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        if (!(error instanceof Error && "errcode" in error && error.errcode === 5)) throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            "Timed out waiting for another process to finish a microsandbox lifecycle operation.",
            { cause: error },
          );
        }
        await setTimeout(100);
      }
    }
    return await operation();
  } finally {
    // Closing rolls back the empty transaction and releases the OS lock.
    database.close();
    activeLocks.delete(database);
  }
}
