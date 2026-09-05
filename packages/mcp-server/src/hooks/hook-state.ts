/**
 * #342 — THE hooks-state implementation. One copy, four consumers.
 *
 * Every deepPairing hook — the init-generated `.deeppairing/hooks/{stop,
 * checkpoint}.mjs`, the plugin-bundled `server/stop.mjs`, and the preflight
 * core — appends a fire record to `.deeppairing/hooks-state.json`, which the
 * companion UI's HookStatus reads. Before #342 that read-modify-write existed
 * four times: twice as real TypeScript (preflight-hook-core.ts,
 * stop-hook-entry.ts) and twice as untyped JS text inside setup-tasks.ts's
 * template literals. #332 had to repair the lock in all four; #333 shipped a
 * `ReferenceError` because the emitted text referenced an identifier that only
 * existed in the generator's module scope.
 *
 * Now the emitted scripts are esbuild output of THIS module, so a fix lands
 * once and an undefined identifier is a build error rather than a runtime
 * crash inside an error handler.
 *
 * Constraints this module lives under:
 *   - Node builtins only. It is bundled into standalone `.mjs` files that run
 *     under plain `node` in a user project with no deepPairing install
 *     resolvable and no project-local node_modules.
 *   - Nothing here may throw out of a hook. Every entry point swallows.
 *   - Fail open, always. A hook may never fail the tool call it is gating.
 */
import fs from "node:fs";
import path from "node:path";

/** Cap on the retained fire log — the UI shows a recent tail, not history. */
export const FIRE_LOG_CAP = 50;

/**
 * M1 (#332, round-12 adversarial review) — the atomic write was necessary and
 * NOT sufficient.
 *
 * tmp+rename guarantees no reader ever sees a torn file. It does NOT serialize
 * read-modify-write: two hooks that both read state N and both rename their
 * N+1 leave one of the two updates gone. Measured with 8 parallel invocations:
 * 8 asks were emitted, but only 4 fire records and — the part that matters — 4
 * DEDUP STAMPS survived. A dropped stamp means the same file asks again inside
 * its 30-minute window, which is the spurious-ask failure H1 is about.
 *
 * So the whole RMW runs under an O_EXCL lockfile. Hooks are sub-100 ms
 * processes, so a short spin is the right shape (no async, no dependency).
 */
const LOCK_STALE_MS = 5_000;
const LOCK_SPIN_MS = 2;
const LOCK_MAX_WAIT_MS = 500;

/**
 * Read a `.code` off a caught value STRUCTURALLY. `instanceof Error` is the
 * wrong test here: a preload-faked fs boundary, a cross-realm throw, or a
 * plain `{code}` object all carry a usable code and none are `Error`s.
 */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * #333 (review LOW) — the hook lane's `errorMessage`.
 *
 * #333 replaced the emitted scripts' broken `errorMessage()` call with
 * `err instanceof Error ? err.message : String(err)`, which is NARROWER than
 * the `@deeppairing/shared` helper it stood in for: a duck-typed
 * `{message: "..."}` throw recorded `"[object Object]"` instead of its message.
 * This restores parity by reading `.message` structurally, exactly as
 * `packages/shared/src/errors.ts::errorMessage` does.
 *
 * It is a local copy rather than an import because `@deeppairing/shared`'s
 * entry is a barrel that pulls zod into a file that must stay a dependency-free
 * standalone script. This is the ONLY hook-lane copy; all four hook lanes now
 * call it.
 */
export function hookErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

/**
 * R1 (#279) — the project-root chain, in ONE place.
 *
 * CLAUDE_PROJECT_DIR wins (Claude Code sets it for hooks), the deepPairing
 * escape hatch next, then the hook event's own cwd where the protocol supplies
 * one (PostToolUse/PreToolUse do; Stop does not), then process.cwd(). Same
 * order everywhere, matching project-root.ts's documented precedence.
 */
export function resolveHookProjectRoot(eventCwd?: unknown): string {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.DEEPPAIRING_PROJECT_ROOT ||
    (typeof eventCwd === "string" && eventCwd ? eventCwd : "") ||
    process.cwd()
  );
}

/** Synchronous sleep — the hook lane has no async seam to yield through. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — spin-free fallback: just retry */
  }
}

