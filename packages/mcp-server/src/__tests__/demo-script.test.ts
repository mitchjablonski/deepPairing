/**
 * P1 — the demo script fires a specific, observable sequence so a fresh
 * install can SEE the rejection-block hero toast within seconds. These
 * tests pin that sequence so it doesn't drift.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../store/file-store.js";
import { setGlobalStoreForTests } from "../store/global-store.js";
import { runDemoScript, DEFAULT_REJECTION_CONCEPT, DEFAULT_REPROPOSAL } from "../demo-script.js";
import { conceptMatchesProposal } from "../mcp/preflight-validator.js";

type BroadcastEvent = { sessionId: string; event: any };

let tmpDir: string;
let store: FileStore;
let broadcasts: BroadcastEvent[];
let scheduled: Array<{ ms: number; fn: () => void | Promise<void> }>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-demo-script-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "demo_test");
  broadcasts = [];
  scheduled = [];
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

/** Run the timeline up to the given ms cutoff (fake time). */
async function runUntil(ms: number) {
  const due = scheduled.filter((s) => s.ms <= ms);
  for (const s of due) await s.fn();
}

describe("runDemoScript", () => {
  it("HONESTY GUARD — the demo's scripted block is one the REAL matcher would make", () => {
    // The demo hardcodes its own preflight_blocked broadcast. This pins that
    // the depicted block is not a dramatization: conceptMatchesProposal (the
    // real token-substring gate) must actually fire for this concept+proposal,
    // or the honest README (which says the match is on the concept's *words*)
    // would be contradicted by our own hero demo/screenshot.
    expect(conceptMatchesProposal(DEFAULT_REJECTION_CONCEPT, DEFAULT_REPROPOSAL)).toBe(true);
  });

  it("registers three scheduled steps on the canonical timeline", () => {
    runDemoScript({
      sessionId: "demo_x",
      store,
      broadcast: (sid, evt) => broadcasts.push({ sessionId: sid, event: evt }),
      schedule: (ms, fn) => scheduled.push({ ms, fn }),
      makeArtifactId: () => "art_demo_fixed",
    });
    const timings = scheduled.map((s) => s.ms).sort((a, b) => a - b);
    expect(timings).toEqual([500, 2500, 5000]);
    // Nothing fires until we advance time.
    expect(broadcasts).toEqual([]);
  });

  it("step 1 (t=500ms) creates a findings artifact and broadcasts artifact_created", async () => {
    runDemoScript({
      sessionId: "demo_x",
      store,
      broadcast: (sid, evt) => broadcasts.push({ sessionId: sid, event: evt }),
      schedule: (ms, fn) => scheduled.push({ ms, fn }),
      makeArtifactId: () => "art_demo_fixed",
    });
    await runUntil(500);

    const artifacts = store.getArtifacts();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe("art_demo_fixed");
    expect(artifacts[0].type).toBe("research");
    expect((artifacts[0].content as any).findings?.[0]?.title).toContain("ConfigStore");

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].sessionId).toBe("demo_x");
    expect(broadcasts[0].event.type).toBe("artifact_created");
  });

  it("step 2 (t=2500ms) rejects the artifact, records the approach, and fires ledger_write", async () => {
    runDemoScript({
      sessionId: "demo_x",
      store,
      broadcast: (sid, evt) => broadcasts.push({ sessionId: sid, event: evt }),
      schedule: (ms, fn) => scheduled.push({ ms, fn }),
      makeArtifactId: () => "art_demo_fixed",
    });
    await runUntil(2500);

    const artifact = store.getArtifacts().find((a) => a.id === "art_demo_fixed");
    expect(artifact?.status).toBe("rejected");

    const memory = store.getSessionMemory();
    const rejected = memory.rejectedApproaches.find((r) => r.concept === "global mutable state for config");
    expect(rejected).toBeDefined();
    expect(rejected?.reason).toMatch(/broke testability/i);

    const events = broadcasts.map((b) => b.event.type);
    expect(events).toContain("artifact_updated");
    expect(events).toContain("ledger_write");

    const ledger = broadcasts.find((b) => b.event.type === "ledger_write")!.event;
    expect(ledger.kind).toBe("rejected");
    expect(ledger.concept).toBe("global mutable state for config");
  });

  it("step 3 (t=5000ms) fires preflight_blocked with concept-match via and session source", async () => {
    runDemoScript({
      sessionId: "demo_x",
      store,
      broadcast: (sid, evt) => broadcasts.push({ sessionId: sid, event: evt }),
      schedule: (ms, fn) => scheduled.push({ ms, fn }),
      makeArtifactId: () => "art_demo_fixed",
    });
    await runUntil(5000);

    const block = broadcasts.find((b) => b.event.type === "preflight_blocked");
    expect(block).toBeDefined();
    expect(block!.event.source).toBe("session");
    expect(block!.event.match.via).toBe("concept");
    expect(block!.event.match.concept).toBe(DEFAULT_REJECTION_CONCEPT);
    expect(block!.event.match.proposal).toBe(DEFAULT_REPROPOSAL);
    // and the depicted block is one the real matcher would actually make
    expect(conceptMatchesProposal(block!.event.match.concept, block!.event.match.proposal)).toBe(true);
  });

  it("returns the artifactId synchronously so the caller can reference it", () => {
    const result = runDemoScript({
      sessionId: "demo_x",
      store,
      broadcast: () => {},
      schedule: () => {},
      makeArtifactId: () => "art_demo_fixed",
    });
    expect(result.artifactId).toBe("art_demo_fixed");
  });
});
