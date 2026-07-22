/**
 * #176 (Option A) — check_feedback delivers pending client-reported Mermaid
 * render failures to the agent (prose + structuredContent.renderFailures), with
 * the visual id + error + title and NEVER any source/secret. Reports once (then
 * drains), and the healthy payload stays byte-for-byte (contract lock in
 * check-feedback-ledger-health.test.ts). Fake, not mock: a real FileStore.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-cf-rf-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
});

afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(store: FileStore): ToolContext {
  const server = { notification: () => {} };
  return {
    server,
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok-1",
  } as unknown as ToolContext;
}

describe("check_feedback surfaces render failures (#176)", () => {
  it("delivers the failure once with visualId + error + title, then drains", async () => {
    const store = new FileStore(tmpDir, "s1");
    store.createArtifact({ id: "plan_1", type: "plan", title: "Plan", content: { steps: [] } });
    store.recordRenderFailure({
      artifactId: "plan_1",
      visualId: "vis_a",
      error: "Parse error on line 2",
      title: "Auth flow",
    });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Diagram render failures");
    expect(text).toContain("vis_a");
    expect(text).toContain("plan_1");
    expect(text).toContain("Parse error on line 2");
    expect(text).toContain("Auth flow");

    const sc = res.structuredContent as { renderFailures?: Array<Record<string, unknown>>; status: string };
    expect(sc.renderFailures).toEqual([
      { artifactId: "plan_1", visualId: "vis_a", title: "Auth flow", error: "Parse error on line 2" },
    ]);
    // A broken diagram the human is staring at is actionable, not "waiting".
    expect(sc.status).toBe("feedback");

    // Report ONCE: check_feedback drained it, so it won't surface again. (Asserted
    // at the store level to avoid a second call long-polling on the pending draft.)
    expect(store.getUnacknowledgedRenderFailures()).toHaveLength(0);
  });

  it("does NOT re-deliver an already-reported, UNCHANGED failure after a remount re-report", async () => {
    const store = new FileStore(tmpDir, "s_remount");
    store.createArtifact({ id: "plan_1", type: "plan", title: "Plan", content: { steps: [] } });
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "boom" });

    // First poll delivers + drains it.
    const res1 = await handleCheckFeedback(makeCtx(store), {});
    expect((res1.structuredContent as { renderFailures?: unknown[] }).renderFailures).toHaveLength(1);

    // A remount re-POSTs the SAME still-broken error. A human comment makes the
    // NEXT poll return promptly (the pending draft would otherwise long-poll).
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "boom" });
    store.addComment({ id: "cmt_x", artifactId: "__session__", content: "ok", author: "human" });

    const res2 = await handleCheckFeedback(makeCtx(store), {});
    // The agent already heard about this diagram — it must NOT be re-delivered.
    expect("renderFailures" in (res2.structuredContent as Record<string, unknown>)).toBe(false);
    expect((res2.content[0] as { text: string }).text).not.toContain("Diagram render failures");

    // But a CHANGED error IS a new failure and re-delivers.
    store.recordRenderFailure({ artifactId: "plan_1", visualId: "vis_a", error: "different boom" });
    store.addComment({ id: "cmt_y", artifactId: "__session__", content: "ok", author: "human" });
    const res3 = await handleCheckFeedback(makeCtx(store), {});
    expect((res3.structuredContent as { renderFailures?: Array<{ error: string }> }).renderFailures).toEqual([
      { artifactId: "plan_1", visualId: "vis_a", error: "different boom" },
    ]);
  });

  it("never leaks a secret through the error/title path", async () => {
    const store = new FileStore(tmpDir, "s2");
    store.createArtifact({ id: "plan_1", type: "plan", title: "Plan", content: { steps: [] } });
    store.recordRenderFailure({
      artifactId: "plan_1",
      visualId: "vis_secret",
      error: 'Parse error near A["AKIAIOSFODNN7EXAMPLE"]',
      title: "ghp_abcdefghijklmnopqrst1234",
    });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const blob = JSON.stringify(res.structuredContent) + (res.content[0] as { text: string }).text;
    expect(blob).not.toMatch(/AKIA|ghp_/);
    // Still tells the agent WHICH visual broke.
    expect(blob).toContain("vis_secret");
  });

  it("healthy payload has no renderFailures key (contract lock)", async () => {
    const store = new FileStore(tmpDir, "s3");
    store.createArtifact({ id: "plan_1", type: "plan", title: "Plan", content: { steps: [] } });
    store.addComment({ id: "cmt_1", artifactId: "__session__", content: "ok", author: "human" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    expect("renderFailures" in (res.structuredContent as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(res.structuredContent)).not.toContain("render");
  });
});
