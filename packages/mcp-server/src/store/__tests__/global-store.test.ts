import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalStore, deriveStance } from "../global-store.js";

let tmpDir: string;
let ledgerPath: string;
let store: GlobalStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-global-"));
  ledgerPath = path.join(tmpDir, "philosophy.json");
  store = new GlobalStore(ledgerPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GlobalStore — append-only instance log", () => {
  it("creates the file on first write", () => {
    expect(fs.existsSync(ledgerPath)).toBe(false);
    store.recordInstance("serverless hosting", {
      project: "repo-a",
      sessionId: "s1",
      verdict: "rejected",
      reason: "cold starts",
    });
    expect(fs.existsSync(ledgerPath)).toBe(true);
  });

  it("appends instances across calls for the same concept", () => {
    store.recordInstance("caching layer", { project: "repo-a", sessionId: "s1", verdict: "rejected", reason: "over-engineering" });
    store.recordInstance("caching layer", { project: "repo-b", sessionId: "s2", verdict: "rejected", reason: "we have a CDN" });

    const entry = store.get("caching layer");
    expect(entry?.instances).toHaveLength(2);
    expect(entry?.instances.map((i) => i.project)).toEqual(["repo-a", "repo-b"]);
  });

  it("normalizes the concept key (case-insensitive, whitespace-collapsed)", () => {
    store.recordInstance("Serverless  Hosting", { project: "r", sessionId: "s", verdict: "rejected" });
    expect(store.get("serverless hosting")).toBeTruthy();
    expect(store.get("SERVERLESS hosting")).toBeTruthy();
  });

  it("tracks firstSeenAt and updates lastSeenAt", () => {
    store.recordInstance("x", { project: "r", sessionId: "s1", verdict: "approved", at: "2026-04-01T00:00:00.000Z" });
    store.recordInstance("x", { project: "r", sessionId: "s2", verdict: "approved", at: "2026-04-17T00:00:00.000Z" });
    const entry = store.get("x")!;
    expect(entry.firstSeenAt).toBe("2026-04-01T00:00:00.000Z");
    expect(entry.lastSeenAt).toBe("2026-04-17T00:00:00.000Z");
  });

  it("ignores empty concepts", () => {
    store.recordInstance("", { project: "r", sessionId: "s", verdict: "rejected" });
    store.recordInstance("   ", { project: "r", sessionId: "s", verdict: "rejected" });
    expect(store.size()).toBe(0);
  });

  // II6 — DaemonClient auto-recover-on-404 replays the original POST.
  // For recordRejectedApproach, the session FileStore deduplicates by
  // description (the session-scoped path is safe) but the global ledger
  // had no gate, so the retry appended a second instance with a different
  // timestamp. Over a flaky network this compounded into N copies the
  // agent then cited N times in preflight. The dedupe window scopes to
  // (project, sessionId, verdict) so genuine cross-session rejections of
  // the same concept still land.
  it("II6 — collapses identical (project, sessionId, verdict) instances within 5s", () => {
    store.recordInstance("rate limiter", {
      project: "repo-a",
      sessionId: "s1",
      verdict: "rejected",
      reason: "first call",
      at: "2026-05-16T10:00:00.000Z",
    });
    // Retry 2s later — same shape, different reason text (the wrapper
    // doesn't reconstruct identical reasons). Dedupe keys on identity
    // tuple, not on reason.
    store.recordInstance("rate limiter", {
      project: "repo-a",
      sessionId: "s1",
      verdict: "rejected",
      reason: "retry",
      at: "2026-05-16T10:00:02.000Z",
    });
    const entry = store.get("rate limiter");
    expect(entry?.instances).toHaveLength(1);
    expect(entry?.instances[0].reason).toBe("first call");
  });

  it("II6 — does NOT dedupe across sessions (genuine cross-session signal)", () => {
    // Same concept, same project, DIFFERENT session — this is the user
    // rejecting the same idea twice across two different work sessions.
    // That's signal worth keeping (stance derivation depends on the count).
    store.recordInstance("eventual consistency", { project: "repo-a", sessionId: "s1", verdict: "rejected", at: "2026-05-16T10:00:00.000Z" });
    store.recordInstance("eventual consistency", { project: "repo-a", sessionId: "s2", verdict: "rejected", at: "2026-05-16T10:00:02.000Z" });
    expect(store.get("eventual consistency")?.instances).toHaveLength(2);
  });

  it("II6 — does NOT dedupe outside the 5s window (genuine repeat)", () => {
    store.recordInstance("global state", { project: "repo-a", sessionId: "s1", verdict: "rejected", at: "2026-05-16T10:00:00.000Z" });
    // 10s later — same session, but enough time has passed that we treat
    // it as a genuine second rejection.
    store.recordInstance("global state", { project: "repo-a", sessionId: "s1", verdict: "rejected", at: "2026-05-16T10:00:10.000Z" });
    expect(store.get("global state")?.instances).toHaveLength(2);
  });
});

