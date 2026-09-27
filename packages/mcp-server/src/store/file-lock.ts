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
 *     owner is PROVABLY DEAD. The body carries the owner's full process
 *     identity — platform, hostname, boot id, pid namespace, pid and (Linux)
 *     process start time. Only an EXACT identity match (same machine boot,
 *     same pid namespace) plus `kill(pid, 0)` → ESRCH, or a different start
 *     time for that pid (reuse), is proof of death. Anything else — a live
 *     pid, any missing or mismatched identity field (WSL2 vs Windows share a
 *     hostname but not a pid space; containers share a boot but not a pid
 *     namespace), an unreadable or legacy body — is fail-closed.
 *   - Breakers are SERIALIZED through `<lock>.break` (O_EXCL). Under it the
 *     breaker re-reads the lock and unlinks it only if its bytes still equal
 *     exactly what was judged dead. Only breakers ever remove someone else's
 *     lock, so while `.break` is held the judged-dead file cannot be swapped
 *     for a fresh one between the re-read and the unlink.
 *   - A `.break` left by a crashed breaker is itself recovered by the same
 *     identity rule, serialized through `<lock>.break.recover` (O_EXCL). That
 *     last level is never broken by writers: it needs a SECOND crash inside a
 *     microsecond window to strand, and `deeppairing doctor --fix` removes it
 *     (dead owner only) — doctor is its only remover.
 *   - Release verifies the body is still ours before unlinking. If it is not
 *     (an operator removed it, or an identity was misjudged), the protected
 *     write has ALREADY been applied atomically — reporting "not saved" would
 *     be false, and there is nothing to roll back — so it is a loud logged
 *     warning, never an error to the user, and never deletes another lock.
 *   - Readers never take the lock. Every protected file is replaced by atomic
 *     rename, so lock-free readers (the preflight/stop hooks) always see a
 *     complete old or new snapshot and stay fail-open and fast.
 *   - `reentrant: true` lets a caller that already holds the lock IN THIS
 *     PROCESS run nested work inline instead of timing out against itself.
 *     Off by default: the session flush lock deliberately treats a nested
 *     in-process acquisition as contention (see durable-review-post tests).
 *
 * Windows: "wx" maps to CREATE_NEW; `process.kill(pid, 0)` works there too
 * (EPERM = alive).
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
  platform: string;
  hostname: string;
  /** Linux: /proc/sys/kernel/random/boot_id. Elsewhere: boot time from os.uptime(), minute-rounded. */
  bootId: string;
  /** Linux: the /proc/self/ns/pid link ("pid:[inode]"). Elsewhere: "host". */
  pidNamespace: string;
  /** Linux: /proc/<pid>/stat starttime (clock ticks since boot). Null elsewhere. */
  processStartTime: string | null;
  createdAt: string;
  nonce: string;
}

export type FileLockOwnerState =
  | { state: "alive"; owner: FileLockOwner }
  | { state: "dead"; owner: FileLockOwner; why: string }
  | { state: "unknown"; owner: Partial<FileLockOwner> | null; why: string };

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

interface HostIdentity { platform: string; hostname: string; bootId: string; pidNamespace: string }

function currentHostIdentity(): HostIdentity | null {
  try {
    if (process.platform === "linux") {
      return {
        platform: "linux",
        hostname: os.hostname(),
        bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
      };
    }
    return {
      platform: process.platform,
      hostname: os.hostname(),
      bootId: `uptime-boot:${Math.round((Date.now() / 1000 - os.uptime()) / 60)}`,
      pidNamespace: "host",
    };
  } catch {
    return null; // identity unknowable here: never break anyone's lock
  }
}

let selfIdentity: { host: HostIdentity | null; startTime: string | null } | undefined;
function self(): { host: HostIdentity | null; startTime: string | null } {
  if (!selfIdentity) selfIdentity = { host: currentHostIdentity(), startTime: readStartTime(process.pid) };
  return selfIdentity;
}

/** Test seam: the identity this process stamps into lock bodies. */
export function ownLockIdentity(): Omit<FileLockOwner, "createdAt" | "nonce"> | null {
  const me = self();
  if (!me.host) return null;
  return { pid: process.pid, ...me.host, processStartTime: me.startTime };
}

function ownBody(): string {
  const id = ownLockIdentity();
  return JSON.stringify({
    ...(id ?? { pid: process.pid }),
    createdAt: new Date().toISOString(),
    nonce: randomBytes(8).toString("hex"),
  });
}

