/**
 * #171 — check_feedback must treat a rejected CHANGESET like every other
 * rejected write artifact (the #195/#169 bug class: without changeset in
 * `freshlyRejected`, a rejected changeset would fall through to "You may
 * proceed"). It also surfaces per-file review PROGRESS in structuredContent so
 * the agent can see which files the human reviewed/skipped and where comments
 * concentrate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { composeSendBackFeedback } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { expectHealthyCheckFeedbackPayload } from "./check-feedback-test-helpers.js";

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

    // M3 — busy poll: suggestedAction rides the prose only (struct drops it).
    expect(res.text).not.toContain("You may proceed");
    expect(res.text).toContain("Do NOT apply");
    expect(sc.suggestedAction).toBeUndefined();
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
    // M3 — waiting poll: the suggestedAction rides the prose (struct drops it).
    expect(res.text).toContain("changeset review");
    expect(sc.suggestedAction).toBeUndefined();
    // H1 — mid-flight (a draft still under review) must NOT nag about a debrief.
    expect(res.text).not.toContain("no present_debrief yet");
  });

  it("#175 — surfaces a needs_changes disposition + its reason in pendingArtifacts", async () => {
    const id = await presentChangeset();
    await store.setChangesetFileReview!(id, "auth/middleware.ts", "reviewed");
    await store.setChangesetFileReview!(id, "auth/session.ts", "needs_changes", "widen the Session type");
    await store.addComment({ id: "cmt_cs175", artifactId: id, content: "see rail", author: "human" } as any);

    const res = await callTool("check_feedback");
    const sc = res.structuredContent as any;
    const entry = sc.pendingArtifacts.find((a: any) => a.id === id);
    expect(entry.reviewState).toEqual({ "auth/middleware.ts": "reviewed", "auth/session.ts": "needs_changes" });
    expect(entry.reviewReasons).toEqual({ "auth/session.ts": "widen the Session type" });
    // Both files carry a disposition, so filesReviewed counts both.
    expect(entry.filesReviewed).toBe(2);
  });

  it("#175 — send-back wire shape: the revised feedback names ONLY the flagged files + their reasons", async () => {
    const id = await presentChangeset();
    // Human: one file looks right, one flagged with a reason (mirrors the UI).
    await store.setChangesetFileReview!(id, "auth/middleware.ts", "reviewed");
    await store.setChangesetFileReview!(id, "auth/session.ts", "needs_changes", "keep the login TTL bump");

    // The UI composes the send-back feedback from the SHARED helper and posts it
    // as the revision feedback (→ a human comment) alongside a `revised` status.
    const art = store.getArtifacts().find((a) => a.id === id)!;
    const reasons = (art.content as any).reviewReasons as Record<string, string>;
    const feedback = composeSendBackFeedback(["auth/session.ts"], reasons);
    await store.addComment({ id: "cmt_sendback", artifactId: id, content: feedback, author: "human" } as any);
    await store.updateArtifactStatus(id, "revised", "ui_revise_button" as any);

    const res = await callTool("check_feedback");
    // The agent reads WHICH file + WHY, and NOT the accepted file.
    expect(res.text).toContain("auth/session.ts");
    expect(res.text).toContain("keep the login TTL bump");
    expect(res.text).toContain("Please revise 1 file");
    // The look-right file is accepted — it must not appear as something to revise.
    expect(feedback).not.toContain("auth/middleware.ts");
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
    // #188 — top-level payload is the shared healthy contract; the lane delta is
    // that a non-changeset pending entry carries no review-state fields.
    expectHealthyCheckFeedbackPayload(sc as Record<string, unknown>);
    const entry = sc.pendingArtifacts[0];
    expect(entry).toBeDefined();
    expect(entry.reviewState).toBeUndefined();
    expect(entry.filesTotal).toBeUndefined();
  });
});

describe("check_feedback — H1 debrief-owed reinforcement", () => {
  it("nags to end with present_debrief once code is presented, review drained, no debrief yet", async () => {
    const id = await presentChangeset();
    // Human approves the changeset → no pending draft, obligations drained.
    await store.updateArtifactStatus(id, "approved", "ui_approve_button" as any);

    const res = await callTool("check_feedback");
    // The owes-debrief line rides the prose suggestedAction (winding-down moment).
    expect(res.text).toContain("no present_debrief yet");
    expect(res.text).toContain("present_debrief");
  });

  it("does NOT nag once a debrief has been presented", async () => {
    const id = await presentChangeset();
    await store.updateArtifactStatus(id, "approved", "ui_approve_button" as any);
    await callTool("present_debrief", {
      title: "Debrief — TTL refresh",
      summary: "We centralized the sliding-window TTL refresh into one middleware.",
    });
    // A human comment short-circuits the long-poll on the debrief draft.
    await store.addComment({ id: "cmt_db", artifactId: id, content: "thanks", author: "human" } as any);
    const res = await callTool("check_feedback");
    expect(res.text).not.toContain("no present_debrief yet");
  });
});

describe("check_feedback — del-side (removed-line) comment delivery (#186)", () => {
  async function presentWithDelLine(): Promise<string> {
    await callTool("present_changeset", {
      title: "Move TTL refresh into middleware",
      files: [
        {
          path: "auth/middleware.ts", changeType: "modified",
          hunks: [{ lines: [
            { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
            { kind: "del", content: "const session = await store.get(sid);", oldLine: 26 },
            { kind: "add", content: "const session = await store.getAndTouch(sid);", newLine: 26 },
          ] }],
        },
      ],
    });
    return store.getArtifacts().find((a) => a.type === "changeset")!.id;
  }

  it("marks an OLD-side comment as (removed line) and inlines the removed content", async () => {
    const id = await presentWithDelLine();
    await store.addComment({
      id: "cmt_del", artifactId: id, content: "why remove this? the OAuth path needs it", author: "human",
      target: { filePath: "auth/middleware.ts", lineStart: 26, side: "old" },
    } as any);

    const res = await callTool("check_feedback");
    // The agent reads WHICH line, that it's REMOVED, and WHAT the line said.
    expect(res.text).toContain("auth/middleware.ts:26");
    expect(res.text).toContain('(removed line: "const session = await store.get(sid);")');

    const sc = res.structuredContent as any;
    const entry = sc.comments.find((c: any) => c.id === "cmt_del");
    expect(entry).toBeDefined();
    expect(entry.side).toBe("old");
    expect(entry.removedLine).toBe("const session = await store.get(sid);");
    expect(entry.filePath).toBe("auth/middleware.ts");
  });

  it("a NEW-side comment on the SAME file+number is delivered byte-unchanged (no removed marking, no side)", async () => {
    const id = await presentWithDelLine();
    await store.addComment({
      id: "cmt_new", artifactId: id, content: "getAndTouch looks right", author: "human",
      target: { filePath: "auth/middleware.ts", lineStart: 26 },
    } as any);

    const res = await callTool("check_feedback");
    expect(res.text).toContain("auth/middleware.ts:26");
    expect(res.text).not.toContain("removed line");

    const sc = res.structuredContent as any;
    const entry = sc.comments.find((c: any) => c.id === "cmt_new");
    expect(entry).toBeDefined();
    expect(entry.side).toBeUndefined();
    expect(entry.removedLine).toBeUndefined();
  });
});
