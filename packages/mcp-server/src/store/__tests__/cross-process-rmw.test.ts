/**
 * #406 / #408 — whole-file read-modify-write across SEPARATE processes.
 *
 * The cross-project philosophy ledger (written by every project daemon) and a
 * project's preferences.json (written by the daemon AND by CLI processes such
 * as `philosophy publish on|off`) are both replaced by atomic rename. Rename
 * prevents torn JSON, not lost updates: two processes that read the same
 * snapshot and rename in turn silently drop one writer's change. Measured on
 * the pre-fix code with 2 × 100 appends: ~45% of ledger appends and 15–45% of
 * preferences appends vanished.
 *
 * These are real two-process races (node children running the shipped dist
 * runtime, released together by a file barrier), not interleaved async tasks
 * in one process — in-process calls are synchronous and cannot race.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FileStore } from "../file-store.js";
import { GlobalStore } from "../global-store.js";
import { withFileLock } from "../file-lock.js";
import { withSessionFlushLock } from "../session-records.js";
import { readRejectedApproaches } from "../../cli/preflight-hook-core.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

const CHILD_TIMEOUT_MS = 20_000;
// Modest on purpose: large enough that the unlocked implementation loses
// updates on every run we measured, small enough to stay fast on Windows CI.
const N = 40;

let fx: GlobalStoreFixture;

beforeEach(() => {
  fx = withGlobalStore("dp-cross-process-rmw-");
  if (!fs.existsSync(path.resolve("dist/store/file-store.js"))) {
    throw new Error("Run pnpm build before cross-process persistence tests (the children exercise the shipped runtime).");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.dispose();
});

const distUrl = (rel: string) => JSON.stringify(pathToFileURL(path.resolve("dist", rel)).href);

// argv: root ledgerPath mode role n
const childProgram = String.raw`
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const [root, ledgerPath, mode, role, nText] = process.argv.slice(1);
  const n = Number(nText);
  // The daemon-side FileStore mirrors into the DEFAULT ledger once the CLI
  // turns publish on, so HOME is the test's temp dir and VITEST is scrubbed
  // (see defaultLedgerPath). Refuse to run at all unless home IS that dir.
  if (path.resolve(os.homedir()) !== path.resolve(root)) process.exit(5);
  const { GlobalStore } = await import(${distUrl("store/global-store.js")});
  const { FileStore } = await import(${distUrl("store/file-store.js")});
  fs.writeFileSync(path.join(root, ".ready-" + role), "ready");
  const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path.join(root, ".go"))) {
    if (Date.now() >= deadline) process.exit(4);
    Atomics.wait(waiter, 0, 0, 2);
  }
  if (mode === "ledger") {
    // A project daemon mirroring stances into the cross-project ledger.
    const ledger = new GlobalStore(ledgerPath);
    for (let i = 0; i < n; i++) {
      ledger.recordInstance("shared concept", { project: "project-" + role, sessionId: role + "-" + i, verdict: "rejected" });
      ledger.recordInstance("concept " + role + " " + i, { project: "project-" + role, sessionId: role + "-" + i, verdict: "approved" });
    }
    // II6 retry dedupe must survive the transaction: an identical
    // (project, session, verdict) inside 5 s is still one instance.
    ledger.recordInstance("shared concept", { project: "project-" + role, sessionId: role + "-0", verdict: "rejected" });
  } else if (role === "daemon") {
    // Daemon-equivalent: the rejection route's FileStore.
    const store = new FileStore(root, "daemon-session");
    for (let i = 0; i < n; i++) store.recordRejectedApproach({ description: "rejected " + i, concept: "rejected concept " + i });
    store.forceFlush();
    store.dispose();
  } else {
    // CLI-equivalent: init.ts openSeedStore + philosophy publish on|off, plus
    // approvals so both sides append. Ends with publish ON.
    const store = new FileStore(root, "session_cli_seed");
    for (let i = 0; i < n; i++) {
      store.recordApprovedPattern({ description: "approved " + i });
      store.setGlobalLedgerPublish(i % 2 === 1);
    }
    store.forceFlush();
    store.dispose();
  }
`;

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.dir, USERPROFILE: fx.dir, DEEPPAIRING_PORT_BASE: "25000" };
  delete env.VITEST;
  delete env.NODE_ENV;
  return env;
}

function start(mode: "ledger" | "prefs", role: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--input-type=module", "--eval", childProgram,
    fx.dir, fx.ledgerPath, mode, role, String(N),
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(),
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timeout; stderr=${stderr}`)); }, CHILD_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (err) => { clearTimeout(timer); reject(err); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}; stderr=${stderr}`));
    });
  });
}

async function race(mode: "ledger" | "prefs", roles: [string, string]): Promise<void> {
  const children = roles.map((role) => start(mode, role));
  let failure: unknown;
  const finished = Promise.all(children.map(waitForExit)).catch((err: unknown) => { failure = err; });
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!roles.every((role) => fs.existsSync(path.join(fx.dir, `.ready-${role}`)))) {
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error("children did not reach the start barrier");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(path.join(fx.dir, ".go"), "go");
  await finished;
  if (failure) throw failure;
}

describe("cross-process read-modify-write (#406 ledger, #408 preferences)", () => {
  it("#406: two daemons appending to the philosophy ledger lose nothing", async () => {
    await race("ledger", ["A", "B"]);

    const ledger = JSON.parse(fs.readFileSync(fx.ledgerPath, "utf8"));
    const shared = ledger.concepts["shared concept"].instances as Array<{ sessionId: string }>;
    // Every distinct instance of the same concept survives; the retry deduped.
    expect(shared).toHaveLength(2 * N);
    expect(new Set(shared.map((i) => i.sessionId)).size).toBe(2 * N);
    // Every distinct concept survives.
    const distinct = Object.keys(ledger.concepts).filter((k) => k !== "shared concept");
    expect(distinct).toHaveLength(2 * N);
    expect(fs.existsSync(`${fx.ledgerPath}.lock`)).toBe(false);
  }, 60_000);

  it("#408: a CLI publish flip racing daemon rejections loses neither", async () => {
    await race("prefs", ["daemon", "cli"]);

    const prefsPath = path.join(fx.dir, ".deeppairing", "preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    expect((prefs.rejectedApproaches as unknown[]).length).toBe(N);
    expect((prefs.approvedPatterns as unknown[]).length).toBe(N);
    // The CLI's last write set publish ON; no daemon write may revert it.
    expect(prefs.globalLedgerPublish).toBe(true);
    // Rejections recorded while publish was on mirrored into the temp-HOME
    // ledger under its own lock (prefs lock is never held across it).
    const mirrored = path.join(fx.dir, ".deeppairing", "philosophy", "v1.json");
    if (fs.existsSync(mirrored)) expect(fs.existsSync(`${mirrored}.lock`)).toBe(false);
    expect(fs.existsSync(`${prefsPath}.lock`)).toBe(false);
  }, 60_000);
});

describe("orphaned lock recovery for the new lock sites (fail closed, never broken by age)", () => {
  it("ledger: an orphaned lock refuses every mutator with ELOCKED and leaves the ledger untouched", () => {
    const store = new GlobalStore(fx.ledgerPath);
    store.recordInstance("kept", { project: "p", sessionId: "s1", verdict: "rejected" });
    const before = fs.readFileSync(fx.ledgerPath, "utf8");
    const lock = `${fx.ledgerPath}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, createdAt: "2020-01-01T00:00:00.000Z" }));
    // Even an ancient lock is NOT broken by age: a paused writer may still commit.
    fs.utimesSync(lock, new Date(0), new Date(0));

    const started = Date.now();
    expect(() => store.recordInstance("lost?", { project: "p", sessionId: "s2", verdict: "rejected" }))
      .toThrow(expect.objectContaining({ code: "ELOCKED" }));
    expect(Date.now() - started).toBeLessThan(5_000); // bounded wait
    expect(() => store.removeConcept("kept")).toThrow(/Philosophy ledger lock busy/);
    expect(() => store.importLedger({ version: 1, concepts: {} })).toThrow(/Philosophy ledger lock busy/);
    expect(fs.readFileSync(fx.ledgerPath, "utf8")).toBe(before);
    expect(fs.existsSync(lock)).toBe(true);
    // Lock-free readers keep working while the writer lock is held.
    expect(store.get("kept")?.instances).toHaveLength(1);

    // Operator recovery: remove the orphan once writers are stopped.
    fs.unlinkSync(lock);
    store.recordInstance("after recovery", { project: "p", sessionId: "s3", verdict: "approved" });
    expect(store.get("after recovery")).not.toBeNull();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("preferences: an orphaned lock fails the mutator loudly; hooks still read lock-free", () => {
    const store = fx.track(new FileStore(fx.dir, "orphan-session"));
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    const prefsPath = path.join(fx.dir, ".deeppairing", "preferences.json");
    const before = fs.readFileSync(prefsPath, "utf8");
    const lock = `${prefsPath}.lock`;
    fs.writeFileSync(lock, "orphaned by a crashed writer");

    expect(() => store.recordRejectedApproach({ description: "Use Mongo" }))
      .toThrow(expect.objectContaining({ code: "ELOCKED" }));
    expect(() => store.setGlobalLedgerPublish(true)).toThrow(/Project preferences lock busy/);
    expect(() => store.recordApprovedPattern({ description: "tests first" })).toThrow(/Project preferences lock busy/);
    expect(() => store.overrideRejectedApproach({ description: "Use Redis" })).toThrow(/Project preferences lock busy/);
    expect(() => store.setAutonomyLevel("balanced")).toThrow(/Project preferences lock busy/);
    expect(() => store.setDetailDensity("rich")).toThrow(/Project preferences lock busy/);
    expect(fs.readFileSync(prefsPath, "utf8")).toBe(before);
    // The preflight hook's read path takes no lock: fail-open and fast.
    expect(readRejectedApproaches(fx.dir).map((r) => r.description)).toEqual(["Use Redis"]);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1);

    fs.unlinkSync(lock);
    store.recordRejectedApproach({ description: "Use Mongo" });
    expect(readRejectedApproaches(fx.dir).map((r) => r.description)).toEqual(["Use Redis", "Use Mongo"]);
  });

  it("a busy ledger lock during a rejection is logged, and the local rejection still lands", () => {
    const store = fx.track(new FileStore(fx.dir, "mirror-session"));
    store.setGlobalLedgerPublish(true);
    const lock = `${fx.ledgerPath}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "held");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    } finally {
      fs.unlinkSync(lock);
    }
    expect(errors.mock.calls.some((call) => String(call[0]).includes("cross-project ledger mirror"))).toBe(true);
    expect(readRejectedApproaches(fx.dir).map((r) => r.description)).toEqual(["Use Redis"]);
  });
});

describe("withFileLock re-entry", () => {
  it("reentrant sites run nested same-process work inline instead of timing out", () => {
    const lock = path.join(fx.dir, "reentrant.lock");
    const result = withFileLock(lock, () => withFileLock(lock, () => 7, { reentrant: true }), { reentrant: true });
    expect(result).toBe(7);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("the session flush lock stays non-reentrant (nested acquisition is contention)", () => {
    const lock = path.join(fx.dir, ".flush.lock");
    expect(() => withSessionFlushLock(lock, () => withSessionFlushLock(lock, () => 1)))
      .toThrow(/Session flush lock busy/);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