const IDENTITY_FIELDS = ["platform", "hostname", "bootId", "pidNamespace"] as const;

/** Classify a lock body. Only "dead" may ever be broken. */
export function ownerState(raw: string): FileLockOwnerState {
  let v: Partial<FileLockOwner>;
  try {
    v = JSON.parse(raw) as Partial<FileLockOwner>;
  } catch {
    return { state: "unknown", owner: null, why: "unreadable lock body" };
  }
  if (!v || typeof v !== "object" || !Number.isInteger(v.pid) || (v.pid as number) <= 0) {
    return { state: "unknown", owner: null, why: "unreadable lock body (no pid)" };
  }
  const here = self().host;
  if (!here) return { state: "unknown", owner: v, why: "this process cannot determine its own host identity" };
  for (const field of IDENTITY_FIELDS) {
    if (typeof v[field] !== "string" || !v[field]) {
      return { state: "unknown", owner: v, why: `legacy lock body (no ${field}) — owner unverifiable` };
    }
    if (v[field] !== here[field]) {
      return { state: "unknown", owner: v, why: `owned by another ${field === "hostname" ? "host" : field === "platform" ? "OS" : field === "bootId" ? "boot / kernel (e.g. WSL vs Windows, or a VM)" : "pid namespace (e.g. a container)"} — owner unverifiable` };
    }
  }
  const owner = v as FileLockOwner;
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "dead", owner, why: `pid ${owner.pid} is not running` };
    if (code === "EPERM") return { state: "alive", owner }; // exists, not ours to signal
    return { state: "unknown", owner, why: `liveness probe failed (${code ?? String(err)})` };
  }
  // The pid exists (possibly our own pid). On Linux a different start time
  // proves reuse — including a restarted container that got the same pid.
  if (typeof owner.processStartTime === "string" && owner.processStartTime) {
    const current = readStartTime(owner.pid);
    if (current && current !== owner.processStartTime) {
      return { state: "dead", owner, why: `pid ${owner.pid} was reused by a newer process` };
    }
  }
  return { state: "alive", owner };
}

/** Create `file` exclusively with this process's identity. Null if it exists. */
function claim(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
  const body = ownBody();
  try {
    fs.writeFileSync(fd, body);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch { /* the create itself is the claim */ }
    throw err;
  }
  fs.closeSync(fd);
  return body;
}

/** Release a claim: unlink only if it is still ours. Returns false (and warns)
 *  when ownership was lost; throws only when OUR lock could not be removed. */
function release(file: string, body: string, label: string): boolean {
  let current: string | null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    current = null;
  }
  if (current !== body) {
    console.error(
      `[deepPairing] WARNING: ${label} at ${file} was ${current === null ? "removed" : "replaced"} while this process held it. ` +
      "The write under it completed; another writer may have overlapped it. Stop all writers and check the protected file if this repeats.",
    );
    return false;
  }
  fs.unlinkSync(file);
  return true;
}

/** Remove `file` only if its bytes still equal `judged`, serialized through
 *  the O_EXCL `guard`. Returns true when THIS caller removed it. */
