import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
 *     `code: "ELOCKED"` (routes map it to 503 `lock_busy`). Callers never
 *     continue with an unlocked write — a timeout is an error, never a drop.
 *   - Never broken by AGE: a paused live writer (debugger, SIGSTOP, laptop
 *     sleep) could still commit afterwards. A lock is recovered only when its
 *     owner is PROVABLY DEAD (see ownerState): the body names the owner's
 *     host, pid and (Linux) process start time; same host + `kill(pid, 0)` →
 *     ESRCH (or a different start time = pid reuse) means dead. A live pid, a
 *     foreign host, or an unreadable / legacy body stays fail-closed.
 *   - Dead-owner recovery is claimed atomically: the stale file is renamed to
 *     a unique tombstone (exactly one breaker's rename can take it), its bytes
 *     are compared with what was judged dead, and only then is the O_EXCL
 *     create retried. A tombstone that turns out to be a fresh lock is linked
 *     back into place.
 *   - Release verifies the body is still ours before unlinking, so an owner
 *     whose lock was removed/replaced while it held it fails LOUDLY instead of
 *     deleting someone else's lock.
 *   - Readers never take the lock. Every protected file is replaced by atomic
 *     rename, so lock-free readers (the preflight/stop hooks) always see a
 *     complete old or new snapshot and stay fail-open and fast.
 *   - `reentrant: true` lets a caller that already holds the lock IN THIS
 *     PROCESS run nested work inline instead of timing out against itself.
 *     Off by default: the session flush lock deliberately treats a nested
 *     in-process acquisition as contention (see durable-review-post tests).
 *
 * Windows: "wx" maps to CREATE_NEW; `process.kill(pid, 0)` works there too
 * (EPERM = alive); the fd is closed before the lock is unlinked.
 */
export interface FileLockOptions {
  /** Human-readable name for the ELOCKED message. */
  label?: string;
  /** Maximum synchronous wait before failing closed. */
  timeoutMs?: number;
  /** Run nested same-process acquisitions of this lock inline. */
  reentrant?: boolean;
}

export interface FileLockOwner {
  pid: number;
  hostname: string;
  /** Linux: /proc/<pid>/stat starttime (clock ticks since boot). Null elsewhere. */
  processStartTime: string | null;
  createdAt: string;
  nonce: string;
}

export type FileLockOwnerState =
  | { state: "alive"; owner: FileLockOwner }
  | { state: "dead"; owner: FileLockOwner; why: string }
  | { state: "unknown"; owner: FileLockOwner | null; why: string };

export const DEFAULT_FILE_LOCK_TIMEOUT_MS = 250;

/** Lock paths currently held by THIS process (reentrant sites only consult it). */
const heldLocks = new Set<string>();

export function isFileLockError(err: unknown): err is NodeJS.ErrnoException & { path?: string } {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ELOCKED";
}

function readStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) may contain spaces/parens; fields after the LAST ')' start at 3.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[22 - 3] ?? null;
  } catch {
    return null;
  }
}

let selfStartTime: string | null | undefined;
function ownBody(): FileLockOwner {
  if (selfStartTime === undefined) selfStartTime = readStartTime(process.pid);
  return {
    pid: process.pid,
    hostname: os.hostname(),
    processStartTime: selfStartTime,
    createdAt: new Date().toISOString(),
    nonce: randomBytes(8).toString("hex"),
  };
}

function parseOwner(raw: string): FileLockOwner | null {
  try {
    const v = JSON.parse(raw) as Partial<FileLockOwner>;
    if (!v || typeof v !== "object") return null;
    if (!Number.isInteger(v.pid) || (v.pid as number) <= 0) return null;
    if (typeof v.hostname !== "string" || !v.hostname) return null;
    return {
      pid: v.pid as number,
      hostname: v.hostname,
      processStartTime: typeof v.processStartTime === "string" ? v.processStartTime : null,
      createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
      nonce: typeof v.nonce === "string" ? v.nonce : "",
    };
  } catch {
    return null;
  }
}

/** Classify a lock body. Only "dead" may ever be broken. */
export function ownerState(raw: string): FileLockOwnerState {
  const owner = parseOwner(raw);
  if (!owner) return { state: "unknown", owner: null, why: "unreadable or legacy lock body (no pid/hostname)" };
  if (owner.hostname !== os.hostname()) {
    return { state: "unknown", owner, why: `owned by another host (${owner.hostname})` };
  }
  if (owner.pid === process.pid) {
    // Our own pid: either a nested non-reentrant acquisition (contention by
    // contract) or a lock this very process leaked. Never self-break.
    return { state: "alive", owner };
  }
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "dead", owner, why: `pid ${owner.pid} is not running` };
    if (code === "EPERM") return { state: "alive", owner }; // exists, not ours to signal
    return { state: "unknown", owner, why: `liveness probe failed (${code ?? String(err)})` };
  }
  // The pid exists. On Linux a different start time proves pid reuse.
  if (owner.processStartTime) {
    const current = readStartTime(owner.pid);
    if (current && current !== owner.processStartTime) {
      return { state: "dead", owner, why: `pid ${owner.pid} was reused by a newer process` };
    }
  }
  return { state: "alive", owner };
}

