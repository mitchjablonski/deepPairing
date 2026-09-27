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
 * These are real two-process races, not interleaved async tasks in one
 * process (in-process calls are synchronous and cannot race). The children run
 * the SOURCE under tsx — never a possibly-stale dist — and are released
 * together by a file barrier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileStore } from "../file-store.js";
import { GlobalStore } from "../global-store.js";
import { breakDeadLock, inspectLocks, ownerState, ownLockIdentity, withFileLock } from "../file-lock.js";
import { withSessionFlushLock } from "../session-records.js";
import { readRejectedApproaches } from "../../cli/preflight-hook-core.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

const CHILD_TIMEOUT_MS = 30_000;
// Modest on purpose: large enough that the unlocked implementation loses
// updates on every run we measured, small enough to stay fast on CI.
const N = 40;
const here = path.dirname(fileURLToPath(import.meta.url));
const srcUrl = (rel: string) => JSON.stringify(pathToFileURL(path.resolve(here, "..", rel)).href);
const TSX = import.meta.resolve("tsx");

let fx: GlobalStoreFixture;

beforeEach(() => {
  fx = withGlobalStore("dp-cross-process-rmw-");
});

afterEach(() => {
  vi.restoreAllMocks();
  fx.dispose();
});

const IDENTITY = ownLockIdentity()!;

/** A lock body naming a LIVE owner in this OS instance that is not this process. */
function liveOwnerBody(): string {
  return JSON.stringify({ ...IDENTITY, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "live" });
}

/** A lock body naming an owner that has provably exited (a crashed writer). */
function deadOwnerBody(extra: Record<string, unknown> = {}): string {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return JSON.stringify({ ...IDENTITY, pid, processStartTime: null, createdAt: "2020-01-01T00:00:00.000Z", nonce: `dead-${pid}`, ...extra });
}

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
  const { GlobalStore } = await import(${srcUrl("global-store.ts")});
  const { FileStore } = await import(${srcUrl("file-store.ts")});
  const { withFileLock } = await import(${srcUrl("file-lock.ts")});
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
  } else if (mode === "counter") {
    // Dead-owner recovery race: every child starts against the SAME orphaned
    // lock; exactly one breaker may win each time, so no increment is lost.
    const file = path.join(root, "counter.json");
    for (let i = 0; i < n; i++) {
      withFileLock(file + ".lock", () => {
        const v = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).v : 0;
        const tmp = file + "." + process.pid + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ v: v + 1 }));
        fs.renameSync(tmp, file);
      }, { timeoutMs: 10000 });
    }
  } else if (mode === "stress") {
    // H4 — every round starts with ALL children racing to break the same
    // orphaned lock. Inside the critical section, an O_EXCL "inside" marker
    // detects any second holder.
    const rounds = n;
    const inside = path.join(root, "inside");
    let overlaps = 0;
    for (let r = 0; r < rounds; r++) {
      while (!fs.existsSync(path.join(root, ".round-" + r))) {
        if (Date.now() >= deadline) process.exit(6);
        Atomics.wait(waiter, 0, 0, 1);
      }
      withFileLock(path.join(root, "stress.lock"), () => {
        try { fs.closeSync(fs.openSync(inside, "wx")); } catch { overlaps++; }
        const file = path.join(root, "counter.json");
        const v = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).v : 0;
        Atomics.wait(waiter, 0, 0, 2); // hold long enough for late breakers to act
        const tmp = file + "." + process.pid + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ v: v + 1 }));
        fs.renameSync(tmp, file);
        try { fs.unlinkSync(inside); } catch { overlaps++; }
      }, { timeoutMs: 20000 });
      fs.writeFileSync(path.join(root, ".done-" + role + "-" + r), "");
    }
    fs.writeFileSync(path.join(root, ".overlaps-" + role), String(overlaps));
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

function start(mode: string, role: string, n = N): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    "--import", TSX, "--input-type=module", "--eval", childProgram,
    fx.dir, fx.ledgerPath, mode, role, String(n),
  ], { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
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

async function race(mode: string, roles: string[], n = N): Promise<void> {
  const children = roles.map((role) => start(mode, role, n));
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
  }, 90_000);

  it("#408: a CLI publish flip racing daemon rejections loses neither", async () => {
    await race("prefs", ["daemon", "cli"]);

    const prefsPath = path.join(fx.dir, ".deeppairing", "preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    expect((prefs.rejectedApproaches as unknown[]).length).toBe(N);
    expect((prefs.approvedPatterns as unknown[]).length).toBe(N);
    // The CLI's last write set publish ON; no daemon write may revert it.
    expect(prefs.globalLedgerPublish).toBe(true);
    expect(fs.existsSync(`${prefsPath}.lock`)).toBe(false);
  }, 90_000);

  it("dead-owner recovery: concurrent breakers of one orphaned lock never both win", async () => {
    const lock = path.join(fx.dir, "counter.json.lock");
    fs.writeFileSync(lock, deadOwnerBody());
    await race("counter", ["c1", "c2", "c3"], 25);
    expect(JSON.parse(fs.readFileSync(path.join(fx.dir, "counter.json"), "utf8")).v).toBe(75);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(fx.dir).filter((f) => f.includes(".lock.dead-"))).toEqual([]);
  }, 90_000);
});

