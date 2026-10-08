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

describe("#488 review — clock, corruption, retire races, queue bounds", () => {
  const logged = (needle: RegExp) =>
    (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => needle.test(String(c[0])));

  it("a backward clock step after a remove never drops a NEW rejection (removal order is a sequence, not a time)", async () => {
    const { getGlobalStore } = await import("../global-store.js");
    getGlobalStore().recordInstance("redis", { project: "elsewhere", sessionId: "x", verdict: "rejected" });
    const store = publishingStore();
    expect(getGlobalStore().removeConcept("redis")).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.now() - 30_000); // NTP step / WSL resume
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    expect(instances("redis")).toHaveLength(1);
  });

  it("a replay skipped because of a removal is logged", async () => {
    const { getGlobalStore } = await import("../global-store.js");
    getGlobalStore().recordInstance("redis", { project: "elsewhere", sessionId: "x", verdict: "rejected" });
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    releaseLedgerLock();
    getGlobalStore().removeConcept("redis");
    store.replayLedgerMirrors();
    expect(instances("redis")).toEqual([]);
    expect(logged(/skipped a queued cross-project mirror for "redis"/)).toBe(true);
  });

  it("a corrupt removal record is backed up and salvaged, never silently overwritten", async () => {
    const { getGlobalStore } = await import("../global-store.js");
    const sidecar = `${fx.ledgerPath}.removed.json`;
    getGlobalStore().recordInstance("kafka", { project: "p", sessionId: "s", verdict: "rejected" });
    fs.writeFileSync(sidecar, '{"seq": 2, "removals": {"redis": 1, "mongo": 2'); // truncated write
    expect(getGlobalStore().removeConcept("kafka")).not.toBeNull();
    const backups = fs.readdirSync(path.dirname(sidecar)).filter((f) => f.startsWith(path.basename(sidecar) + ".corrupt-"));
    expect(backups).toHaveLength(1);
    expect(logged(/removal record .* is corrupt/)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecar, "utf8"))).toEqual({ seq: 3, removals: { redis: 1, mongo: 2, kafka: 3 } });
  });

  it("a corrupt removal record is backed up once per corruption, not once per mirror", () => {
    const sidecar = `${fx.ledgerPath}.removed.json`;
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, '{"seq": 2, "removals": {"redis": 1');
    const store = publishingStore();
    for (let i = 0; i < 6; i++) store.recordRejectedApproach({ description: `Use thing ${i}`, concept: `thing ${i}` });
    const backups = fs.readdirSync(path.dirname(sidecar)).filter((f) => f.startsWith(path.basename(sidecar) + ".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  it("salvage never moves the removal sequence backwards", async () => {
    const { getGlobalStore } = await import("../global-store.js");
    const sidecar = `${fx.ledgerPath}.removed.json`;
    getGlobalStore().recordInstance("kafka", { project: "p", sessionId: "s", verdict: "rejected" });
    // The counter (9) is ahead of every surviving per-concept entry (2, 3).
    fs.writeFileSync(sidecar, '{"seq": 9, "removals": {"redis": 2, "mongo": 3');
    expect(getGlobalStore().removeConcept("kafka")).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(sidecar, "utf8"))).toEqual({ seq: 10, removals: { redis: 2, mongo: 3, kafka: 10 } });
  });

  it("a retire that can't check the queue (lock busy) publishes no stray counter-approval", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" }); // queued, never published
    releaseLedgerLock();
    const queueLock = `${pending}.lock`;
    fs.writeFileSync(queueLock, JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: "", nonce: "q" }));
    try {
      expect(store.overrideRejectedApproach({ description: "Use Redis", concept: "redis" }).retired).toBe(1);
    } finally {
      fs.unlinkSync(queueLock);
    }
    const all = () => fs.existsSync(fx.ledgerPath) ? Object.keys(JSON.parse(fs.readFileSync(fx.ledgerPath, "utf8")).concepts) : [];
    expect(all()).toEqual([]); // no "Retired by you" counter for an unpublished rejection
    vi.advanceTimersByTime(120_000);
    expect(all()).toEqual([]); // and the queued rejection doesn't resurrect either
  });

  it("the queue is capped by size and age, and malformed entries are backed up, not silently dropped", () => {
    const store = publishingStore();
    const now = new Date().toISOString();
    const entry = (i: number, at = now) => ({ kind: "override", concept: `c${i}`, instance: { project: "p", sessionId: "s", verdict: "approved", at }, removalSeq: 0 });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify([entry(-1, old), { foo: 1 }, ...Array.from({ length: 205 }, (_, i) => entry(i))]));
    holdLedgerLock(); // replay stays blocked: everything that survives the bounds stays queued
    expect(store.replayLedgerMirrors()).toBe(200);
    const left = JSON.parse(fs.readFileSync(pending, "utf8")) as Array<{ concept: string }>;
    expect(left).toHaveLength(200);
    expect(left[0]!.concept).toBe("c5"); // the oldest five beyond the cap were cut
    expect(left.some((e) => e.concept === "c-1")).toBe(false); // >30 days
    expect(fs.readdirSync(path.dirname(pending)).some((f) => f.startsWith("ledger-mirror-pending.json.corrupt-"))).toBe(true);
    expect(logged(/malformed queued ledger mirror/)).toBe(true);
    expect(logged(/older than 30 days/)).toBe(true);
    expect(logged(/capped at 200/)).toBe(true);
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

describe("#488 Sol review — landed-but-queued retire, durable removal, refused writes, cross-process consent", () => {
  const verdicts = (concept: string) => instances(concept).map((i) => i.verdict);

  it("retire after the mirror LANDED but before it was dequeued still publishes the counter-approval", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    releaseLedgerLock();
    const saved = fs.readFileSync(pending, "utf8");
    expect(store.replayLedgerMirrors()).toBe(0);      // lands…
    fs.writeFileSync(pending, saved);                 // …but a crash left it queued
    expect(verdicts("redis")).toEqual(["rejected"]);
    expect(store.overrideRejectedApproach({ description: "Use Redis", concept: "redis" }).retired).toBe(1);
    expect(verdicts("redis")).toEqual(["rejected", "approved"]);
    vi.advanceTimersByTime(120_000);
    store.replayLedgerMirrors();
    expect(verdicts("redis")).toEqual(["rejected", "approved"]); // no re-landed rejection
  });

  it("a removal whose tombstone can't be persisted FAILS and leaves the ledger untouched", async () => {
    const { getGlobalStore } = await import("../global-store.js");
    getGlobalStore().recordInstance("redis", { project: "elsewhere", sessionId: "x", verdict: "rejected" });
    const before = fs.readFileSync(fx.ledgerPath, "utf8");
    const sidecar = `${fx.ledgerPath}.removed.json`;
    fs.mkdirSync(sidecar); // EISDIR on read/rename
    try {
      expect(() => getGlobalStore().removeConcept("redis")).toThrow();
      expect(fs.readFileSync(fx.ledgerPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(sidecar, { recursive: true });
    }
  });

  it("an interruption between the tombstone and the deletion can't resurrect, and a retry completes the removal", async () => {
    const { getGlobalStore, GlobalStore } = await import("../global-store.js");
    getGlobalStore().recordInstance("redis", { project: "elsewhere", sessionId: "x", verdict: "rejected" });
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" }); // queued before the removal
    releaseLedgerLock();
    const write = vi.spyOn(GlobalStore.prototype as unknown as { write: () => boolean }, "write").mockReturnValueOnce(false);
    expect(() => getGlobalStore().removeConcept("redis")).toThrow(/nothing was removed/);
    write.mockRestore();
    expect(JSON.parse(fs.readFileSync(`${fx.ledgerPath}.removed.json`, "utf8")).removals.redis).toBeGreaterThan(0);
    expect(store.replayLedgerMirrors()).toBe(0);
    expect(instances("redis").map((i) => i.sessionId)).toEqual(["x"]); // the queued mirror did not land
    expect(getGlobalStore().removeConcept("redis")).not.toBeNull();     // retry completes it
    expect(instances("redis")).toEqual([]);
  });

  it("a write the ledger REFUSES (corrupt ledger) stays queued instead of being acknowledged", () => {
    const store = publishingStore();
    holdLedgerLock();
    store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
    releaseLedgerLock();
    fs.writeFileSync(fx.ledgerPath, "{");
    expect(store.replayLedgerMirrors()).toBe(1);
    expect(JSON.parse(fs.readFileSync(pending, "utf8"))).toHaveLength(1);
    expect(fs.readFileSync(fx.ledgerPath, "utf8")).toBe("{"); // untouched (H1-5)
    fs.unlinkSync(fx.ledgerPath); // the user repairs it
    expect(store.replayLedgerMirrors()).toBe(0);
    expect(verdicts("redis")).toEqual(["rejected"]);
  });

  for (const action of ["withdraw consent", "retire the rejection"] as const) {
    it(`cross-process: a replayer WAITING on the ledger lock cannot publish after the parent completes "${action}"`, async () => {
      vi.useRealTimers();
      const store = publishingStore();
      holdLedgerLock();
      store.recordRejectedApproach({ description: "Use Redis", concept: "redis" });
      releaseLedgerLock();

      // The child's ledger is the default under HOME=fixture (VITEST scrubbed).
      const childLedger = path.join(fx.dir, ".deeppairing", "philosophy", "v1.json");
      fs.mkdirSync(path.dirname(childLedger), { recursive: true });
      const childLock = `${childLedger}.lock`;
      fs.writeFileSync(childLock, JSON.stringify({ ...ownLockIdentity()!, pid: process.ppid, processStartTime: null, createdAt: "", nonce: "hold" }));
      const here = path.dirname(fileURLToPath(import.meta.url));
      const program = String.raw`
        const { FileStore } = await import(${JSON.stringify(pathToFileURL(path.resolve(here, "../file-store.ts")).href)});
        const s = new FileStore(process.argv[1], "replayer");
        // Keep replaying: on a loaded host one wait may outlast the 1 s bound
        // (ELOCKED keeps the entry); the next pass then waits again.
        const deadline = Date.now() + 20000;
        let remaining = s.replayLedgerMirrors();
        while (remaining > 0 && Date.now() < deadline) remaining = s.replayLedgerMirrors();
        s.dispose();
        process.stdout.write(String(remaining));
      `;
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.dir, USERPROFILE: fx.dir };
      delete env.VITEST; delete env.NODE_ENV;
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", program, fx.dir], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout!.on("data", (d) => { out += d; });
      const exited = new Promise<number | null>((r) => child.once("exit", r));
      try {
        // The child holds the queue lock and is now blocked on the ledger lock.
        const queueLock = `${pending}.lock`;
        const deadline = Date.now() + 30_000;
        while (!fs.existsSync(queueLock)) {
          if (Date.now() > deadline) throw new Error("child never reached the queue");
          await new Promise((r) => setTimeout(r, 5));
        }
        await new Promise((r) => setTimeout(r, 100));
        const prefsPath = path.join(fx.dir, ".deeppairing", "preferences.json");
        if (action === "withdraw consent") {
          store.setGlobalLedgerPublish(false);
          expect(JSON.parse(fs.readFileSync(prefsPath, "utf8")).globalLedgerPublish).toBe(false);
        } else {
          // Retired by another writer while the replay waits (the queue lock is
          // the child's, so retire the row directly, as a CLI/sibling would).
          (store as unknown as { mutatePreferences(fn: (p: Record<string, unknown>) => boolean): void }).mutatePreferences((p) => {
            p.rejectedApproaches = []; return true;
          });
          expect(JSON.parse(fs.readFileSync(prefsPath, "utf8")).rejectedApproaches).toEqual([]);
        }
      } finally {
        fs.unlinkSync(childLock); // only now may the waiting replay proceed
      }
      expect(await exited).toBe(0);
      expect(out).toBe("0"); // dequeued as an intentional no-op…
      const concepts = fs.existsSync(childLedger) ? Object.keys(JSON.parse(fs.readFileSync(childLedger, "utf8")).concepts) : [];
      expect(concepts).toEqual([]); // …and nothing was published
    }, 60_000);
  }
});
