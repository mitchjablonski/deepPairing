// #187 — the late follow-up stamp is TRANSACTION-AWARE at the HTTP layer.
//
// The status route posts its VERDICT feedback note (approve/send-back/reject)
// AFTER flipping the artifact's status. For an APPROVE-WITH-FEEDBACK verdict
// (PlanArtifact's "Approve with modifications", or the changeset countdown with
// a typed note), the artifact is already `approved` when that note is posted —
// so a naive status-only stamp would dress a REVIEW VERDICT as a late follow-up
// (wrong lane + a spurious "present a revision" nudge). The route passes the
// server-only `verdictFeedback` flag to suppress the stamp; a GENUINELY-late
// comment on the SAME approved artifact (via the public /api/comments route,
// which never forwards that flag) still stamps. Both directions asserted here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});
afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

describe("#187 — verdict-feedback vs late follow-up stamping", () => {
  it("APPROVE-WITH-FEEDBACK (plan 'approve with modifications'): the verdict note is NOT stamped followUp", async () => {
    store.createArtifact({ id: "plan_1", type: "plan", title: "Wire it up", content: { steps: [] } });

    const res = await app.request("/api/artifacts/plan_1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", feedback: "approved — but rename the helper first" }),
    });
    expect(res.status).toBe(200);

    const comments = await store.getCommentsForArtifact("plan_1");
    const verdictNote = comments.find((c) => c.content.includes("rename the helper"));
    expect(verdictNote).toBeDefined();
    // The artifact IS approved now, but this is the verdict's own note — no stamp.
    expect("followUp" in verdictNote!).toBe(false);
  });

  it("a GENUINELY-LATE comment on the now-approved artifact (public /api/comments) IS stamped followUp", async () => {
    store.createArtifact({ id: "plan_2", type: "plan", title: "Wire it up", content: { steps: [] } });
    // Close the review (no feedback note this time).
    await app.request("/api/artifacts/plan_2/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });

    // A separate, later human comment via the PUBLIC route.
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "plan_2", content: "actually, one more thought later" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.followUp).toBe(true);
  });

  it("a client CANNOT suppress the stamp by smuggling verdictFeedback through the public comment route", async () => {
    store.createArtifact({ id: "plan_3", type: "plan", title: "Wire it up", content: { steps: [] } });
    await app.request("/api/artifacts/plan_3/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });

    // The public route builds addComment params explicitly and never forwards a
    // body `verdictFeedback`, so this smuggled flag is ignored — the stamp lands.
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: "plan_3", content: "sneaky", verdictFeedback: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comment.followUp).toBe(true);
  });
});
