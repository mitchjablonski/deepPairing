/**
 * #171 — check_feedback must treat a rejected CHANGESET like every other
 * rejected write artifact (the #195/#169 bug class: without changeset in
 * `freshlyRejected`, a rejected changeset would fall through to "You may
 * proceed"). It also surfaces per-file review PROGRESS in structuredContent so
 * the agent can see which files the human reviewed/skipped and where comments
 * concentrate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

async function presentChangeset(): Promise<string> {
  await callTool("present_changeset", {
    title: "Move TTL refresh into middleware",
    risks: ["touches auth"],
    files: [
      { path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 26 }] }] },
      { path: "auth/session.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "y", newLine: 12 }] }] },
    ],
  });
  return store.getArtifacts().find((a) => a.type === "changeset")!.id;
}

describe("check_feedback — rejected changeset (#171)", () => {
  it("a rejected changeset gets the 'Do NOT apply' posture, not 'You may proceed'", async () => {
    const id = await presentChangeset();
    await store.updateArtifactStatus(id, "rejected", "ui_reject_button" as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;

    expect(sc.suggestedAction).not.toContain("You may proceed");
    expect(sc.suggestedAction).toContain("Do NOT apply");
    expect(sc.status).toBe("feedback");
    expect(sc.rejected.map((r: any) => r.id)).toContain(id);
    expect(sc.rejected.find((r: any) => r.id === id).type).toBe("changeset");
    expect(res.text).toContain("❌ REJECTED");
  });

  it("reports the rejected changeset verdict exactly once (dedupe)", async () => {
    const id = await presentChangeset();
    await store.updateArtifactStatus(id, "rejected", "ui_reject_button" as any);

    const first = await callTool("check_feedback");
    expect((first.structuredContent as any).rejected).toHaveLength(1);
    const second = await callTool("check_feedback");
    expect((second.structuredContent as any).rejected).toHaveLength(0);
    expect((second.structuredContent as any).suggestedAction).not.toContain("Do NOT apply");
  });
});

describe("check_feedback — per-file review state (#171)", () => {
  it("surfaces a changeset's per-file review state + counts in pendingArtifacts", async () => {
    const id = await presentChangeset();
    // Human marks one file reviewed, one skipped.
    await store.setChangesetFileReview!(id, "auth/middleware.ts", "reviewed");
    await store.setChangesetFileReview!(id, "auth/session.ts", "skipped");
    // A human comment makes the poll return immediately (the realistic path —
    // the agent polls after the human acts) instead of long-polling 30s on the
    // still-open draft.
    await store.addComment({ id: "cmt_cs1", artifactId: id, content: "why getAndTouch here?", author: "human" } as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    const entry = sc.pendingArtifacts.find((a: any) => a.id === id);
    expect(entry).toBeDefined();
    expect(entry.reviewState).toEqual({ "auth/middleware.ts": "reviewed", "auth/session.ts": "skipped" });
    expect(entry.filesReviewed).toBe(2);
    expect(entry.filesTotal).toBe(2);
    // The changeset is still a draft awaiting the whole-changeset verdict.
    expect(sc.suggestedAction).toContain("changeset review");
  });

  it("a non-changeset pending entry carries no review-state fields", async () => {
    await callTool("present_findings", {
      summary: "s",
      findings: [{ category: "c", detail: "d", significance: "low" }],
    });
    const artId = store.getArtifacts()[0].id;
    // Short-circuit the long-poll (see above) with a human comment.
    await store.addComment({ id: "cmt_rf1", artifactId: artId, content: "looks fine", author: "human" } as any);
    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    const entry = sc.pendingArtifacts[0];
    expect(entry).toBeDefined();
    expect(entry.reviewState).toBeUndefined();
    expect(entry.filesTotal).toBeUndefined();
  });
});