/**
 * Acquire the hooks-state lockfile, or return null to proceed UNSYNCHRONIZED.
 *
 * Contract — there are four terminal outcomes, and only the first is success:
 *   - the lock path, meaning the caller owns it and must release it;
 *   - null because a non-EEXIST `open` failed (missing directory, denied
 *     access, out of space): spinning cannot improve those;
 *   - null because a `stat`/`unlink` on the lock failed with anything other
 *     than ENOENT: a permission error on the lock is terminal, while ENOENT
 *     just means the holder released it and we retry;
 *   - null because LOCK_MAX_WAIT_MS elapsed under live contention.
 * Every one of them means "write anyway, unsynchronized" — degraded beats
 * silently dropping the record, and a hook may never fail its tool call.
 *
 * M1 (#332 review) — the stale-lock breaker is bounded to ONE break per call
 * rather than gated on the deadline. Gating it on the deadline looked
 * equivalent and was not: a single `openSync` slower than the 500 ms budget
 * (WSL /mnt/c 9P latency, which CLAUDE.md names explicitly; a suspend/resume
 * clock jump) made the breaker unreachable — and this function holds the ONLY
 * code in the repo that ever removes `hooks-state.json.lock`. A lock left by a
 * killed hook then wedged every subsequent hook into permanent unsynchronized
 * operation, silently reinstating the lost-update bug the lockfile exists to
 * prevent. `brokeStale` keeps the loop bounded (one stat, one unlink, at most)
 * while restoring recovery on a slow filesystem.
 */
export function acquireHookStateLock(statePath: string, now: number = Date.now()): string | null {
  const lock = `${statePath}.lock`;
  const deadline = now + LOCK_MAX_WAIT_MS;
  let brokeStale = false;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY));
      return lock;
    } catch (error) {
      // Only EEXIST is contention. Other failures cannot improve by spinning.
      if (errnoCode(error) !== "EEXIST") return null;
      try {
        if (!brokeStale && Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Set BEFORE the unlink: an unlink that throws must not re-arm the
          // break, or a permanently undeletable stale lock spins the breaker.
          brokeStale = true;
          fs.unlinkSync(lock); // a crashed hook must not wedge the next one
          continue;
        }
      } catch (staleErr) {
        // ENOENT means the holder released the lock; retry with the same
        // deadline and backoff. A stat/unlink permission error is terminal.
        if (errnoCode(staleErr) !== "ENOENT") return null;
      }
      if (Date.now() >= deadline) return null;
      sleepSync(LOCK_SPIN_MS);
    }
  }
}

export function releaseHookStateLock(lock: string | null): void {
  if (!lock) return;
  try {
    fs.unlinkSync(lock);
  } catch {
    /* already gone */
  }
}

/**
 * Read hooks-state.json, and NEVER silently discard history (Q1 item 4).
 *
 * Three outcomes:
 *   - absent            → a fresh `{version:1}`, no backup (nothing was lost);
 *   - present + valid   → the parsed object;
 *   - present + corrupt → a fresh object, but the bytes are first copied to
 *     `hooks-state.json.corrupt-<ISO>` so the fire log is recoverable by hand.
 *     The backup is best-effort: if it fails we still reset, because a hook may
 *     never fail the tool call it is gating.
 */
export function readHookState(statePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return { version: 1 }; // absent / unreadable — nothing to salvage
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the salvage copy */
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`${statePath}.corrupt-${stamp}`, raw);
  } catch {
    /* best-effort */
  }
  return { version: 1 };
}

export function writeHookStateAtomic(statePath: string, state: unknown): void {
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never mask the real error */
    }
    throw err;
  }
}

/**
 * Append one fire record under the lock, with `mutate` applied to the same
 * state object in the same critical section.
 *
 * `mutate` is how the preflight lane stamps its dedup record in ONE
 * read-modify-write with the fire — a second lock/RMW pair would reintroduce
 * exactly the lost-update the lock exists to prevent.
 *
 * Never throws: recording must not fail the hook itself.
 */
export function appendHookFire(
  statePath: string,
  fire: Record<string, unknown>,
  mutate?: (state: Record<string, unknown>) => void,
): void {
  try {
    // Before the lock — O_EXCL needs the directory to exist.
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const lock = acquireHookStateLock(statePath);
    try {
      const state = readHookState(statePath);
      state.version = 1;
      const fires = Array.isArray(state.fires) ? (state.fires as unknown[]) : [];
      fires.push(fire);
      state.fires = fires.slice(-FIRE_LOG_CAP);
      mutate?.(state);
      writeHookStateAtomic(statePath, state);
    } finally {
      releaseHookStateLock(lock);
    }
  } catch {
    /* recording must never fail the hook itself */
  }
}

/** The hooks-state path for a project root. */
export function hookStatePath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", "hooks-state.json");
}