// III8 — per-project opt-in to PUBLISH to the global ledger. Pre-III8
// every project's recordRejectedApproach mirrored into the global ledger
// unconditionally, which meant any project the user opened could seed
// avoid-stances ("validate untrusted input", "use parameterized queries")
// that every other project would then cite. Single-write poisoning by a
// malicious dependency. With opt-in publish, the malicious dep can only
// poison its own project's local preferences.json — the global ledger
// stays clean.
describe("III8 — per-project ledger publish opt-in (gate at FileStore boundary)", () => {
  let fileStoreTmp: string;
  let fileStore: import("../file-store.js").FileStore;
  let globalLedgerPath: string;

  beforeEach(async () => {
    fileStoreTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-iii8-"));
    globalLedgerPath = path.join(fileStoreTmp, "philosophy.json");
    const { setGlobalStoreForTests } = await import("../global-store.js");
    setGlobalStoreForTests(globalLedgerPath);
    const { FileStore } = await import("../file-store.js");
    fileStore = new FileStore(fileStoreTmp, "iii8_session");
  });

  afterEach(async () => {
    const { setGlobalStoreForTests } = await import("../global-store.js");
    setGlobalStoreForTests(null);
    fileStore.forceFlush();
    fs.rmSync(fileStoreTmp, { recursive: true, force: true });
  });

  it("default is off — recordRejectedApproach does NOT mirror to the global ledger", () => {
    fileStore.recordRejectedApproach({ description: "global state", concept: "global mutable state for config" });
    // Local rejection is recorded — preflight for THIS project still fires.
    const mem = fileStore.getSessionMemory();
    expect(mem.rejectedApproaches.some((r) => r.description === "global state")).toBe(true);
    // Global ledger stays clean — the malicious-dependency-in-some-project
    // attack class can't poison the cross-project surface.
    const ledger = JSON.parse(fs.existsSync(globalLedgerPath) ? fs.readFileSync(globalLedgerPath, "utf-8") : '{"concepts":{}}');
    expect(Object.keys(ledger.concepts ?? {})).toHaveLength(0);
  });

  it("after setGlobalLedgerPublish(true), subsequent rejections DO mirror to the global ledger", () => {
    fileStore.setGlobalLedgerPublish(true);
    fileStore.recordRejectedApproach({ description: "pay-per-request hosting", concept: "platform-as-a-service for compute" });
    const ledger = JSON.parse(fs.readFileSync(globalLedgerPath, "utf-8"));
    const entry = ledger.concepts["platform-as-a-service for compute"];
    expect(entry).toBeTruthy();
    expect(entry.instances).toHaveLength(1);
    expect(entry.instances[0].verdict).toBe("rejected");
  });

  it("setGlobalLedgerPublish(false) re-locks subsequent writes (toggle round-trip)", () => {
    fileStore.setGlobalLedgerPublish(true);
    fileStore.recordRejectedApproach({ description: "first", concept: "first-concept" });
    fileStore.setGlobalLedgerPublish(false);
    fileStore.recordRejectedApproach({ description: "second", concept: "second-concept" });
    const ledger = JSON.parse(fs.readFileSync(globalLedgerPath, "utf-8"));
    expect(ledger.concepts["first-concept"]).toBeTruthy();
    expect(ledger.concepts["second-concept"]).toBeUndefined();
  });

  it("recordApprovedPattern honors the same gate (symmetric with rejected)", () => {
    fileStore.recordApprovedPattern({ description: "DI for testability", concept: "request-scoped dependency injection" });
    const beforeOptIn = JSON.parse(fs.existsSync(globalLedgerPath) ? fs.readFileSync(globalLedgerPath, "utf-8") : '{"concepts":{}}');
    expect(beforeOptIn.concepts["request-scoped dependency injection"]).toBeUndefined();

    fileStore.setGlobalLedgerPublish(true);
    fileStore.recordApprovedPattern({ description: "DI for testability", concept: "request-scoped dependency injection" });
    const afterOptIn = JSON.parse(fs.readFileSync(globalLedgerPath, "utf-8"));
    expect(afterOptIn.concepts["request-scoped dependency injection"]).toBeTruthy();
  });
});

