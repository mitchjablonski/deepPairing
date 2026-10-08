/**
 * #486 — a rejection's cross-project ledger mirror survives a busy ledger lock.
 *
 * Before: when the ledger lock was held past its 1 s bound, the mirror failed
 * with ELOCKED and was only logged — the local gate kept the rejection, but
 * the advisory nudge in other projects was lost. Now the refused mirror is
 * queued in `.deeppairing/ledger-mirror-pending.json` and replayed (backoff,
 * next successful mirror, next store start), exactly once, and never after
 * the rejection was retired or the publish opt-in withdrawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileStore } from "../file-store.js";
import { ownLockIdentity } from "../file-lock.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let lock: string;
let pending: string;

beforeEach(() => {
  fx = withGlobalStore("dp-486-");
  lock = `${fx.ledgerPath}.lock`;
  pending = path.join(fx.dir, ".deeppairing", "ledger-mirror-pending.json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  try { fs.unlinkSync(lock); } catch { /* released */ }
  fx.dispose();
});

/** A live writer elsewhere holds the ledger lock (past the 1 s bound). */
function holdLedgerLock(): void {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: new Date().toISOString(), nonce: "holder" }));
}
const releaseLedgerLock = () => fs.unlinkSync(lock);

function instances(concept: string): Array<{ verdict: string; sessionId: string; at: string }> {
  if (!fs.existsSync(fx.ledgerPath)) return [];
  return JSON.parse(fs.readFileSync(fx.ledgerPath, "utf8")).concepts[concept]?.instances ?? [];
}

function publishingStore(sessionId = "s486"): FileStore {
  const store = fx.track(new FileStore(fx.dir, sessionId));
  store.setGlobalLedgerPublish(true);
  return store;
}

describe("#486 — the cross-project mirror survives a busy ledger lock", () => {
  it("a rejection while the ledger lock is held past its bound lands once the lock frees", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis", reason: "no new services" });

    expect(instances("redis")).toEqual([]);                        // refused for now…
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1); // …local gate intact
    expect(JSON.parse(fs.readFileSync(pending, "utf8"))).toHaveLength(1);

    releaseLedgerLock();
    vi.advanceTimersByTime(2_000); // first backoff replay

    expect(instances("redis")).toEqual([expect.objectContaining({ verdict: "rejected", sessionId: "s486" })]);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("keeps retrying on a backoff while the lock stays busy, then lands", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Mongo", concept: "mongo" });
    vi.advanceTimersByTime(2_000);   // still busy: stays queued
    expect(instances("mongo")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(pending, "utf8"))).toHaveLength(1);
    releaseLedgerLock();
    vi.advanceTimersByTime(5_000);   // next backoff
    expect(instances("mongo")).toHaveLength(1);
  });

  it("a queued mirror survives a restart: the next store for the project replays it", () => {
    const first = publishingStore("before-restart");
    holdLedgerLock();
    first.recordRejectedApproach({ description: "Use Kafka", concept: "kafka" });
    first.dispose(); // the daemon goes away before any retry fires
    releaseLedgerLock();
    vi.advanceTimersByTime(120_000);
    expect(instances("kafka")).toEqual([]); // nobody replayed it yet

    fx.track(new FileStore(fx.dir, "after-restart"));
    vi.advanceTimersByTime(0);
    expect(instances("kafka")).toEqual([expect.objectContaining({ sessionId: "before-restart" })]);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("a replay that already landed (crash before dequeue) is not appended twice", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    releaseLedgerLock();
    // Simulate a replayer that wrote the ledger and died before dequeuing.
    const [entry] = JSON.parse(fs.readFileSync(pending, "utf8"));
    const other = fx.track(new FileStore(fx.dir, "other"));
    (other as unknown as { replayLedgerMirrors(): number }).replayLedgerMirrors();
    fs.writeFileSync(pending, JSON.stringify([entry]));       // queue comes back
    store.replayLedgerMirrors();
    other.replayLedgerMirrors();
    expect(instances("redis")).toHaveLength(1);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("a retire before the replay never resurrects the rejection (and leaves nothing to counter)", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    releaseLedgerLock();
    expect(store.overrideRejectedApproach({ description: "Use Redis" }).retired).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(instances("redis")).toEqual([]); // no rejection, and no counter-approval for an unpublished one
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("`philosophy remove` is authoritative: a mirror queued before the removal never resurrects the concept", async () => {
    const { getGlobalStore } = await import("../global-store.js");
    // The concept is already in the ledger (from another project).
    getGlobalStore().recordInstance("redis", { project: "elsewhere", sessionId: "x", verdict: "rejected" });
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" }); // mirror queued
    releaseLedgerLock();
    expect(getGlobalStore().removeConcept("redis")).not.toBeNull();         // the user removes it
    vi.advanceTimersByTime(120_000);                                        // the queued mirror replays
    store.replayLedgerMirrors();
    expect(instances("redis")).toEqual([]);
    expect(fs.existsSync(pending)).toBe(false);
    // A genuinely NEW rejection after the removal still records.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 5));
    store.recordRejectedApproach({ description: "Use Redis again", concept: "redis" });
    expect(instances("redis")).toHaveLength(1);
  });

  it("withdrawn publish consent drops queued mirrors instead of publishing them", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    store.setGlobalLedgerPublish(false);
    releaseLedgerLock();
    vi.advanceTimersByTime(120_000);
    expect(instances("redis")).toEqual([]);
    expect(fs.existsSync(pending)).toBe(false);
  });
});

describe("#486 — concurrent replayers in separate processes", () => {
  it("four processes replaying the same queue append the mirror exactly once", async () => {
    vi.useRealTimers();
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    store.dispose();
    releaseLedgerLock();

    const here = path.dirname(fileURLToPath(import.meta.url));
    const program = String.raw`
      const fs = await import("node:fs"); const path = await import("node:path");
      const { FileStore } = await import(${JSON.stringify(pathToFileURL(path.resolve(here, "../file-store.ts")).href)});
      const [root, role] = process.argv.slice(1);
      // HOME is the fixture dir (VITEST scrubbed), so the default ledger is
      // <fixture>/.deeppairing/philosophy/v1.json — checked below.
      fs.writeFileSync(path.join(root, ".ready-" + role), "");
      const w = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(path.join(root, ".go"))) Atomics.wait(w, 0, 0, 2);
      const s = new FileStore(root, "replayer-" + role);
      s.replayLedgerMirrors();
      s.dispose();
    `;
    const roles = ["a", "b", "c", "d"];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.dir, USERPROFILE: fx.dir };
    delete env.VITEST; delete env.NODE_ENV;
    const kids = roles.map((r) => spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", program, fx.dir, r], { env, stdio: ["ignore", "ignore", "pipe"] }));
    const done = Promise.all(kids.map((k) => new Promise<number | null>((res) => k.once("exit", res))));
    while (!roles.every((r) => fs.existsSync(path.join(fx.dir, `.ready-${r}`)))) await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(path.join(fx.dir, ".go"), "");
    expect(await done).toEqual([0, 0, 0, 0]);
    const childLedger = path.join(fx.dir, ".deeppairing", "philosophy", "v1.json");
    expect(JSON.parse(fs.readFileSync(childLedger, "utf8")).concepts.redis.instances).toHaveLength(1);
    expect(fs.existsSync(pending)).toBe(false);
  }, 60_000);
});