describe("H4: breaker serialization under stress", () => {
  it("8 processes racing to break a fresh orphaned lock every round never overlap", async () => {
    const PROCS = 8;
    const ROUNDS = 12;
    const lock = path.join(fx.dir, "stress.lock");
    const roles = Array.from({ length: PROCS }, (_, i) => `s${i}`);
    const children = roles.map((role) => start("stress", role, ROUNDS));
    let failure: unknown;
    const finished = Promise.all(children.map(waitForExit)).catch((err: unknown) => { failure = err; });
    const waitFor = async (files: string[]) => {
      const deadline = Date.now() + CHILD_TIMEOUT_MS;
      while (!files.every((f) => fs.existsSync(path.join(fx.dir, f)))) {
        if (failure) throw failure;
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${files[0]}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    await waitFor(roles.map((r) => `.ready-${r}`));
    fs.writeFileSync(path.join(fx.dir, ".go"), "go");
    for (let r = 0; r < ROUNDS; r++) {
      fs.writeFileSync(lock, deadOwnerBody()); // a writer "crashed" holding it
      fs.writeFileSync(path.join(fx.dir, `.round-${r}`), "");
      await waitFor(roles.map((role) => `.done-${role}-${r}`));
    }
    await finished;
    if (failure) throw failure;

    const overlaps = roles.map((role) => Number(fs.readFileSync(path.join(fx.dir, `.overlaps-${role}`), "utf8")));
    expect(overlaps).toEqual(roles.map(() => 0));
    expect(JSON.parse(fs.readFileSync(path.join(fx.dir, "counter.json"), "utf8")).v).toBe(PROCS * ROUNDS);
    expect(fs.readdirSync(fx.dir).filter((f) => f.startsWith("stress.lock"))).toEqual([]);
  }, 120_000);
});

describe("lock owner classification", () => {
  it("only a provably dead same-host owner is breakable", () => {
    expect(ownerState(deadOwnerBody()).state).toBe("dead");
    expect(ownerState(liveOwnerBody()).state).toBe("alive");
    // This process itself is alive (a nested non-reentrant acquisition).
    expect(ownerState(JSON.stringify({ ...IDENTITY, createdAt: "", nonce: "" })).state).toBe("alive");
    // Foreign host, unreadable and legacy bodies stay fail-closed.
    const dead = JSON.parse(deadOwnerBody());
    expect(ownerState(JSON.stringify({ ...dead, hostname: "some-other-host" })).state).toBe("unknown");
    expect(ownerState(JSON.stringify({ pid: dead.pid, hostname: os.hostname() })).state).toBe("unknown"); // pre-identity body
    expect(ownerState("").state).toBe("unknown");
    expect(ownerState("held").state).toBe("unknown");
    expect(ownerState(JSON.stringify({ pid: dead.pid, createdAt: "x" })).state).toBe("unknown");
  });

  it.runIf(process.platform === "linux")("a live pid with a different start time is a reused pid (dead owner)", () => {
    const body = JSON.stringify({ ...IDENTITY, pid: process.ppid, processStartTime: "1", createdAt: "", nonce: "" });
    expect(ownerState(body).state).toBe("dead");
  });

  it("release never deletes a lock replaced while held; lost ownership is a logged warning, not an error", () => {
    const lock = path.join(fx.dir, "stolen.lock");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(withFileLock(lock, () => { fs.writeFileSync(lock, "someone else"); return "applied"; })).toBe("applied");
    expect(fs.readFileSync(lock, "utf8")).toBe("someone else");
    expect(warn.mock.calls.some((call) => /replaced while this process held it/.test(String(call[0])))).toBe(true);
  });

  it("H3: a dead pid under a foreign OS instance (same hostname) is NEVER broken", () => {
    // WSL2 and Windows share a hostname but not a pid space; a container shares
    // a boot but not a pid namespace. Any identity mismatch is unverifiable.
    const lock = path.join(fx.dir, "foreign.lock");
    for (const foreign of [
      { platform: IDENTITY.platform === "win32" ? "linux" : "win32" },
      { bootId: "00000000-0000-0000-0000-000000000000" },
      { pidNamespace: "pid:[1]" },
      { bootId: undefined },
      { pidNamespace: undefined },
    ]) {
      const body = deadOwnerBody(foreign);
      expect(JSON.parse(body).hostname).toBe(os.hostname());
      expect(ownerState(body).state).toBe("unknown");
      fs.writeFileSync(lock, body);
      expect(breakDeadLock(lock).broken).toBe(false);
      expect(fs.readFileSync(lock, "utf8")).toBe(body);
    }
    // Control: the SAME dead pid with a full identity match is recoverable.
    fs.writeFileSync(lock, deadOwnerBody());
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(breakDeadLock(lock).broken).toBe(true);
  });

  it("L2: our own pid with a different start time is a previous incarnation (dead), with the same start time alive", () => {
    if (!IDENTITY.processStartTime) return; // start times exist only on Linux
    const mine = { ...IDENTITY, createdAt: "", nonce: "" };
    expect(ownerState(JSON.stringify(mine)).state).toBe("alive");
    expect(ownerState(JSON.stringify({ ...mine, processStartTime: "1" })).state).toBe("dead");
  });

  it("a .break stranded by a crashed breaker is recovered; a stranded .recover fails closed (doctor reports it)", () => {
    const lock = path.join(fx.dir, "guarded.lock");
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(lock, deadOwnerBody());
    fs.writeFileSync(`${lock}.break`, deadOwnerBody());
    expect(withFileLock(lock, () => "entered", { timeoutMs: 2000 })).toBe("entered");
    expect(fs.readdirSync(fx.dir).filter((f) => f.startsWith("guarded.lock"))).toEqual([]);

    fs.writeFileSync(lock, deadOwnerBody());
    fs.writeFileSync(`${lock}.break`, deadOwnerBody());
    fs.writeFileSync(`${lock}.break.recover`, deadOwnerBody());
    expect(() => withFileLock(lock, () => "entered", { timeoutMs: 100 })).toThrow(expect.objectContaining({ code: "ELOCKED" }));
    const kinds = inspectLocks([fx.dir]).filter((r) => path.basename(r.path).startsWith("guarded")).map((r) => `${r.kind}:${r.state}`).sort();
    expect(kinds).toEqual(["break:dead", "lock:dead", "recover:dead"]);
  });

  it("a triple-dead chain (lock + .break + .break.recover) is cleared by `doctor --fix`, and the next write succeeds", () => {
    const project = path.join(fx.dir, "proj");
    const dp = path.join(project, ".deeppairing");
    fs.mkdirSync(dp, { recursive: true });
    const lock = path.join(dp, "preferences.json.lock");
    fs.writeFileSync(lock, deadOwnerBody());
    fs.writeFileSync(`${lock}.break`, deadOwnerBody());
    fs.writeFileSync(`${lock}.break.recover`, deadOwnerBody());
    // A LIVE owner's guard elsewhere must survive the same --fix.
    const liveLock = path.join(dp, "other.lock");
    const liveBody = liveOwnerBody();
    fs.writeFileSync(liveLock, liveBody);
    expect(() => withFileLock(lock, () => "entered", { timeoutMs: 100 })).toThrow(expect.objectContaining({ code: "ELOCKED" }));

    const out = spawnSync(process.execPath, ["--import", TSX, path.resolve(here, "../../cli/init.ts"), "doctor", "--fix", "--yes"], {
      cwd: project, encoding: "utf8", timeout: 60_000,
      env: { ...childEnv(), CLAUDE_PROJECT_DIR: project },
    });
    expect(out.status, out.stderr).toBe(0);
    expect(fs.readdirSync(dp).filter((f) => f.startsWith("preferences.json.lock"))).toEqual([]);
    expect(fs.readFileSync(liveLock, "utf8")).toBe(liveBody);
    expect(withFileLock(lock, () => "entered", { timeoutMs: 100 })).toBe("entered");
  }, 90_000);

  it("inspectLocks reports owner and liveness; breakDeadLock removes only dead owners", () => {
    const dp = path.join(fx.dir, ".deeppairing");
    fs.mkdirSync(path.join(dp, "sessions", "s"), { recursive: true });
    fs.writeFileSync(path.join(dp, "preferences.json.lock"), deadOwnerBody());
    fs.writeFileSync(path.join(dp, "sessions", "s", ".flush.lock"), liveOwnerBody());
    fs.writeFileSync(path.join(dp, "sessions", "s", ".review-post.lock"), "3f0c-token");
    const byName = Object.fromEntries(inspectLocks([dp]).map((r) => [path.basename(r.path), r]));
    expect(byName["preferences.json.lock"]!.state).toBe("dead");
    expect(byName[".flush.lock"]!.state).toBe("alive");
    expect(byName[".review-post.lock"]!.state).toBe("unknown");
    for (const r of Object.values(byName)) breakDeadLock(r.path);
    expect(fs.existsSync(path.join(dp, "preferences.json.lock"))).toBe(false);
    expect(fs.existsSync(path.join(dp, "sessions", "s", ".flush.lock"))).toBe(true);
    expect(fs.existsSync(path.join(dp, "sessions", "s", ".review-post.lock"))).toBe(true);
  });
});

describe("stale locks at the new lock sites", () => {
  it("ledger: a crashed writer's lock is recovered by every mutator; a live owner fails closed", () => {
    const store = new GlobalStore(fx.ledgerPath);
    const lock = `${fx.ledgerPath}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    fs.writeFileSync(lock, deadOwnerBody());
    store.recordInstance("kept", { project: "p", sessionId: "s1", verdict: "rejected" });
    fs.writeFileSync(lock, deadOwnerBody());
    store.importLedger({ version: 1, concepts: { gone: { key: "gone", concept: "gone", instances: [{ project: "p", sessionId: "s", verdict: "rejected", at: "2026-01-01T00:00:00.000Z" }], firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" } } });
    fs.writeFileSync(lock, deadOwnerBody());
    expect(store.removeConcept("gone")).not.toBeNull();
    expect(store.get("kept")?.instances).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);

    // Live owner: bounded wait, ELOCKED naming the lock, ledger untouched.
    const before = fs.readFileSync(fx.ledgerPath, "utf8");
    fs.writeFileSync(lock, liveOwnerBody());
    fs.utimesSync(lock, new Date(0), new Date(0)); // ancient: age is never proof
    const started = Date.now();
    expect(() => store.recordInstance("lost?", { project: "p", sessionId: "s2", verdict: "rejected" }))
      .toThrow(expect.objectContaining({ code: "ELOCKED", path: lock }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.readFileSync(fx.ledgerPath, "utf8")).toBe(before);
    expect(store.get("kept")?.instances).toHaveLength(1); // lock-free readers work
    fs.unlinkSync(lock);
  });

  it("preferences: a crashed writer's lock is recovered by every mutator; a live owner fails closed while hooks still read", () => {
    const store = fx.track(new FileStore(fx.dir, "orphan-session"));
    const prefsPath = path.join(fx.dir, ".deeppairing", "preferences.json");
    const lock = `${prefsPath}.lock`;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mutators: Array<() => unknown> = [
      () => store.recordRejectedApproach({ description: "Use Redis", concept: "redis" }),
      () => store.recordApprovedPattern({ description: "tests first" }),
      () => store.setGlobalLedgerPublish(false),
      () => store.setAutonomyLevel("balanced"),
      () => store.setDetailDensity("rich"),
      () => store.recordRejectedApproach({ description: "Use Mongo" }),
      () => store.overrideRejectedApproach({ description: "Use Mongo" }),
    ];
    for (const mutate of mutators) {
      fs.writeFileSync(lock, deadOwnerBody());
      mutate();
      expect(fs.existsSync(lock)).toBe(false);
    }
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
    expect(prefs).toMatchObject({ approvedPatterns: ["tests first"], globalLedgerPublish: false, autonomyLevel: "balanced", detailDensity: "rich" });
    expect(readRejectedApproaches(fx.dir).map((r) => r.description)).toEqual(["Use Redis"]);

    const before = fs.readFileSync(prefsPath, "utf8");
    fs.writeFileSync(lock, liveOwnerBody());
    expect(() => store.recordRejectedApproach({ description: "Use Mongo" }))
      .toThrow(expect.objectContaining({ code: "ELOCKED", path: lock }));
    expect(fs.readFileSync(prefsPath, "utf8")).toBe(before);
    // The preflight hook's read path takes no lock: fail-open and fast.
    expect(readRejectedApproaches(fx.dir).map((r) => r.description)).toEqual(["Use Redis"]);
    fs.unlinkSync(lock);
  });

  it("a busy ledger lock during a rejection is logged, and the local rejection still lands", () => {
    const store = fx.track(new FileStore(fx.dir, "mirror-session"));
    store.setGlobalLedgerPublish(true);
    const lock = `${fx.ledgerPath}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, liveOwnerBody());
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
