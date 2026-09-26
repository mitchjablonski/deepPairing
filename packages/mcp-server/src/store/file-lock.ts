import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

/**
 * The one cross-process "locked read-modify-write" boundary for FileStore-side
 * writers. An `O_CREAT|O_EXCL` ("wx") lockfile, held for the complete
 * read → mutate → atomic-replace section. Atomic rename alone prevents torn
 * JSON, NOT lost updates: two processes that read the same snapshot and
 * rename in turn silently drop the first writer's change (#406, #408).
 *
 * Used by:
 *   - the per-session `.flush.lock` (withSessionFlushLock, session-records.ts)
 *   - the project `preferences.json.lock` (FileStore.mutatePreferences)
 *   - the cross-project philosophy ledger `v1.json.lock` (GlobalStore)
 *
 * Contract (shared by every site):
 *   - Bounded wait: synchronous poll every 10 ms up to `timeoutMs`, then throw
 *     `code: "ELOCKED"`. Callers must never continue with an unlocked write —
 *     a timeout surfaces as an error, never a silent drop.
 *   - Never break a lock by age: a paused live writer (debugger, SIGSTOP,
 *     laptop sleep) could still commit after we "recover" its lock, which is
 *     the exact lost update the lock exists to prevent. A lock orphaned by a
 *     crash is fail-closed until an operator removes it after stopping the
 *     writers; the lock body names the owning pid and creation time.
 *   - Readers never take the lock. Every protected file is replaced by atomic
 *     rename, so a lock-free reader (the preflight/stop hooks) always sees a
 *     complete old or new snapshot and stays fail-open and fast.
 *   - `reentrant: true` lets a caller that already holds the lock IN THIS
 *     PROCESS run nested work inline instead of timing out against itself.
 *     Off by default: the session flush lock deliberately treats a nested
 *     in-process acquisition as contention (see durable-review-post tests).
 *
 * Windows: "wx" maps to CREATE_NEW, and the lock is unlinked only after its fd
 * is closed, so the same sequence is safe on NTFS.
 */
export interface FileLockOptions {
  /** Human-readable name for the ELOCKED message. */
  label?: string;
  /** Maximum synchronous wait before failing closed. */
  timeoutMs?: number;
  /** Run nested same-process acquisitions of this lock inline. */
  reentrant?: boolean;
}

export const DEFAULT_FILE_LOCK_TIMEOUT_MS = 250;

/** Lock paths currently held by THIS process (reentrant sites only consult it). */
const heldLocks = new Set<string>();

export function isFileLockError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ELOCKED";
}

export function withFileLock<T>(lockPath: string, run: () => T, opts: FileLockOptions = {}): T {
  const key = path.resolve(lockPath);
  if (opts.reentrant && heldLocks.has(key)) return run();
  const label = opts.label ?? "File lock";
  const deadline = performance.now() + (opts.timeoutMs ?? DEFAULT_FILE_LOCK_TIMEOUT_MS);
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (performance.now() >= deadline) {
        throw Object.assign(
          new Error(`${label} busy: ${lockPath}. Stop all writers before removing an abandoned lock.`),
          { code: "ELOCKED", path: lockPath },
        );
      }
      Atomics.wait(waitArray, 0, 0, 10);
    }
  }
  heldLocks.add(key);
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    result = run();
  } catch (err) {
    failed = true;
    failure = err;
  }
  heldLocks.delete(key);
  // Always attempt both cleanup operations, but preserve the original failure.
  // A cleanup-only failure still propagates (an orphan lock needs attention).
  for (const cleanup of [() => fs.closeSync(fd), () => fs.unlinkSync(lockPath)]) {
    try { cleanup(); } catch (err) {
      if (!failed) { failed = true; failure = err; }
    }
  }
  if (failed) throw failure;
  return result;
}
