/**
 * #176 (Option A) — client-reported Mermaid render failures.
 *
 * The browser is the one place a version-matched mermaid parse runs, so when a
 * diagram genuinely fails to render there (after the #163 repair pass), it POSTs
 * a report and the store persists a small record the agent drains via
 * check_feedback. This suite pins the STORE contract: upsert/dedupe by
 * (artifactId, visualId), the report-once drain, authoritative secret redaction
 * (a mermaid error can echo a source-label secret), supersede-clear on revise,
 * and disk round-trip. Fake, not mock: a real FileStore over a tmp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { setGlobalStoreForTests } from "../global-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-render-fail-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

function seededStore(sessionId = "rf_session"): FileStore {
  const store = new FileStore(tmpDir, sessionId);
  store.createArtifact({ id: "plan_1", type: "plan", title: "Plan", content: { steps: [] } });
  return store;
}

describe("FileStore render failures (#176)", () => {
  it("records a failure and surfaces it (ids + title + error, NO source)", () => {
    const store = seededStore();
    store.recordRenderFailure({
      artifactId: "plan_1",
      visualId: "vis_a",
      error: "Parse error on line 2",
      title: "Auth flow",
    });
    const pending = store.getUnacknowledgedRenderFailures();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      artifactId: "plan_1",
      visualId: "vis_a",
      title: "Auth flow",
      error: "Parse error on line 2",
    });
    expect(pending[0]!.at).toEqual(expect.any(String));
    // The record carries no mermaid source under any key.
    expect(JSON.stringify(pending[0])).not.toContain("graph TD");
    expect("source" in (pending[0] as Record<string, unknown>)).toBe(false);
  });

  it("dedupes by (artifactId, visualId): a re-report UPSERTS to one record with the latest error", () => {
    const store = seededStore();
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "first error" });
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "second error" });
    const pending = store.getUnacknowledgedRenderFailures();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.error).toBe("second error");
    // A DIFFERENT visual is its own record.
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_b", error: "other" });
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(2);
  });

  it("drains via acknowledge (report once) and re-arms on a CHANGED report", () => {
    const store = seededStore();
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "boom" });
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(1);
    store.acknowledgeRenderFailures([{ artifactId: "plan_1", visualId: "vis_a" }]);
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(0);
    // A later re-report with a DIFFERENT error (a new failure) re-surfaces it.
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "boom again" });
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(1);
  });

  it("does NOT re-arm an already-acknowledged, UNCHANGED error (remount spam guard)", () => {
    const store = seededStore();
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "boom" });
    store.acknowledgeRenderFailures([{ artifactId: "plan_1", visualId: "vis_a" }]);
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(0);
    // A component remount re-POSTs the SAME still-broken error — the agent
    // already heard about it, so it must stay acknowledged (no re-delivery),
    // and there is still exactly ONE upserted record (no duplicate).
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "boom" });
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(0);
    store.acknowledgeRenderFailures([]); // no-op; assert the single record survives
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_b", error: "x" });
    // One drained (vis_a) + one live (vis_b) — proves vis_a wasn't duplicated.
    expect(store.getUnacknowledgedRenderFailures().map((r) => r.visualId)).toEqual(["vis_b"]);
  });

  it("REDACTS a secret-shaped error and drops a secret-shaped title (parity with content scan)", () => {
    const store = seededStore();
    store.recordRenderFailure({
      artifactId: "plan_1",
      visualId: "vis_secret",
      // A mermaid parser error can echo the offending source line verbatim.
      error: 'Parse error near A["key=AKIAIOSFODNN7EXAMPLE"]',
      title: "token ghp_abcdefghijklmnopqrst1234",
    });
    const rec = store.getUnacknowledgedRenderFailures()[0]!;
    expect(rec.error).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(rec.error).toContain("withheld");
    // The secret-shaped title is dropped entirely, not surfaced.
    expect(rec.title).toBeUndefined();
    expect(JSON.stringify(rec)).not.toMatch(/AKIA|ghp_/);
  });

  it("clears a superseded artifact's failures when a new version is created", () => {
    const store = seededStore();
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "broken" });
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(1);
    // Revise → a v2 artifact whose parentId is the original: the old diagram is
    // no longer what the human sees, so its failure record is dropped.
    store.createArtifact({
      id: "plan_2",
      type: "plan",
      title: "Plan v2",
      content: { steps: [] },
      parentId: "plan_1",
      version: 2,
    });
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(0);
  });

  it("round-trips through disk (rehydrates on reload) and writes nothing when clean", () => {
    const clean = new FileStore(tmpDir, "rf_clean");
    clean.forceFlush();
    expect(fs.existsSync(path.join(tmpDir, "sessions", "rf_clean", "render-failures.json"))).toBe(false);

    const store = seededStore("rf_persist");
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "e", title: "T" });
    store.forceFlush();
    const reloaded = new FileStore(tmpDir, "rf_persist");
    const pending = reloaded.getUnacknowledgedRenderFailures();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ artifactId: "plan_1", visualId: "vis_a", error: "e", title: "T" });
  });
});
