import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { finishLedgerChild, ledgerWorkBudget, observeLedgerChild } from "./ledger-child-handoff.js";

it("exhausted sequential work phases get zero new budget even with a frozen wall clock", async () => {
  const wall = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    const remaining = ledgerWorkBudget(20);
    expect(remaining()).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(remaining()).toBe(0);
    expect(remaining()).toBe(0); // the next phase cannot restart the budget
  } finally { wall.mockRestore(); }
});

it("rejects another writer's lock and bounds its watchdog despite a frozen wall clock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-handoff-"));
  const lock = path.join(dir, "queue.lock");
  const observed = observeLedgerChild(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]));
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "not-the-child" }));
  const wall = vi.spyOn(Date, "now").mockReturnValue(0);
  const start = performance.now();
  try {
    await expect(observed.ownedQueue(lock, 100)).rejects.toThrow("deadline 100ms");
    expect(performance.now() - start).toBeLessThan(2_000);
  } finally {
    wall.mockRestore();
    observed.child.kill();
    await observed.collect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("fails handoff early on child exit and captures bounded drained stderr with exit code", async () => {
  const observed = observeLedgerChild(spawn(process.execPath, ["-e", "process.stderr.write('x'.repeat(100000));process.exitCode=7"]));
  try {
    await expect(observed.ownedQueue(path.join(os.tmpdir(), "missing-ledger-handoff.lock"))).rejects.toThrow("child stopped");
    await observed.collect();
    expect(observed.result).toEqual({ code: 7, signal: null });
    const evidence = JSON.parse(observed.diagnostic());
    expect(evidence.stderr).toHaveLength(2048);
    expect(evidence.stderrOmitted).toBeGreaterThan(0);
  } finally { await observed.collect(); }
});

it("captures spawn errors instead of an unhandled error or a 30s queue poll", async () => {
  const observed = observeLedgerChild(spawn(path.join(os.tmpdir(), "missing-ledger-child-executable")));
  try {
    await expect(observed.ownedQueue("unused.lock")).rejects.toThrow("child stopped");
    await observed.collect();
    expect(observed.diagnostic()).toContain("ENOENT");
  } finally { await observed.collect(); }
});

it("collects an uncooperative child by signal and preserves primary plus release failures", async () => {
  const observed = observeLedgerChild(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]));
  await expect(observed.collect(100)).rejects.toThrow("required termination");
  expect(observed.result?.signal).not.toBeNull();
  const primary = new Error("primary assertion");
  const release = new Error("release failed");
  try {
    await finishLedgerChild(observed, () => { throw release; }, primary);
    throw new Error("cleanup unexpectedly passed");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primary, release]);
  }
});
