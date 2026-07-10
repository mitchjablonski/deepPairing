/**
 * H1 hardening — two small guards that keep a transient, routine failure from
 * killing an otherwise-healthy daemon. Both are pure and dependency-injected
 * (the watcher / tick / log are passed in) so they're unit-testable with real
 * fakes (a real EventEmitter, a throwing function) rather than mocks.
 */

/** Minimal surface of the object fs.watch returns (an EventEmitter). */
export interface ErrorEmittingWatcher {
  on(event: "error", cb: (err: unknown) => void): unknown;
  close?: () => void;
}

/**
 * H1-2 — an `fs.watch` watcher is an EventEmitter. When it emits `'error'`
 * (inotify watch-limit exhaustion — routine on Linux/WSL2 — or the watched
 * directory being removed) with NO `'error'` listener attached, Node THROWS
 * the error. That throw reaches the daemon's top-level `uncaughtException`
 * handler → `process.exit(1)`: the single most likely uncommanded daemon
 * death. (The change callback is already try/caught; the watcher's own error
 * channel was not.) Attach a listener that logs ONCE and degrades gracefully —
 * close the watcher and keep the daemon alive without live hook-status
 * updates.
 */
export function guardWatcher(
  watcher: ErrorEmittingWatcher,
  log: (msg: string) => void,
): void {
  let handled = false;
  watcher.on("error", (err) => {
    if (handled) return; // log once — a broken watch can re-emit
    handled = true;
    const e = err as { code?: string; message?: string } | undefined;
    log(
      `[hook-watcher] watcher error (${e?.code ?? e?.message ?? err}); disabling live ` +
        `hook-status updates but keeping the daemon alive. Common cause: inotify watch ` +
        `limit — raise fs.inotify.max_user_watches to restore live updates.`,
    );
    try {
      watcher.close?.();
    } catch {
      /* watch is already gone — nothing to clean up */
    }
  });
}

/**
 * H1-3 — the 30s heartbeat (`setInterval(() => writeDaemonInfo(port), 30000)`)
 * calls `writeDaemonInfo`, which RE-THROWS on a transient write failure
 * (ENOSPC/EACCES/EBUSY). The STARTUP call is awaited under `main().catch` and
 * is INTENTIONALLY fatal/loud (a daemon that can't write its discovery file on
 * boot is useless). But a throw from the `setInterval` callback is an
 * `uncaughtException` → `exit(1)`: a single transient FS hiccup at any tick
 * kills a healthy daemon. Wrap each periodic tick so it logs and continues;
 * the startup call's fatal semantics are preserved by NOT routing it through
 * here.
 */
/**
 * H2-3 (#146) — mutable state threaded across ticks so safeHeartbeatTick can
 * count CONSECUTIVE failures and escalate a persistent one. A fresh object per
 * daemon; passing it in (rather than a module-level counter) keeps the function
 * pure enough to unit-test with a real object + a throwing fake.
 */
export interface HeartbeatState {
  consecutiveFailures: number;
}

/**
 * H2-3 (#146) — escalate after this many CONSECUTIVE failed ticks. The
 * heartbeat runs every 30s: one failure self-heals on the next tick (~30s), so
 * a single hiccup stays quiet (only the routine per-tick log). Three in a row is
 * ~90s of sustained failure — no longer "transient" but a standing condition (a
 * full disk, a permanent EACCES) that leaves daemon.json stale/possibly
 * truncated while nothing else notices. Escalate ONCE at the threshold (`===`,
 * not `>=`) so a stuck daemon doesn't spam stderr every 30s; the counter resets
 * to 0 on the next success, so a recover-then-refail cycle re-escalates.
 */
export const HEARTBEAT_ESCALATE_AFTER = 3;

export function safeHeartbeatTick(
  tick: () => void,
  log: (msg: string) => void,
  state?: HeartbeatState,
  escalate?: (msg: string) => void,
): void {
  try {
    tick();
    // Success — a prior run of failures is over.
    if (state) state.consecutiveFailures = 0;
  } catch (err) {
    const e = err as { code?: string; message?: string } | undefined;
    const detail = e?.code ?? e?.message ?? String(err);
    log(
      `[heartbeat] periodic writeDaemonInfo failed (${detail}); ` +
        `continuing — the daemon stays up and the next tick will retry.`,
    );
    if (state) {
      state.consecutiveFailures += 1;
      // Escalate exactly once when we cross the threshold. NOT fatal — the
      // periodic tick stays non-fatal by design (only the STARTUP write is
      // fatal); this just makes a persistent failure loud instead of silent.
      if (state.consecutiveFailures === HEARTBEAT_ESCALATE_AFTER && escalate) {
        escalate(
          `[deepPairing daemon] WARNING: writeDaemonInfo has failed ${state.consecutiveFailures} consecutive heartbeats ` +
            `(~${state.consecutiveFailures * 30}s) — last error: ${detail}. The discovery file .deeppairing/daemon.json may be ` +
            `stale or truncated, so new wrappers/UI could fail to connect. The daemon is still serving; free disk space or fix ` +
            `permissions on .deeppairing/, or restart the daemon.`,
        );
      }
    }
  }
}
