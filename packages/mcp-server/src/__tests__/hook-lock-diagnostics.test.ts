import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { STOP_HOOK_SCRIPT } from "../cli/hook-scripts.generated.js";
import { beginHookSpawn, hookSpawnDiagnostic } from "./hook-spawn-diagnostics.js";
import { HOOK_LOCK_FIXTURE_EPOCH_MS, hookLockEvidence, prepareHookLockObserver } from "./hook-lock-diagnostics.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("dp-lock-diagnostic-")) throw new Error("unsafe fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-lock-diagnostic-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions"), { recursive: true });
  const statePath = path.join(root, ".deeppairing", "hooks-state.json");
  const script = path.join(root, "stop.mjs");
  fs.writeFileSync(script, STOP_HOOK_SCRIPT);
  fs.writeFileSync(statePath, JSON.stringify({ fires: [] }));
  return { root, statePath, script, lock: `${statePath}.lock` };
}
function run(f: ReturnType<typeof fixture>, prelude = "", clock: { fixtureEpochMs?: number; lockAgeMs?: number | null } = { fixtureEpochMs: HOOK_LOCK_FIXTURE_EPOCH_MS }) {
  const planted = new Date((clock.fixtureEpochMs ?? Date.now()) - (clock.lockAgeMs ?? 10_000));
  if (clock.lockAgeMs !== null) {
    fs.writeFileSync(f.lock, "");
    fs.utimesSync(f.lock, planted, planted);
  }
  const observation = beginHookSpawn("generated stop control", 5000, f.statePath);
  const preload = prepareHookLockObserver(observation, prelude, clock);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, f.script], {
    cwd: f.root, encoding: "utf8", input: "{}", timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: f.root, DEEPPAIRING_PROJECT_ROOT: f.root },
  });
  const diagnostic = hookSpawnDiagnostic(observation, result);
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.status, diagnostic).toBe(0);
  expect(JSON.parse(diagnostic).fireDelta, diagnostic).toBe(1);
  return { diagnostic, data: JSON.parse(diagnostic), planted: planted.getTime() };
}

