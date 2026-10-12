import { describe, it, expect } from "vitest";
import { checkClock, type ClockSources } from "../clock-check.js";

/** Fake clocks: each sleep advances both clocks by `step`, then applies a
 *  per-tick wall adjustment. No timers, no real time. */
function fakeSources(wallAdjust: (tick: number) => number = () => 0, step = 8): ClockSources {
  let wall = 1_700_000_000_000;
  let mono = 1000;
  let tick = 0;
  return {
    now: () => wall,
    mono: () => mono,
    sleep: async () => {
      tick++;
      wall += step + wallAdjust(tick);
      mono += step;
    },
  };
}
const linux = () => "Linux version 6.5.0-generic (buildd@lcy02)";
const wslVer = () => "Linux version 6.6.87.2-microsoft-standard-WSL2";

describe("checkClock (#500)", () => {
  it("is quiet on a healthy clock", async () => {
    const r = await checkClock({ sources: fakeSources(), readProcVersion: linux });
    expect(r.ok).toBe(true);
    expect(r.messageLines).toEqual([]);
  });

  it("warns when the wall clock steps backwards", async () => {
    const r = await checkClock({
      sources: fakeSources((t) => (t === 20 ? -7400 : 0)),
      readProcVersion: linux,
    });
    expect(r.ok).toBe(false);
    expect(r.maxBackStepMs).toBe(7392);
    expect(r.messageLines[0]).toContain("Your system clock is jumping (wall clock stepped back 7392 ms)");
  });

  it("warns on excessive wall-vs-monotonic drift without a backward step", async () => {
    const r = await checkClock({
      sources: fakeSources((t) => (t === 10 ? 200 : 0)),
      readProcVersion: linux,
    });
    expect(r.ok).toBe(false);
    expect(r.maxBackStepMs).toBe(0);
    expect(r.messageLines[0]).toContain("drifting");
    expect(r.messageLines[0]).toContain("200 ms");
  });

  it("respects injected thresholds", async () => {
    const src = () => fakeSources((t) => (t === 10 ? 20 : 0));
    expect((await checkClock({ sources: src(), readProcVersion: linux })).ok).toBe(true);
    expect((await checkClock({ sources: src(), readProcVersion: linux, driftThresholdMs: 10 })).ok).toBe(false);
  });

  it("gives the Windows Time fix under WSL", async () => {
    const r = await checkClock({ sources: fakeSources((t) => (t === 5 ? -100 : 0)), readProcVersion: wslVer });
    expect(r.wsl).toBe(true);
    const text = r.messageLines.join("\n");
    expect(text).toContain("Set-Service W32Time -StartupType Automatic; Start-Service W32Time; w32tm /resync");
    expect(text).toContain("wsl --shutdown");
    expect(text).not.toContain("timedatectl");
  });

  it("suggests timedatectl/NTP on plain Linux and when /proc/version is unreadable", async () => {
    for (const reader of [linux, () => null]) {
      const r = await checkClock({ sources: fakeSources((t) => (t === 5 ? -100 : 0)), readProcVersion: reader });
      expect(r.wsl).toBe(false);
      const text = r.messageLines.join("\n");
      expect(text).toContain("timedatectl");
      expect(text).not.toContain("W32Time");
    }
  });
});
