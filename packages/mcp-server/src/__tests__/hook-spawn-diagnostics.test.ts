import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { beginHookSpawn, hookSpawnDiagnostic, observeHookChild } from "./hook-spawn-diagnostics.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("dp-spawn-diagnostic-")) throw new Error("unsafe fixture cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-spawn-diagnostic-"));
  roots.push(root);
  const statePath = path.join(root, "hooks-state.json");
  fs.writeFileSync(statePath, JSON.stringify({ fires: [] }));
  return { root, statePath };
}
function run(script: string, deadlineMs = 5000) {
  const { root, statePath } = fixture();
  const observation = beginHookSpawn("probe", deadlineMs, statePath);
  const child = spawn(process.execPath, ["-e", script], { cwd: root, timeout: deadlineMs, stdio: ["ignore", "pipe", "pipe"] });
  return observeHookChild(child, observation);
}

describe("hook subprocess failure diagnostics (#500)", () => {
  it("retains a successful exit and its output", async () => {
    const result = await run('console.log("out"); console.error("err")');
    expect(result.status, result.diagnostic).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(JSON.parse(result.diagnostic)).toMatchObject({ lane: "probe", deadlineMs: 5000, exitCode: 0, signal: null, fireDelta: 0 });
  });
  it("retains nonzero exit and caps accumulated output", async () => {
    const result = await run('process.stdout.write("o".repeat(100000)); process.stderr.write("e".repeat(100000)); process.exitCode=7');
    expect(result.status, result.diagnostic).toBe(7);
    expect(result.stdout.length).toBeLessThan(1100);
    expect(result.stderr.length).toBeLessThan(1100);
    expect(result.stdout).toContain("chars omitted");
    expect(result.stderr).toContain("chars omitted");
    expect(JSON.parse(result.diagnostic).stdout).toContain("98976 chars omitted");
    expect(JSON.parse(result.diagnostic).stderr).toContain("98976 chars omitted");
    expect(result.diagnostic.length).toBeLessThan(3000);
  });
  it("reports a silent deadline termination as a signal, not an empty error", async () => {
    const result = await run("setInterval(()=>{},1000)", 1000);
    expect(result.status, result.diagnostic).toBeNull();
    expect(result.signal, result.diagnostic).toBe("SIGTERM");
    expect(JSON.parse(result.diagnostic)).toMatchObject({ deadlineMs: 1000, exitCode: null, signal: "SIGTERM" });
    expect(JSON.parse(result.diagnostic).elapsedMs).toBeGreaterThanOrEqual(900);
  });
  it("retains a spawn error code", async () => {
    const { root, statePath } = fixture();
    const observation = beginHookSpawn("missing-executable", 5000, statePath);
    const result = await observeHookChild(spawn(path.join(root, "absent-command"), [], { stdio: ["ignore", "pipe", "pipe"] }), observation);
    expect(JSON.parse(result.diagnostic).error.code).toBe("ENOENT");
    expect(result.signal).toBeNull();
  });
  it("summarizes state without exporting raw history, and bounds synchronous errors/output", () => {
    const { statePath } = fixture();
    const observation = beginHookSpawn("generated checkpoint", 5000, statePath);
    fs.writeFileSync(statePath, JSON.stringify({ fires: [{ reason: "pass: fixture", privatePayload: "DO-NOT-EXPORT" }] }));
    fs.writeFileSync(`${statePath}.lock`, "");
    const diagnostic = hookSpawnDiagnostic(observation, { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT", message: "m".repeat(10000) }, stderr: "e".repeat(10000) });
    expect(JSON.parse(diagnostic)).toMatchObject({ error: { code: "ETIMEDOUT" }, beforeFireCount: 0, fireDelta: 1, state: { fireCount: 1, lastReason: "pass: fixture", lock: { present: true } } });
    expect(diagnostic).not.toContain("DO-NOT-EXPORT");
    expect(diagnostic.length).toBeLessThan(2000);
  });
  it("cannot throw or export raw bytes when the observed state is corrupt or oversized", () => {
    const { statePath } = fixture();
    const observation = beginHookSpawn("probe", 5000, statePath);
    fs.writeFileSync(statePath, "{PRIVATE-INVALID-STATE");
    const corrupt = hookSpawnDiagnostic(observation, { status: 0, signal: null });
    expect(JSON.parse(corrupt).state.stateIssue).toBe("SyntaxError");
    expect(corrupt).not.toContain("PRIVATE-INVALID-STATE");
    fs.writeFileSync(statePath, "x".repeat(65537));
    expect(JSON.parse(hookSpawnDiagnostic(observation, { status: 0, signal: null })).state.stateIssue).toBe("oversize");
  });
});