describe("stale-lock diagnostic controls (#500), not a flake fix", () => {
  it("records planted mtime and successful stale unlink under the explicit fixture clock", () => {
    const f = fixture();
    const { data, diagnostic, planted } = run(f);
    expect(data.beforeLock.mtimeMs, diagnostic).toBeCloseTo(planted, 0);
    expect(data.childLock.entry.mtimeMs, diagnostic).toBeCloseTo(planted, 0);
    expect(data.childLock.entry.ageMs, diagnostic).toBeGreaterThan(9000);
    expect(data.childLock.clockMode, diagnostic).toBe("fixture-monotonic");
    expect(data.childLock.fixtureEpochMs, diagnostic).toBe(HOOK_LOCK_FIXTURE_EPOCH_MS);
    expect(data.childLock.entry.rawWallMs, diagnostic).toEqual(expect.any(Number));
    expect(data.childLock.calls.unlinkSync, diagnostic).toMatchObject({ count: 2, outcome: "ok" });
    expect(data.childLock.exit.issue, diagnostic).toBe("ENOENT");
    expect(fs.existsSync(f.lock), diagnostic).toBe(false);
  });

  it("distinguishes parent-only clock skew from a timeout or failed unlink", () => {
    const f = fixture();
    // Only this Vitest worker's Date changes; the real child and host clocks do not.
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(realNow + 30_000);
    const { data, diagnostic } = run(f, "", {});
    expect(data.beforeLock.ageMs, diagnostic).toBeGreaterThan(9000);
    expect(data.startedWallMs - data.childLock.entry.wallMs, diagnostic).toBeGreaterThan(20_000);
    expect(data.childLock.entry.ageMs, diagnostic).toBeLessThan(-10_000);
    expect(data.childLock.calls.unlinkSync, diagnostic).toBeUndefined();
    expect(data.signal, diagnostic).toBeNull();
    expect(data.state.lock.present, diagnostic).toBe(true);
    expect(fs.existsSync(f.lock), diagnostic).toBe(true);
    // Exercise the same failing final assertion, including its evidence message.
    expect(() => expect(fs.existsSync(f.lock), diagnostic).toBe(false)).toThrow(/childLock.*wallMs.*mtimeMs/);
  });

  it("keeps an unfaked real-clock smoke path without a planted age premise", () => {
    const f = fixture();
    const { data, diagnostic } = run(f, "", { lockAgeMs: null });
    expect(data.childLock.clockMode, diagnostic).toBe("real");
    expect(data.childLock.entry.issue, diagnostic).toBe("ENOENT");
    expect(data.childLock.calls.unlinkSync, diagnostic).toMatchObject({ count: 1, outcome: "ok" });
    expect(data.childLock.exit.issue, diagnostic).toBe("ENOENT");
    expect(fs.existsSync(f.lock), diagnostic).toBe(false);
  });

  it.each([["fresh", 0], ["future", -60_000]] as const)("never breaks a %s lock under the fixture clock", (_name, lockAgeMs) => {
    const f = fixture();
    const { data, diagnostic } = run(f, "", { fixtureEpochMs: HOOK_LOCK_FIXTURE_EPOCH_MS, lockAgeMs });
    expect(data.childLock.clockMode, diagnostic).toBe("fixture-monotonic");
    expect(data.childLock.entry.ageMs, diagnostic).toBeLessThan(5000);
    expect(data.childLock.calls.unlinkSync, diagnostic).toBeUndefined();
    expect(data.childLock.calls.openSync.outcome, diagnostic).toBe("error");
    expect(data.childLock.calls.openSync.issue, diagnostic).toBe("EEXIST");
    expect(data.childLock.exit.wallMs - data.childLock.entry.wallMs, diagnostic).toBeGreaterThanOrEqual(500);
    expect(fs.existsSync(f.lock), diagnostic).toBe(true);
  });

  it("preserves a stale fixture through a controlled within-child backward wall step", () => {
    // This changes only the child's input wall-clock source. Raw OS telemetry
    // is captured before this preload; no host clock or Date constructor changes.
    const backwardStep = `const sourceNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => sourceNow() + offset;
queueMicrotask(() => { offset = -7000; });`;
    const negative = run(fixture(), backwardStep, {});
    expect(negative.data.childLock.clockMode, negative.diagnostic).toBe("prelude-wall");
    expect(negative.data.childLock.entry.inputWallMs - negative.data.childLock.exit.inputWallMs, negative.diagnostic).toBeGreaterThan(5000);
    expect(negative.data.childLock.calls.unlinkSync, negative.diagnostic).toBeUndefined();
    expect(negative.data.state.lock.present, negative.diagnostic).toBe(true);

    const stable = run(fixture(), backwardStep);
    expect(stable.data.childLock.clockMode, stable.diagnostic).toBe("fixture-monotonic");
    expect(stable.data.childLock.entry.inputWallMs - stable.data.childLock.exit.inputWallMs, stable.diagnostic).toBeGreaterThan(5000);
    expect(stable.data.childLock.exit.wallMs, stable.diagnostic).toBeGreaterThanOrEqual(stable.data.childLock.entry.wallMs);
    expect(stable.data.childLock.entry.ageMs, stable.diagnostic).toBeGreaterThan(9000);
    expect(stable.data.childLock.calls.unlinkSync, stable.diagnostic).toMatchObject({ count: 2, outcome: "ok" });
    expect(stable.data.state.lock.present, stable.diagnostic).toBe(false);
  });

  it("distinguishes an old lock with an unlink error from clock skew", () => {
    const f = fixture();
    const { data, diagnostic } = run(f, `import fs from 'node:fs';
const realUnlink = fs.unlinkSync;
fs.unlinkSync = (p, ...args) => {
  if (String(p) === ${JSON.stringify(f.lock)}) throw Object.assign(new Error('injected'), {code:'EACCES'});
  return realUnlink(p, ...args);
};`);
    expect(data.childLock.entry.ageMs, diagnostic).toBeGreaterThan(9000);
    expect(data.childLock.calls.unlinkSync, diagnostic).toMatchObject({ count: 1, outcome: "error", issue: "EACCES" });
    expect(data.state.lock.present, diagnostic).toBe(true);
    expect(data.signal, diagnostic).toBeNull();
  });

  it("whitelists metadata and handles missing, partial, corrupt and oversized evidence", () => {
    const f = fixture();
    const observation = beginHookSpawn("control", 5000, f.statePath);
    prepareHookLockObserver(observation);
    const evidence = observation.childLockEvidencePath!;
    expect(hookLockEvidence(observation)).toEqual({ issue: "unreadable" });
    fs.writeFileSync(evidence, JSON.stringify({ entry: { wallMs: 123, rawHookInput: "PRIVATE" }, calls: { unlinkSync: { count: 1, issue: "EACCES", receipt: "PRIVATE" }, secret: "PRIVATE" }, credentials: "PRIVATE" }));
    expect(hookLockEvidence(observation)).toEqual({ entry: { wallMs: 123 }, partial: true, calls: { unlinkSync: { count: 1, issue: "EACCES" } } });
    expect(hookSpawnDiagnostic(observation, { status: 0, signal: null })).not.toContain("PRIVATE");
    fs.writeFileSync(evidence, "{PRIVATE");
    expect(hookLockEvidence(observation)).toEqual({ issue: "unreadable" });
    fs.writeFileSync(evidence, "x".repeat(8193));
    expect(hookLockEvidence(observation)).toEqual({ issue: "oversize" });
  });
});
