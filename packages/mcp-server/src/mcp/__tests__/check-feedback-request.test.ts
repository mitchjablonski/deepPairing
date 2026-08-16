import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * G1 (#198b) — check_feedback surfaces pending human REQUESTS (the request
 * composer) as a "Human requests" prose block + a spread-when-present `requests`
 * structured key, and ranks them AFTER unanswered questions and AFTER
 * freshlyRejected's "Do NOT apply" posture in suggestedAction. A fake FileStore
 * over a tmp dir — no mocks.
 */

let fx: GlobalStoreFixture;
let tmpDir: string;
beforeEach(() => {
  fx = withGlobalStore("dp-cf-req-");
  tmpDir = fx.dir;
});
afterEach(() => {
  fx.dispose();
});

function makeCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok",
  } as unknown as ToolContext;
}

describe("#198b check_feedback surfaces pending human requests", () => {
  it("delivers a pending request as a prose block + a structuredContent `requests` key", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "the auth middleware", intent: "explain" });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/Human requests \(1\)/);
    expect(text).toMatch(/the auth middleware/);
    expect(text).toMatch(/present_explainer/);
    expect(text).toMatch(/servedRequestId/);
    const sc = res.structuredContent as { status: string; requests?: Array<{ id: string; text: string; intent: string }> };
    expect(sc.status).toBe("feedback");
    expect(sc.requests).toHaveLength(1);
    expect(sc.requests![0]!.intent).toBe("explain");
    expect(sc.requests![0]!.text).toBe("the auth middleware");
  });

  it("a served request drops out — no prose block, no structured key", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const req = store.addRequest({ text: "the cache layer", intent: "plan" });
    store.markRequestServed(req.id, "art_plan_1");
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).not.toMatch(/Human requests/);
    const sc = res.structuredContent as { requests?: unknown };
    expect(sc.requests).toBeUndefined();
  });

  it("the healthy poll payload spreads NO `requests` key when there are none", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const res = await handleCheckFeedback(makeCtx(store), {});
    const sc = res.structuredContent as Record<string, unknown>;
    expect("requests" in sc).toBe(false);
  });

  it("ORDERING: a request ranks AFTER an unanswered question AND after freshlyRejected's 'Do NOT apply'", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    // A rejected code_change → freshlyRejected "Do NOT apply" posture.
    const art = store.createArtifact({
      id: "art_cc",
      type: "code_change",
      title: "risky edit",
      content: { filePath: "a.ts", changeType: "modify", before: "x", after: "y", reasoning: "r" },
    });
    store.updateArtifactStatus(art.id, "rejected", "ui_reject_button");
    // An unanswered human question.
    store.addComment({
      id: "cmt_q",
      artifactId: "art_cc",
      content: "which approach?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_cc" },
    });
    // A pending request.
    store.addRequest({ text: "the retry logic", intent: "status" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    // The "Suggested action:" line carries the full ordered string.
    const suggested = text.split("Suggested action:")[1] ?? "";
    const iQuestion = suggested.indexOf("Answer the 1 open question");
    const iRejected = suggested.indexOf("Do NOT apply");
    const iRequest = suggested.indexOf("The human sent 1 request");
    expect(iQuestion).toBeGreaterThanOrEqual(0);
    expect(iRejected).toBeGreaterThanOrEqual(0);
    expect(iRequest).toBeGreaterThanOrEqual(0);
    // questions → rejected → requests
    expect(iQuestion).toBeLessThan(iRejected);
    expect(iRejected).toBeLessThan(iRequest);
  });

  it("requests survive a store reload (persisted, session-scoped)", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "the migration", intent: "plan" });
    store.forceFlush();
    // A fresh store over the same dir/session reloads the request.
    const reloaded = fx.track(new FileStore(tmpDir, "s1"));
    expect(reloaded.getPendingRequests()).toHaveLength(1);
    expect(reloaded.getPendingRequests()[0]!.text).toBe("the migration");
  });
});

/**
 * P2 (round-11 MED 3) — the request's SCOPE reaches the agent as DATA, not only
 * inside the human-readable text. Round 11 found a walk-me-through request was
 * byte-indistinguishable from a hand-typed composer request, so copy drift could
 * silently degrade "explain this hunk" into a whole-codebase tour and nothing
 * told the agent which artifact to link. The prose stays PRIMARY; this is the
 * additive channel.
 */
describe("P2 — check_feedback delivers a request's source + scope", () => {
  it("renders the scope on the delivered line AND mirrors it in structuredContent", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({
      text: "Walk me through the change to auth/middleware.ts at lines 25–27",
      intent: "explain",
      source: "walk_me_through",
      scope: { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 27 },
    });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/SCOPE \(from the UI, authoritative\)/);
    expect(text).toMatch(/auth\/middleware\.ts:25-27/);
    expect(text).toMatch(/artifact art_cs/);
    const sc = res.structuredContent as {
      requests?: Array<{ id: string; source?: string; scope?: Record<string, unknown> }>;
    };
    expect(sc.requests![0]!.source).toBe("walk_me_through");
    expect(sc.requests![0]!.scope).toEqual({
      artifactId: "art_cs",
      filePath: "auth/middleware.ts",
      lineStart: 25,
      lineEnd: 27,
    });
  });

  it("an item-anchored scope (needs-your-eyes) delivers the artifact + the item ref", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({
      text: 'Walk me through "the expiry check"',
      intent: "explain",
      source: "walk_me_through",
      scope: { artifactId: "art_cs", itemRef: "debrief:needs-your-eyes:0" },
    });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/artifact art_cs · debrief:needs-your-eyes:0/);
  });

  it("BACK-COMPAT: an unscoped (pre-P2) request delivers exactly as before — no SCOPE line, no new keys", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "the auth middleware", intent: "explain" });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).not.toMatch(/SCOPE \(from the UI/);
    const sc = res.structuredContent as { requests?: Array<Record<string, unknown>> };
    expect(Object.keys(sc.requests![0]!).sort()).toEqual(["id", "intent", "text"]);
  });
});
