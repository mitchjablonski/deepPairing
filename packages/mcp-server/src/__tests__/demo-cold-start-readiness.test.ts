/**
 * #168 — cold-start readiness: adaptive wait + progress line + truthful timeout.
 *
 * The old `waitForDaemon` gave up at a hardcoded 10s while a healthy daemon was
 * still cold-booting (~22s measured on WSL /mnt/c 9P), so a cold demo run
 * "failed" then "worked on retry". These tests drive the REAL `waitForDaemon`
 * with a fake clock + a fake slow-boot probe (fakes-not-mocks: plain functions
 * satisfying the injected seams) — no real daemon spawn — and pin the truthful
 * timeout message the old code lied on (wrong port range, phantom daemon.log,
 * dead-end `npx deeppairing doctor`).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  waitForDaemon,
  buildReadinessTimeoutMessage,
  doctorCommandHint,
  DEFAULT_READINESS_TIMEOUT_MS,
  READINESS_PROGRESS_MESSAGE,
  MAX_PORT_ATTEMPTS,
  type DaemonInfo,
} from "../daemon/lifecycle.js";
import { preferredPortFor } from "../project-root.js";

/** A fake clock whose sleep() advances virtual time — deterministic, instant. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
}

const infoAt = (port: number): DaemonInfo => ({
  pid: 4242,
  port,
  startedAt: new Date(0).toISOString(),
});

describe("#168 waitForDaemon — adaptive readiness", () => {
  it("adopts a daemon that boots at ~22s (would have thrown under the old 10s ceiling)", async () => {
    const clock = fakeClock();
    const bootAtMs = 22_000;
    const isRunning = async () => (clock.now() >= bootAtMs ? infoAt(29123) : null);

    const info = await waitForDaemon("/proj", {
      isRunning,
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 500,
      onProgress: () => {},
      timeoutMs: DEFAULT_READINESS_TIMEOUT_MS, // 40s — the fix
    });
    expect(info.port).toBe(29123);
  });

  it("PRE-FIX shape: the same 22s boot times out under the old 10s ceiling", async () => {
    const clock = fakeClock();
    const isRunning = async () => (clock.now() >= 22_000 ? infoAt(29123) : null);
    await expect(
      waitForDaemon("/proj", {
        isRunning,
        now: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 500,
        onProgress: () => {},
        describeHolders: async () => "No daemon.json found.",
        timeoutMs: 10_000, // the OLD hardcoded ceiling
      }),
    ).rejects.toThrow(/did not become ready within 10000ms/);
  });

  it("emits exactly one progress line after ~5s so a cold boot doesn't look hung", async () => {
    const clock = fakeClock();
    const isRunning = async () => (clock.now() >= 15_000 ? infoAt(1) : null);
    const progress: string[] = [];
    await waitForDaemon("/proj", {
      isRunning,
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 500,
      progressAfterMs: 5_000,
      onProgress: (m) => progress.push(m),
    });
    expect(progress).toEqual([READINESS_PROGRESS_MESSAGE]);
  });

  it("skips the progress line when the daemon is already up (fast adopt)", async () => {
    const clock = fakeClock();
    const isRunning = async () => infoAt(1); // ready on the first probe
    const progress: string[] = [];
    await waitForDaemon("/proj", { isRunning, now: clock.now, sleep: clock.sleep, onProgress: (m) => progress.push(m) });
    expect(progress).toEqual([]);
  });
});

describe("#168 buildReadinessTimeoutMessage — truthful on every clause", () => {
  it("reports THIS project's actual probed port range, not the shared 3847 base", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-timeout-msg-"));
    const first = preferredPortFor(root);
    const last = first + MAX_PORT_ATTEMPTS - 1;
    const msg = buildReadinessTimeoutMessage({ timeoutMs: 40_000, projectRoot: root, hint: "No daemon.json found." });
    expect(msg).toContain(`probed this project's ports ${first}–${last}`);
    // The test port window is ~20000-32000, so the hardcoded 3847 (the old bug)
    // must NOT appear.
    expect(first).not.toBe(3847);
    expect(msg).not.toContain("3847");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does NOT cite daemon.log before it exists, and DOES once it does", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-timeout-log-"));
    const cold = buildReadinessTimeoutMessage({ timeoutMs: 40_000, projectRoot: root, hint: "x" });
    expect(cold).not.toContain("daemon.log");

    const logPath = path.join(root, ".deeppairing", "daemon.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "boot\n");
    const warm = buildReadinessTimeoutMessage({ timeoutMs: 40_000, projectRoot: root, hint: "x" });
    expect(warm).toContain(logPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recommends a path-form doctor command, never the dead-end npx form", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-timeout-dr-"));
    const msg = buildReadinessTimeoutMessage({ timeoutMs: 40_000, projectRoot: root, hint: "x" });
    expect(msg).toContain("doctor");
    expect(msg).not.toContain("npx deeppairing doctor");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("#168 doctorCommandHint", () => {
  it("uses node + absolute path when the CLI entry is resolvable", () => {
    expect(doctorCommandHint("/abs/dist/cli/init.js")).toBe('node "/abs/dist/cli/init.js" doctor');
  });
  it("falls back to a bare (non-npx) doctor when the CLI can't be located", () => {
    expect(doctorCommandHint(null)).toBe("deeppairing doctor");
  });
});
