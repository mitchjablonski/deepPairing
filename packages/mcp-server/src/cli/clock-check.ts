import fs from "node:fs";

/**
 * #500 — `deeppairing doctor` clock-health check.
 *
 * deepPairing's lock staleness, receipt freshness and timeouts compare
 * `Date.now()` (wall clock) against file mtimes. A wall clock that steps
 * backwards (typically WSL with the Windows Time service stopped, so the VM
 * clock is periodically re-stepped) breaks those comparisons. We detect it by
 * sampling wall vs monotonic deltas for a short window. No network, no I/O
 * beyond one optional /proc/version read.
 *
 * Thresholds (all injectable):
 *  - samples 50 x intervalMs 8 => ~400 ms, under the 500 ms budget.
 *  - backward step: any adjacent wall delta below -backStepToleranceMs (1 ms,
 *    absorbing Date.now() integer rounding). NTP slewing never goes backwards,
 *    so a genuine negative delta is a step.
 *  - drift: |wall elapsed - monotonic elapsed| over the whole sample above
 *    driftThresholdMs (50 ms). A healthy clock differs by well under 5 ms over
 *    400 ms; 50 ms is ~10x headroom against scheduler jitter while the known
 *    bad host stepped by seconds.
 */
export interface ClockSources {
  /** Wall clock, ms (Date.now). */
  now: () => number;
  /** Monotonic clock, ms (performance.now). */
  mono: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ClockCheckOptions {
  sources?: ClockSources;
  samples?: number;
  intervalMs?: number;
  backStepToleranceMs?: number;
  driftThresholdMs?: number;
  /** Returns /proc/version text, or null when unreadable (non-Linux). */
  readProcVersion?: () => string | null;
}

export interface ClockCheckResult {
  ok: boolean;
  /** Largest backwards wall-clock step seen, ms (0 if none). */
  maxBackStepMs: number;
  /** wall elapsed minus monotonic elapsed over the sample, ms. */
  driftMs: number;
  wsl: boolean;
  /** Lines to print when !ok (headline first). Empty when ok. */
  messageLines: string[];
}

const realSources: ClockSources = {
  now: () => Date.now(),
  mono: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function defaultReadProcVersion(): string | null {
  try {
    return fs.readFileSync("/proc/version", "utf-8");
  } catch {
    return null;
  }
}

export async function checkClock(opts: ClockCheckOptions = {}): Promise<ClockCheckResult> {
  const src = opts.sources ?? realSources;
  const samples = opts.samples ?? 50;
  const intervalMs = opts.intervalMs ?? 8;
  const tol = opts.backStepToleranceMs ?? 1;
  const driftMax = opts.driftThresholdMs ?? 50;

  let prevWall = src.now();
  const wall0 = prevWall;
  const mono0 = src.mono();
  let maxBack = 0;
  for (let i = 0; i < samples; i++) {
    await src.sleep(intervalMs);
    const w = src.now();
    const delta = w - prevWall;
    if (delta < -tol) maxBack = Math.max(maxBack, -delta);
    prevWall = w;
  }
  const driftMs = prevWall - wall0 - (src.mono() - mono0);
  const stepped = maxBack > 0;
  const drifted = Math.abs(driftMs) > driftMax;

  const procVersion = (opts.readProcVersion ?? defaultReadProcVersion)();
  const wsl = !!procVersion && /microsoft/i.test(procVersion);

  if (!stepped && !drifted) {
    return { ok: true, maxBackStepMs: 0, driftMs, wsl, messageLines: [] };
  }

  const lines: string[] = [];
  lines.push(
    stepped
      ? `Your system clock is jumping (wall clock stepped back ${Math.round(maxBack)} ms). deepPairing's locks and timeouts rely on it.`
      : `Your system clock is drifting (wall clock differed from the monotonic clock by ${Math.round(driftMs)} ms in under a second). deepPairing's locks and timeouts rely on it.`,
  );
  if (wsl) {
    lines.push("Under WSL this usually means the Windows Time service is stopped. In an admin PowerShell run:");
    lines.push("  Set-Service W32Time -StartupType Automatic; Start-Service W32Time; w32tm /resync");
    lines.push("then run `wsl --shutdown` and reopen your WSL terminal.");
  } else {
    lines.push("Check `timedatectl` (look for \"System clock synchronized: yes\") and that NTP (chrony, systemd-timesyncd or ntpd) is running.");
  }
  return { ok: false, maxBackStepMs: maxBack, driftMs, wsl, messageLines: lines };
}