/**
 * Atomically remove a lock whose owner is provably dead. Returns true when
 * THIS caller removed it. Safe against concurrent breakers: exactly one rename
 * can take the file, and the tombstone's bytes must equal what was judged
 * dead — otherwise it was a fresh lock and is linked back into place.
 */
export function breakDeadLock(lockPath: string): { broken: boolean; state: FileLockOwnerState | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { broken: false, state: null };
    throw err;
  }
  const state = ownerState(raw);
  if (state.state !== "dead") return { broken: false, state };
  const tomb = `${lockPath}.dead-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockPath, tomb);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { broken: false, state }; // another breaker won
    throw err;
  }
  let taken: string;
  try {
    taken = fs.readFileSync(tomb, "utf8");
  } catch {
    taken = "";
  }
  if (taken !== raw) {
    // Lost a race: between our read and rename, another breaker removed the
    // dead lock and a live writer created a fresh one, which we just moved.
    // Put it back (link is atomic and never overwrites a newer lock).
    try {
      fs.linkSync(tomb, lockPath);
      fs.unlinkSync(tomb);
    } catch (err) {
      console.error(`[deepPairing] lock ${lockPath}: could not restore a live lock moved during dead-owner recovery (${String(err)}); its owner will fail loudly on release.`);
    }
    return { broken: false, state };
  }
  fs.unlinkSync(tomb);
  console.error(`[deepPairing] recovered lock ${lockPath}: ${state.why} (created ${state.owner.createdAt || "?"}).`);
  return { broken: true, state };
}

export function withFileLock<T>(lockPath: string, run: () => T, opts: FileLockOptions = {}): T {
  const key = path.resolve(lockPath);
  if (opts.reentrant && heldLocks.has(key)) return run();
  const label = opts.label ?? "File lock";
  const deadline = performance.now() + (opts.timeoutMs ?? DEFAULT_FILE_LOCK_TIMEOUT_MS);
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  let fd: number;
  let lastState: FileLockOwnerState | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const attempt = breakDeadLock(lockPath);
      if (attempt.broken) continue;
      lastState = attempt.state ?? lastState;
      if (performance.now() >= deadline) {
        const owner = lastState?.owner;
        const who = owner ? ` Held by pid ${owner.pid} on ${owner.hostname} since ${owner.createdAt || "?"}.` : "";
        throw Object.assign(
          new Error(
            `${label} busy: ${lockPath}.${who} If no deepPairing daemon or CLI is running, ` +
            "run `deeppairing doctor` to inspect it; remove an abandoned lock only after stopping all writers.",
          ),
          { code: "ELOCKED", path: lockPath },
        );
      }
      Atomics.wait(waitArray, 0, 0, 10);
    }
  }
  heldLocks.add(key);
  const body = JSON.stringify(ownBody());
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    fs.writeFileSync(fd, body);
    result = run();
  } catch (err) {
    failed = true;
    failure = err;
  }
  heldLocks.delete(key);
  // Always attempt cleanup, but preserve the original failure. A cleanup-only
  // failure still propagates (an orphan or stolen lock needs attention).
  const cleanups = [
    () => fs.closeSync(fd),
    () => {
      if (fs.readFileSync(lockPath, "utf8") !== body) {
        throw Object.assign(new Error(`${label} was replaced while held: ${lockPath}. Stop all writers and inspect the protected file.`), { code: "ELOCKSTOLEN" });
      }
      fs.unlinkSync(lockPath);
    },
  ];
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (err) {
      if (!failed) { failed = true; failure = err; }
    }
  }
  if (failed) throw failure;
  return result;
}

/** The 503 body every route returns for ELOCKED (#406/#408 review). */
export function lockBusyBody(err: NodeJS.ErrnoException & { path?: string }): { error: "lock_busy"; code: "lock_busy"; message: string; lockPath?: string } {
  return {
    error: "lock_busy",
    code: "lock_busy",
    message: `${err.message} This write did not complete; retry in a moment.`,
    ...(err.path ? { lockPath: err.path } : {}),
  };
}

export interface LockReport {
  path: string;
  ageMs: number | null;
  state: FileLockOwnerState["state"];
  owner: FileLockOwner | null;
  why?: string;
}

/** List every `*.lock` file under the given roots (recursively, bounded depth)
 *  with owner and liveness. For `deeppairing doctor`. */
export function inspectLocks(roots: string[], maxDepth = 4): LockReport[] {
  const reports: LockReport[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".lock")) {
        let raw = "";
        let ageMs: number | null = null;
        try {
          raw = fs.readFileSync(full, "utf8");
          ageMs = Date.now() - fs.statSync(full).mtimeMs;
        } catch { /* vanished or unreadable */ }
        const s = ownerState(raw);
        reports.push({ path: full, ageMs, state: s.state, owner: s.owner, ...(s.state === "alive" ? {} : { why: s.why }) });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return reports;
}