function unlinkIfUnchanged(file: string, judged: string, guard: string): boolean {
  const mine = claim(guard);
  if (mine === null) return false;
  try {
    let now: string;
    try {
      now = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (now !== judged) return false;
    fs.unlinkSync(file);
    return true;
  } finally {
    release(guard, mine, "lock-break guard");
  }
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove a lock whose owner is provably dead. Returns true when THIS caller
 * removed it. Breakers are serialized through `<lock>.break`; a `.break`
 * stranded by a crashed breaker is recovered (same rule) through
 * `<lock>.break.recover`, which is never auto-broken.
 */
export function breakDeadLock(lockPath: string): { broken: boolean; state: FileLockOwnerState | null } {
  const raw = readIfExists(lockPath);
  if (raw === null) return { broken: false, state: null };
  const state = ownerState(raw);
  if (state.state !== "dead") return { broken: false, state };
  const guard = `${lockPath}.break`;
  if (unlinkIfUnchanged(lockPath, raw, guard)) {
    console.error(`[deepPairing] recovered lock ${lockPath}: ${state.why} (created ${state.owner.createdAt || "?"}).`);
    return { broken: true, state };
  }
  // The guard may be held by a live breaker (retry shortly) or stranded by a
  // dead one: recover it by the same rule, one level up.
  const guardRaw = readIfExists(guard);
  if (guardRaw !== null && ownerState(guardRaw).state === "dead") {
    unlinkIfUnchanged(guard, guardRaw, `${guard}.recover`);
  }
  return { broken: false, state };
}

/**
 * `deeppairing doctor --fix` — remove ONE dead-owner lock file of any kind,
 * under the same ownerState rule (live and unknown owners are refused):
 *   - `<x>.lock`               → breakDeadLock (writers' own path)
 *   - `<x>.lock.break`         → serialized through `.break.recover`, exactly
 *                                as a writer recovers it
 *   - `<x>.lock.break.recover` → re-read and unlinked if unchanged. Writers
 *                                never remove `.recover`; doctor is its only
 *                                remover, so this cannot race a writer.
 * Callers should clear `.recover` before `.break` before the lock.
 */
export function clearDeadLockFile(file: string): { removed: boolean; reason: string } {
  const raw = readIfExists(file);
  if (raw === null) return { removed: false, reason: "already gone" };
  const state = ownerState(raw);
  if (state.state !== "dead") return { removed: false, reason: `owner is ${state.state}` };
  if (file.endsWith(".lock.break.recover")) {
    if (readIfExists(file) !== raw) return { removed: false, reason: "changed while inspecting" };
    fs.unlinkSync(file);
    return { removed: true, reason: state.why };
  }
  if (file.endsWith(".lock.break")) {
    return unlinkIfUnchanged(file, raw, `${file}.recover`)
      ? { removed: true, reason: state.why }
      : { removed: false, reason: "busy or changed; re-run doctor" };
  }
  const r = breakDeadLock(file);
  return r.broken ? { removed: true, reason: state.why } : { removed: false, reason: "busy or changed; re-run doctor" };
}

export function withFileLock<T>(lockPath: string, run: () => T, opts: FileLockOptions = {}): T {
  const key = path.resolve(lockPath);
  if (opts.reentrant && heldLocks.has(key)) return run();
  const label = opts.label ?? "File lock";
  const deadline = performance.now() + (opts.timeoutMs ?? DEFAULT_FILE_LOCK_TIMEOUT_MS);
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  let body: string | null;
  let lastState: FileLockOwnerState | null = null;
  for (;;) {
    body = claim(lockPath);
    if (body !== null) break;
    const attempt = breakDeadLock(lockPath);
    if (attempt.broken) continue;
    lastState = attempt.state ?? lastState;
    if (performance.now() >= deadline) {
      const owner = lastState?.owner;
      const who = owner?.pid ? ` Held by pid ${owner.pid}${owner.hostname ? ` on ${owner.hostname}` : ""} since ${owner.createdAt || "?"}.` : "";
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
  heldLocks.add(key);
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    result = run();
  } catch (err) {
    failed = true;
    failure = err;
  }
  heldLocks.delete(key);
  // Always attempt cleanup, but preserve the original failure. Lost ownership
  // is a logged warning (the write already landed); failing to remove OUR OWN
  // lock still propagates (it would strand every other writer).
  try {
    release(lockPath, body, label);
  } catch (err) {
    if (!failed) { failed = true; failure = err; }
  }
  if (failed) throw failure;
  return result;
}

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
  owner: Partial<FileLockOwner> | null;
  why?: string;
  /** "lock" = a writer lock (doctor --fix may break it when dead); "break" /
   *  "recover" = the breaker guards (reported; recovered by writers or by hand). */
  kind: "lock" | "break" | "recover";
}

/** List every `*.lock` (and breaker-guard) file under the given roots (recursively, bounded depth)
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
      } else if (entry.isFile() && /\.lock(\.break(\.recover)?)?$/.test(entry.name)) {
        const kind = entry.name.endsWith(".recover") ? "recover" : entry.name.endsWith(".break") ? "break" : "lock";
        let raw = "";
        let ageMs: number | null = null;
        try {
          raw = fs.readFileSync(full, "utf8");
          ageMs = Date.now() - fs.statSync(full).mtimeMs;
        } catch { /* vanished or unreadable */ }
        const s = ownerState(raw);
        reports.push({ path: full, kind, ageMs, state: s.state, owner: s.owner, ...(s.state === "alive" ? {} : { why: s.why }) });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return reports;
}
