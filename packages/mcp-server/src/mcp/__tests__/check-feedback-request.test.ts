import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { buildFirstCallHint } from "../first-call-hint.js";
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

  /**
   * P2 review F4 — "authoritative" is a claim about PROVENANCE. Only the
   * one-click affordance computes a scope; gating the clause on the scope's mere
   * presence would hand that authority to any future writer of the field.
   */
  it("F4: a scope on a NON-walk_me_through request never earns the authoritative clause", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({
      text: "explain the auth middleware",
      intent: "explain",
      source: "composer",
      scope: { filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 27 },
    });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).not.toMatch(/SCOPE \(from the UI/);
    // The data still rides in structuredContent — it is the PROSE authority
    // claim that is gated, not the field.
    const sc = res.structuredContent as { requests?: Array<{ source?: string; scope?: unknown }> };
    expect(sc.requests![0]!.source).toBe("composer");
    expect(sc.requests![0]!.scope).toBeDefined();
  });

  it("F1/F2: an old-side and a mixed hunk deliver their diff-coordinate warnings", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({
      text: "Walk me through the 2 lines removed from a.ts",
      intent: "explain",
      source: "walk_me_through",
      scope: { filePath: "a.ts", lineStart: 8, lineEnd: 9, side: "old", removedLineCount: 2, fileRemoved: true },
    });
    store.addRequest({
      text: "Walk me through the change to b.ts",
      intent: "explain",
      source: "walk_me_through",
      scope: { filePath: "b.ts", lineStart: 10, lineEnd: 11, side: "new", oldStart: 11, oldEnd: 14, removedLineCount: 4 },
    });
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/a\.ts:8-9 · PRE-change lines/);
    expect(text).toMatch(/this file was DELETED in this changeset/);
    expect(text).toMatch(/b\.ts:10-11 · plus 4 lines removed \(pre-change 11-14\)/);
  });

  /**
   * P2 review F5 — the first-call obligations inventory truncates a request's
   * text at 120 chars, which on any deep path ate exactly the part that makes a
   * walk-me-through safe to serve (the line range, "not a whole-file tour") —
   * and this is the surface the no-agent-live toast advertises ("queued… when
   * the session resumes"). The scope clause is appended AFTER the slice.
   */
  it("F5: the RESUME surface (first-call hint) keeps the scope even when the text is truncated", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const longText =
      "Walk me through the change to packages/mcp-server/src/mcp/tools/check-feedback-delivery.ts at lines 25–27 " +
      "(post-change line numbers) — respond with a present_explainer scoped to this hunk: what it does and why. " +
      "Scope to exactly this hunk, not a whole-file tour.";
    expect(longText.length).toBeGreaterThan(120);
    store.addRequest({
      text: longText,
      intent: "explain",
      source: "walk_me_through",
      scope: {
        filePath: "packages/mcp-server/src/mcp/tools/check-feedback-delivery.ts",
        lineStart: 25,
        lineEnd: 27,
        side: "new",
        artifactId: "art_cs",
      },
    });
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/pending human request/);
    // The prose IS truncated…
    expect(hint).not.toContain("not a whole-file tour");
    // …but the scope survives it, which is the whole point.
    expect(hint).toMatch(/SCOPE \(from the UI, authoritative\)/);
    expect(hint).toMatch(/check-feedback-delivery\.ts:25-27/);
    expect(hint).toMatch(/artifact art_cs/);
  });

  it("F5: an unscoped request's hint line is unchanged (no empty scope clause)", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    store.addRequest({ text: "explain the router", intent: "explain" });
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toMatch(/pending human request/);
    expect(hint).not.toMatch(/SCOPE \(from the UI/);
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