describe("GlobalStore — derived stance", () => {
  it("returns 'avoid' when rejections dominate (>2x)", () => {
    store.recordInstance("x", { project: "r", sessionId: "s1", verdict: "rejected" });
    store.recordInstance("x", { project: "r", sessionId: "s2", verdict: "rejected" });
    store.recordInstance("x", { project: "r", sessionId: "s3", verdict: "rejected" });
    expect(deriveStance(store.get("x")!)).toBe("avoid");
  });

  it("returns 'prefer' when approvals dominate (>2x)", () => {
    store.recordInstance("y", { project: "r", sessionId: "s1", verdict: "approved" });
    store.recordInstance("y", { project: "r", sessionId: "s2", verdict: "approved" });
    store.recordInstance("y", { project: "r", sessionId: "s3", verdict: "approved" });
    expect(deriveStance(store.get("y")!)).toBe("prefer");
  });

  it("returns 'mixed' when counts are close", () => {
    store.recordInstance("z", { project: "r", sessionId: "s1", verdict: "rejected" });
    store.recordInstance("z", { project: "r", sessionId: "s2", verdict: "approved" });
    expect(deriveStance(store.get("z")!)).toBe("mixed");
  });
});

describe("GlobalStore — query", () => {
  beforeEach(() => {
    store.recordInstance("Deploy to Railway", { project: "a", sessionId: "s1", verdict: "rejected", at: "2026-04-01T00:00:00.000Z" });
    store.recordInstance("Deploy to Railway", { project: "b", sessionId: "s2", verdict: "rejected", at: "2026-04-10T00:00:00.000Z" });
    store.recordInstance("Deploy to Railway", { project: "c", sessionId: "s3", verdict: "rejected", at: "2026-04-15T00:00:00.000Z" });
    store.recordInstance("Service layer pattern", { project: "a", sessionId: "s1", verdict: "approved", at: "2026-04-05T00:00:00.000Z" });
    store.recordInstance("Service layer pattern", { project: "a", sessionId: "s2", verdict: "approved", at: "2026-04-12T00:00:00.000Z" });
    store.recordInstance("Service layer pattern", { project: "b", sessionId: "s3", verdict: "approved", at: "2026-04-17T00:00:00.000Z" });
  });

  it("filters by concept substring (case-insensitive)", () => {
    const results = store.query({ concept: "railway" });
    expect(results).toHaveLength(1);
    expect(results[0].concept).toBe("Deploy to Railway");
  });

  it("filters by derived stance", () => {
    const avoid = store.query({ stance: "avoid" });
    expect(avoid.map((e) => e.concept)).toEqual(["Deploy to Railway"]);

    const prefer = store.query({ stance: "prefer" });
    expect(prefer.map((e) => e.concept)).toEqual(["Service layer pattern"]);
  });

  it("orders by lastSeenAt descending", () => {
    const results = store.query({});
    // "Service layer pattern" was last updated 2026-04-17; "Deploy to Railway" was 2026-04-15
    expect(results.map((e) => e.concept)).toEqual(["Service layer pattern", "Deploy to Railway"]);
  });

  it("respects the limit", () => {
    const results = store.query({ limit: 1 });
    expect(results).toHaveLength(1);
  });
});

