/**
 * #470 (§5) — the wrapper's unregister on the way out. A stance allowance ends
 * when its registration leaves the daemon's live map, so the unregister must
 * actually LAND: SIGINT/SIGTERM await it (bounded, so a dead daemon can't hold
 * the exit), and stdin closing — how Claude Code tears down a stdio MCP
 * server — unregisters too. The `exit` handler cannot await; it stays
 * best-effort. Unregister runs at most once.
 */
export interface ShutdownProcess {
  on(event: "exit" | "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): void;
  stdin: { on(event: "end" | "close", listener: () => void): unknown };
}

export function installWrapperShutdown(opts: {
  proc: ShutdownProcess;
  unregister: () => Promise<void>;
  flush?: () => Promise<void>;
  log: (msg: string) => void;
  timeoutMs?: number;
}): { unregisterOnce: () => Promise<void> } {
  const { proc, log, timeoutMs = 500 } = opts;
  let pending: Promise<void> | null = null;
  const unregisterOnce = () => (pending ??= opts.unregister().catch(() => {}));
  const bounded = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void unregisterOnce().then(() => { clearTimeout(timer); resolve(); });
  });
  proc.on("exit", () => {
    void unregisterOnce();
    opts.flush?.().catch(() => {});
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    proc.on(signal, () => {
      log(`Shutting down (${signal})`);
      void bounded().then(() => proc.exit(0));
    });
  }
  proc.stdin.on("end", () => { void unregisterOnce(); });
  proc.stdin.on("close", () => { void unregisterOnce(); });
  return { unregisterOnce };
}
