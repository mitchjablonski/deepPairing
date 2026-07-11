/**
 * #157 — one-line SOURCE PINS for wiring in the composition path.
 *
 * Honesty note (same convention as ws-lifecycle.test.ts): these are TEXT
 * pins, not behavior tests. The behavior is covered by the factory-level
 * suites (daemon/__tests__/create-daemon*.test.ts) and the real-spawn
 * ensure-daemon-version-gate.test.ts; these pins are the cheap belt that
 * fails in milliseconds if a refactor drops the call without moving it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), "utf-8");

describe("#157 — composition-path source pins", () => {
  it("create-daemon.ts wires the hooks watcher through guardWatcher(", () => {
    const src = read("../daemon/create-daemon.ts");
    // The call, not just the import — `guardWatcher(watcher, log)` in
    // startHooksWatcher. Deleting it (H1-2 audit mutation) revives the
    // "daemon mysteriously died overnight" inotify crash mode.
    expect(src).toMatch(/guardWatcher\(watcher/);
  });

  it("create-daemon.ts wires the heartbeat through safeHeartbeatTick(", () => {
    const src = read("../daemon/create-daemon.ts");
    expect(src).toMatch(/safeHeartbeatTick\(/);
  });

  it("create-daemon.ts applies the top-level guards to the root app", () => {
    const src = read("../daemon/create-daemon.ts");
    expect(src).toMatch(/applyTopLevelGuards\(app/);
  });

  it("ensureDaemon calls resolveStaleDaemon( — the #136 version gate", () => {
    const src = read("../daemon/lifecycle.ts");
    // Pin the call INSIDE ensureDaemon's body (the exported function also
    // appears as a definition earlier in the file — match the await call).
    expect(src).toMatch(/await resolveStaleDaemon\(existing/);
  });

  it("index.ts (the entry) composes via createDaemon( and keeps the startup writeDaemonInfo UNWRAPPED", () => {
    const src = read("../daemon/index.ts");
    expect(src).toMatch(/createDaemon\(\{/);
    // The startup-fatal / periodic-tolerant asymmetry (H1-3, reviewed twice):
    // the entry must call writeDaemonInfo directly (throw → main().catch)
    // and start the heartbeat separately (wrapped inside the factory).
    expect(src).toMatch(/daemon\.writeDaemonInfo\(port\)/);
    expect(src).toMatch(/daemon\.startHeartbeat\(port\)/);
  });
});
