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
export function safeHeartbeatTick(tick: () => void, log: (msg: string) => void): void {
  try {
    tick();
  } catch (err) {
    const e = err as { code?: string; message?: string } | undefined;
    log(
      `[heartbeat] periodic writeDaemonInfo failed (${e?.code ?? e?.message ?? err}); ` +
        `continuing — the daemon stays up and the next tick will retry.`,
    );
  }
}
