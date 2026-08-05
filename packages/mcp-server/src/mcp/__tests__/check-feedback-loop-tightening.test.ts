/**
 * #195 F1 — agent-loop tightening for check_feedback:
 *   M1 — a poll GIVE-UP ceiling: after ~6 empty polls, offer a sanctioned exit
 *        (summarize + stop; artifacts persist, questions carry over) on top of
 *        the unchanged earlier escalations.
 *   M2 — questions LEAD the suggestedAction: when the human left open questions,
 *        "Answer the N open question(s) first" precedes any rejection/comment
 *        guidance (which still follows).
 *
 * Fakes-not-mocks: a real FileStore over a tmp dir + isolated tmp ledger. For
 * M1 we stub only waitForFeedback (so the empty poll doesn't block 30s) — the
 * rest of the handler runs for real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let tmpDir: string;

beforeEach(() => {
  fx = withGlobalStore("dp-loop-tighten-");
  tmpDir = fx.dir;
});

afterEach(() => {
  fx.dispose();
});

function makeCtx(store: FileStore, pollCount: number): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: pollCount,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok",
  } as unknown as ToolContext;
}

describe("#195 M1 — poll give-up ceiling", () => {
  it("offers a sanctioned exit after ~6 empty polls with a pending draft", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_ceiling"));
    store.createArtifact({ id: "art_spec", type: "spec", title: "Session spec", content: { summary: "s", requirements: [] } });
    // Stub the long-poll so the empty poll returns immediately.
    (store as unknown as { waitForFeedback: () => Promise<void> }).waitForFeedback = async () => {};
    const ctx = makeCtx(store, 5); // → increments to 6 on this empty poll
    const res = await handleCheckFeedback(ctx, {});
    const text = (res.content[0] as { text: string }).text;
    expect(ctx.state.checkFeedbackPollCount).toBe(6);
    expect(text).toContain("empty polls");
    expect(text).toMatch(/STOP here|stop here/);
    expect(text).toMatch(/carry over/);
    // The earlier escalation is unchanged (still present alongside the ceiling).
    expect(text).toContain("The human may not have the companion UI open.");
  });

  it("does NOT show the ceiling before the 6th empty poll (earlier escalation only)", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_noceiling"));
    store.createArtifact({ id: "art_spec2", type: "spec", title: "Session spec", content: { summary: "s", requirements: [] } });
    (store as unknown as { waitForFeedback: () => Promise<void> }).waitForFeedback = async () => {};
    const ctx = makeCtx(store, 2); // → 3
    const res = await handleCheckFeedback(ctx, {});
    const text = (res.content[0] as { text: string }).text;
    expect(ctx.state.checkFeedbackPollCount).toBe(3);
    expect(text).toContain("The human may not have the companion UI open.");
    expect(text).not.toMatch(/empty polls you don't have to keep spinning/);
  });
});

describe("#195 M2 — questions LEAD the suggestedAction", () => {
  it("leads with 'Answer the N open question(s) first' ahead of the pending-review guidance", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_q"));
    store.createArtifact({ id: "art_spec3", type: "spec", title: "Session spec", content: { summary: "s", requirements: [] } });
    // An unanswered human question makes the poll return immediately.
    store.addComment({
      id: "cmt_q",
      artifactId: "art_spec3",
      content: "does this cover refresh tokens?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_spec3" },
    } as never);
    const res = await handleCheckFeedback(makeCtx(store, 0), {});
    const text = (res.content[0] as { text: string }).text;
    const suggested = text.split("Suggested action: ")[1]!.split("\n")[0]!;
    expect(suggested).toMatch(/^Answer the 1 open question first/);
    // The pending-review guidance still follows.
    expect(suggested).toContain("Wait for spec approval");
  });

  it("questions lead, then the rejection 'Do NOT apply' posture follows (not replaced)", async () => {
    const store = fx.track(new FileStore(tmpDir, "s_qrej"));
    store.createArtifact({ id: "art_rej", type: "spec", title: "Risky spec", content: { summary: "s", requirements: [] } });
    store.updateArtifactStatus("art_rej", "rejected", "ui_reject_button" as never);
    store.addComment({
      id: "cmt_qr",
      artifactId: "art_rej",
      content: "why reject this?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_rej" },
    } as never);
    const res = await handleCheckFeedback(makeCtx(store, 0), {});
    const text = (res.content[0] as { text: string }).text;
    const suggested = text.split("Suggested action: ")[1]!.split("\n")[0]!;
    expect(suggested).toMatch(/^Answer the 1 open question first/);
    // The rejection posture is preserved, just after the questions lead.
    expect(suggested).toContain("Do NOT apply");
    expect(suggested.indexOf("Answer the 1 open question")).toBeLessThan(suggested.indexOf("Do NOT apply"));
  });
});