describe("GlobalStore — resilience", () => {
  it("returns empty on a corrupted ledger file without throwing", () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "{ not valid json");
    const corrupted = new GlobalStore(ledgerPath);
    expect(() => corrupted.query({})).not.toThrow();
    expect(corrupted.size()).toBe(0);
  });

  it("returns empty on wrong-version file without throwing", () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 99, concepts: { x: {} } }));
    const store = new GlobalStore(ledgerPath);
    expect(store.query({})).toEqual([]);
  });

  describe("export / import (P5)", () => {
    it("exportLedger returns the current LedgerFile shape", () => {
      const store = new GlobalStore(ledgerPath);
      store.recordInstance("concept-a", { project: "p1", sessionId: "s1", verdict: "rejected", reason: "r" });
      const dump = store.exportLedger();
      expect(dump.version).toBe(1);
      expect(Object.keys(dump.concepts)).toContain("concept-a");
    });

    it("importLedger merges new concepts into the current ledger", () => {
      const a = new GlobalStore(ledgerPath);
      a.recordInstance("first-concept", { project: "p1", sessionId: "s1", verdict: "rejected", reason: "a" });

      const incoming = {
        version: 1,
        concepts: {
          "second-concept": {
            key: "second-concept",
            concept: "second-concept",
            instances: [{
              project: "p2", sessionId: "s2", verdict: "approved",
              at: "2026-01-01T00:00:00.000Z",
            }],
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        },
      };
      const summary = a.importLedger(incoming);
      expect(summary.conceptsAdded).toBe(1);
      expect(summary.instancesAdded).toBe(1);
      expect(a.size()).toBe(2);
    });

    it("importLedger dedups instances — re-importing the same file is idempotent", () => {
      const store = new GlobalStore(ledgerPath);
      store.recordInstance("dup-concept", {
        project: "p1", sessionId: "s1", verdict: "rejected", at: "2026-01-01T00:00:00.000Z",
      });
      const exported = store.exportLedger();

      const first = store.importLedger(exported);
      expect(first.instancesAdded).toBe(0);
      expect(first.conceptsAdded).toBe(0);

      const second = store.importLedger(exported);
      expect(second.instancesAdded).toBe(0);

      // Size unchanged, no duplicate instances.
      const entry = store.get("dup-concept")!;
      expect(entry.instances).toHaveLength(1);
    });

    it("importLedger adds only-new instances for a concept that exists in both", () => {
      const store = new GlobalStore(ledgerPath);
      store.recordInstance("shared", {
        project: "p1", sessionId: "s1", verdict: "rejected", at: "2026-01-01T00:00:00.000Z",
      });
      const incoming = {
        version: 1,
        concepts: {
          shared: {
            key: "shared",
            concept: "shared",
            instances: [
              // Duplicate of existing
              { project: "p1", sessionId: "s1", verdict: "rejected", at: "2026-01-01T00:00:00.000Z" },
              // New instance from another machine
              { project: "p2", sessionId: "s99", verdict: "rejected", at: "2026-03-01T00:00:00.000Z", reason: "remote" },
            ],
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-03-01T00:00:00.000Z",
          },
        },
      };
      const summary = store.importLedger(incoming);
      expect(summary.instancesAdded).toBe(1);
      expect(summary.conceptsMerged).toBe(1);

      const entry = store.get("shared")!;
      expect(entry.instances).toHaveLength(2);
      expect(entry.instances.some((i) => i.reason === "remote")).toBe(true);
    });

    it("importLedger rejects malformed input", () => {
      const store = new GlobalStore(ledgerPath);
      expect(() => store.importLedger({ concepts: "nope" })).toThrow();
      expect(() => store.importLedger({ version: 99, concepts: {} })).toThrow();
      expect(() => store.importLedger(null)).toThrow();
      expect(() => store.importLedger({ version: 1, concepts: { x: { instances: "nope" } } })).toThrow();
    });
  });
});

describe("GlobalStore — SEC1: reserved-name concepts don't crash or pollute", () => {
  it("recordInstance tolerates __proto__ / constructor keys (null-prototype map)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => store.recordInstance(key, { project: "p", sessionId: "s", verdict: "rejected" })).not.toThrow();
    }
    // the reserved-key concept is stored as a real own entry (not lost to the
    // prototype) and retrievable — proves the null-proto map works, not just "didn't crash"
    expect(store.get("__proto__")?.instances?.length).toBeGreaterThan(0);
    // a normal concept still records after, and nothing leaked onto Object.prototype
    store.recordInstance("use redis", { project: "p", sessionId: "s", verdict: "rejected" });
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).instances).toBeUndefined();
    // persists + reloads (Object.prototype-backed JSON re-parented) without throwing
    const reloaded = new GlobalStore(ledgerPath);
    expect(() => reloaded.recordInstance("__proto__", { project: "p", sessionId: "s", verdict: "approved" })).not.toThrow();
  });
});
