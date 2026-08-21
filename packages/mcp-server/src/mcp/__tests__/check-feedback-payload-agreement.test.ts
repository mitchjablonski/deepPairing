import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * Q3 — THE PAYLOAD AGREES WITH ITSELF.
 *
 * Round 12's executed repro, verbatim: with an open question the poll said
 * "Answer the 1 open question first"; the human then sent the changeset back
 * ("Request changes" → status `revised` + composed feedback); the NEXT poll
 * printed the send-back AND "1 unanswered question carried over … answer before
 * new work" while the Suggested action line read "You may proceed with
 * implementation."
 *
 * The class, not just the instance: the suggested-action selector ran near the
 * top of the handler and could only see `pendingArts` / `freshlyRejected`, so
 * every lane discovered LATER in the body (send-backs, carried-over questions,
 * not-approved plan verdicts, still-open decision records, render failures) was
 * invisible to it. These tests pin each lane's clause AND the invariant that
 * ties them together: "You may proceed" is a fallback, never a base string that
 * an obligation gets bolted onto.
 *
 * Fakes-not-mocks: real FileStore over a tmp dir; the global-store singleton is
 * redirected to an isolated tmp ledger.
 */

const FIXED_NOW = new Date("2026-08-19T12:00:00.000Z");

let fx: GlobalStoreFixture;
let tmpDir: string;
let seq = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  fx = withGlobalStore("dp-cf-agree-");
  tmpDir = fx.dir;
});

afterEach(() => {
  vi.useRealTimers();
  fx.dispose();
});

function makeStore(): FileStore {
  return fx.track(new FileStore(tmpDir, `s_agree_${seq++}`));
}

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

/** The "Suggested action: …" clause out of the prose preamble. */
function suggestedActionOf(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("Suggested action: "));
  return line ? line.slice("Suggested action: ".length) : "";
}

const PROCEED = "You may proceed with implementation.";

/**
 * Q3 review (Q3-3) — the prose and the STRUCTURED status must agree, in the same
 * object. `structuredContent.status` derived from a narrower signal than the
 * suggestion did, and M3 only spreads `suggestedAction` into structuredContent
 * when status === "proceed" — so a payload could carry status:"proceed" AND a
 * suggestedAction full of blocking obligations. Every blocking-lane test below
 * asserts BOTH surfaces; prose-only assertions are what let this through.
 */
function expectBlocked(res: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }): string {
  const action = suggestedActionOf(res.content[0]!.text);
  expect(action).not.toContain(PROCEED);
  expect(res.structuredContent!.status).not.toBe("proceed");
  return action;
}

/** Seed a changeset the human SENDS BACK: status `revised` + the composed
 *  verdict feedback, exactly what POST /api/artifacts/:id/status writes. */
function seedSentBackChangeset(store: FileStore, id = "art_cs"): void {
  store.createArtifact({
    id,
    type: "changeset",
    title: "Move TTL refresh into middleware",
    content: {
      files: [{ path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }],
    },
  });
  store.updateArtifactStatus(id, "revised", "ui_revise_button");
  store.addComment({
    id: "cmt_sendback",
    artifactId: id,
    content: "split the middleware change out — it does two things at once",
    author: "human",
    target: { artifactId: id },
    verdictFeedback: true,
  } as never);
}

describe("Q3 — the suggested action derives from the body's own state", () => {
  it("a SEND-BACK is never 'you may proceed' (the round-12 repro)", async () => {
    const store = makeStore();
    seedSentBackChangeset(store);
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    const action = suggestedActionOf(text);

    // The body reports the send-back...
    expect(text).toContain("🔔 RESOLVED");
    expect(text).toContain("revised");
    // ...so the suggestion must too, and must NOT contradict it — on BOTH
    // surfaces (Q3-3).
    expect(action).toContain("SENT BACK");
    expect(action).toContain("Move TTL refresh into middleware");
    expectBlocked(res);
  });

  it("a carried-over unanswered question is never 'you may proceed'", async () => {
    const store = makeStore();
    // An explainer (acknowledge-only → never counts pending) carrying a question
    // the agent already acknowledged in a PRIOR run but never answered. The
    // carryover tail-walk re-raises it; pre-Q3 the suggestion ignored it.
    store.createArtifact({
      id: "art_ex",
      type: "explainer",
      title: "How session auth works",
      content: { title: "How session auth works", overview: "o", sections: [] },
    });
    store.addComment({
      id: "cmt_old_q",
      artifactId: "art_ex",
      content: "where does the session get created?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_ex" },
    });
    store.acknowledgeComments(["cmt_old_q"]); // a prior run drained it, never answered it
    store.updateArtifactStatus("art_ex", "approved", "ui_approve_button");

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    const action = suggestedActionOf(text);

    expect(text).toContain("carried over from earlier");
    expect(action).toContain("carried over from earlier");
    expectBlocked(res);
    // The carried question also rides the structured lane it always did.
    const sc = res.structuredContent as Record<string, any>;
    expect(sc.unansweredCarryover).toHaveLength(1);
  });

  it("the FULL repro: a send-back AND a carried question in one payload", async () => {
    const store = makeStore();
    seedSentBackChangeset(store);
    store.createArtifact({
      id: "art_ex",
      type: "explainer",
      title: "Walk-through",
      content: { title: "Walk-through", overview: "o", sections: [] },
    });
    store.addComment({
      id: "cmt_old_q",
      artifactId: "art_ex",
      content: "does this survive a restart?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_ex" },
    });
    store.acknowledgeComments(["cmt_old_q"]);
    store.updateArtifactStatus("art_ex", "approved", "ui_approve_button");

    const action = expectBlocked(await handleCheckFeedback(makeCtx(store), {}) as never);
    // BOTH obligations, and NOT the contradiction.
    expect(action).toContain("carried over from earlier");
    expect(action).toContain("SENT BACK");
  });

  it("a plan returned as REVISED is never 'you may proceed'", async () => {
    const store = makeStore();
    store.createArtifact({ id: "art_plan", type: "plan", title: "Rollout plan", content: { steps: [] } });
    store.recordPlanReview("art_plan");
    // The verdict landed without an artifact status flip (an older/partial
    // path) — the plan-verdict lane must still speak for itself.
    store.resolvePlanReview("art_plan", "revised", "stage it behind a flag first");
    // The plan artifact is still `draft`, so give the poll an immediate signal
    // rather than letting it sit in the 30s long-poll gate.
    store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "see my note", author: "human" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    const action = suggestedActionOf(text);
    expect(text).toContain("Plan reviews:");
    expect(action).toContain("is NOT an approval");
    expectBlocked(res);
  });

  it("an APPROVED plan verdict leaves the suggestion alone", async () => {
    const store = makeStore();
    store.createArtifact({ id: "art_plan", type: "plan", title: "Rollout plan", content: { steps: [] } });
    store.recordPlanReview("art_plan");
    store.resolvePlanReview("art_plan", "approved", "ship it");
    store.updateArtifactStatus("art_plan", "approved", "ui_approve_button");

    const action = suggestedActionOf((await handleCheckFeedback(makeCtx(store), {})).content[0]!.text);
    expect(action).toBe(PROCEED);
  });

  it("a send-back does NOT double-clause when it is also a plan verdict", async () => {
    // The /status route flips the artifact AND resolves the plan review in one
    // call, so both lanes see the same event. Exactly one clause ships.
    const store = makeStore();
    store.createArtifact({ id: "art_plan", type: "plan", title: "Rollout plan", content: { steps: [] } });
    store.recordPlanReview("art_plan");
    store.updateArtifactStatus("art_plan", "revised", "ui_revise_button");
    store.resolvePlanReview("art_plan", "revised", "stage it behind a flag first");

    const action = expectBlocked(await handleCheckFeedback(makeCtx(store), {}) as never);
    expect(action).toContain("SENT BACK");
    expect(action).not.toContain("is NOT an approval");
  });

  it("a broken diagram is never 'you may proceed'", async () => {
    const store = makeStore();
    store.createArtifact({ id: "art_p", type: "plan", title: "Plan", content: { steps: [] } });
    store.updateArtifactStatus("art_p", "approved", "ui_approve_button");
    store.recordRenderFailure({ artifactId: "art_p", visualId: "vis_a", error: "Parse error on line 2", title: "Auth flow" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    const action = suggestedActionOf(text);
    expect(text).toContain("Diagram render failures");
    expect(action).toContain("failed to render");
    expectBlocked(res);
  });

  it("ADVISORY lanes still keep 'you may proceed' (the fallback is not a blanket ban)", async () => {
    // The owes-debrief nudge is TRUE alongside proceeding — it must not be
    // treated as a blocking obligation. (A changeset gives the session the
    // shape that owes a debrief.)
    const store = makeStore();
    store.createArtifact({
      id: "art_cs",
      type: "changeset",
      title: "Ship it",
      content: { files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }] },
    });
    store.updateArtifactStatus("art_cs", "approved", "ui_approve_button");
    // Drain the approval status change so only the advisory lane remains.
    await handleCheckFeedback(makeCtx(store), {});

    const action = suggestedActionOf((await handleCheckFeedback(makeCtx(store), {})).content[0]!.text);
    expect(action.startsWith(PROCEED)).toBe(true);
    expect(action).toContain("present_debrief");
  });
});

describe("Q3 — one 'open artifact' definition, one 'pending decision'", () => {
  /** Seed a decision artifact + an UNRESOLVED decision record, then park the
   *  artifact in `status`. */
  function seedUnpickedDecision(store: FileStore, status: "revised" | "approved"): void {
    store.createArtifact({
      id: "art_dec",
      type: "decision",
      title: "Cache backend",
      content: { question: "Which cache?", options: [{ id: "o1", title: "Redis", description: "d", pros: [], cons: [] }] },
    });
    store.recordDecisionRequest({
      decisionId: "dec_1",
      artifactId: "art_dec",
      context: "Cache backend",
      options: [{ id: "o1", title: "Redis", description: "d" }],
    } as never);
    store.updateArtifactStatus("art_dec", status, status === "revised" ? "ui_revise_button" : "ui_approve_button");
  }

  it("REVISED: the store keeps the record open, and so does check_feedback now", async () => {
    // The divergence, one way. check_feedback read openness as
    // `draft || reviewing`, so a decision on a SENT-BACK artifact was dropped
    // from the ⏳ WAITING line while getPendingDecisions still returned it.
    const store = makeStore();
    seedUnpickedDecision(store, "revised");
    expect(store.getPendingDecisions().map((d) => d.decisionId)).toEqual(["dec_1"]);

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("⏳ WAITING: 1 decision(s) pending");
    expect(text).toContain("dec_1");
    const sc = res.structuredContent as Record<string, any>;
    // ONE predicate, three consumers: prose, structured mirror, suggestion.
    expect(sc.pendingDecisions).toEqual([{ decisionId: "dec_1", artifactId: "art_dec", title: "Cache backend" }]);
    expect(expectBlocked(res as never)).toContain("awaiting your pair's selection");
  });

  it("APPROVED: the store drops the orphan record, and so does check_feedback", async () => {
    // The divergence, the other way — the P3 orphan class must stay closed.
    const store = makeStore();
    seedUnpickedDecision(store, "approved");
    expect(store.getPendingDecisions()).toEqual([]);

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain("decision(s) pending");
    expect(res.structuredContent as Record<string, any>).not.toHaveProperty("pendingDecisions");
  });
});

describe("Q3 — the prose-only lanes get structured mirrors (the N1 class)", () => {
  it("📖 TO READ mirrors into structuredContent.toRead", async () => {
    const store = makeStore();
    store.createArtifact({
      id: "art_ex",
      type: "explainer",
      title: "How session auth works",
      content: { title: "How session auth works", overview: "o", sections: [] },
    });
    // A second, non-read-only draft so the poll has something pending too, plus
    // an immediate signal so the poll doesn't sit in the 30s long-poll gate.
    store.createArtifact({ id: "art_plan", type: "plan", title: "Plan", content: { steps: [] } });
    store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "see my note", author: "human" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = (res.content[0] as { text: string }).text;
    const sc = res.structuredContent as Record<string, any>;
    expect(text).toContain("📖 TO READ");
    // The explainer is deliberately absent from pendingArtifacts — `toRead` is
    // the only structured lane that can carry it.
    expect(sc.pendingArtifacts.map((a: any) => a.id)).toEqual(["art_plan"]);
    expect(sc.toRead).toEqual([{ id: "art_ex", type: "explainer", title: "How session auth works" }]);
  });

  it("Plan reviews mirror into structuredContent.planVerdicts", async () => {
    const store = makeStore();
    store.createArtifact({ id: "art_plan", type: "plan", title: "Rollout plan", content: { steps: [] } });
    store.recordPlanReview("art_plan");
    store.resolvePlanReview("art_plan", "approved", "ship it");
    store.updateArtifactStatus("art_plan", "approved", "ui_approve_button");

    const sc = (await handleCheckFeedback(makeCtx(store), {})).structuredContent as Record<string, any>;
    expect(sc.planVerdicts).toEqual([
      { artifactId: "art_plan", title: "Rollout plan", verdict: "approved", feedback: "ship it" },
    ]);
  });

  it("all three mirrors are ABSENT from a healthy payload (spread discipline)", async () => {
    const store = makeStore();
    const sc = (await handleCheckFeedback(makeCtx(store), {})).structuredContent as Record<string, unknown>;
    expect(sc).not.toHaveProperty("toRead");
    expect(sc).not.toHaveProperty("planVerdicts");
    expect(sc).not.toHaveProperty("pendingDecisions");
  });
});

/**
 * Q3 review (gate A) — the three HIGHs. Each is a lane that either never
 * decayed, never spoke, or spoke only in prose. A blocking clause that can't
 * clear is worse than no clause at all: it pins `hasBlocking` true forever and
 * every other suggestion queues behind it.
 */
describe("Q3 review — the obligations decay, and every lane speaks", () => {
  it("Q3-1: a SUPERSEDED plan's old 'revised' verdict stops nagging once v2 is approved", async () => {
    // The commonest plan flow. Pre-fix `planArtifacts` included superseded
    // revisions and plan-review records never clear, so v1's revised verdict
    // re-asserted "NOT an approval, re-present before implementing" on EVERY
    // subsequent poll — forever.
    const store = makeStore();
    store.createArtifact({ id: "plan_v1", type: "plan", title: "Rollout v1", content: { steps: [] } });
    store.recordPlanReview("plan_v1");
    store.updateArtifactStatus("plan_v1", "revised", "ui_revise_button");
    store.resolvePlanReview("plan_v1", "revised", "stage it behind a flag");

    // While v1 is the live, sent-back plan the block MUST hold.
    expectBlocked(await handleCheckFeedback(makeCtx(store), {}) as never);

    // The agent revises: v1 is superseded, v2 lands and is approved.
    store.updateArtifactStatus("plan_v1", "superseded", "agent_supersede");
    store.createArtifact({ id: "plan_v2", type: "plan", title: "Rollout v2", content: { steps: [] }, parentId: "plan_v1" });
    store.recordPlanReview("plan_v2");
    store.resolvePlanReview("plan_v2", "approved", "ship it");
    store.updateArtifactStatus("plan_v2", "approved", "ui_approve_button");

    const ctx = makeCtx(store);
    await handleCheckFeedback(ctx, {}); // drain the status changes
    const res = await handleCheckFeedback(ctx, {});
    const text = (res.content[0] as { text: string }).text;
    // The verdict history is still REPORTED (pre-existing behavior)...
    expect(text).toContain("Plan reviews:");
    expect(text).toContain("Rollout v1");
    // ...but it no longer OWES anything, so proceed returns on BOTH surfaces.
    expect(suggestedActionOf(text)).toBe(PROCEED);
    expect((res.structuredContent as Record<string, unknown>).status).toBe("proceed");
  });

  it("Q3-2: an INSISTED suggested edit is never 'you may proceed'", async () => {
    // The strongest obligation the body states ("you MUST respond to each …
    // stays PENDING in the UI as visible debt") had no clause at all — and it
    // drains after one poll, so the ONE payload carrying it was the
    // contradicting one.
    const store = makeStore();
    store.createArtifact({
      id: "art_code",
      type: "code_change",
      title: "modify lib/upload.ts",
      content: { filePath: "lib/upload.ts", changeType: "modify", before: "a", after: "b", reasoning: "r" },
    });
    store.updateArtifactStatus("art_code", "approved", "ui_approve_button");
    store.addComment({
      id: "cmt_insist",
      artifactId: "art_code",
      content: "use the exact guard",
      author: "human",
      target: { lineStart: 20, lineEnd: 20, filePath: "lib/upload.ts" },
      intent: "suggestion",
      suggestion: { originalText: "foo()", replacementText: "guardedFoo()", lineStart: 20, lineEnd: 20, state: "pending" },
    } as never);
    store.updateCommentSuggestion("cmt_insist", { state: "countered", counter: { reason: "no", replacementText: "x" } });
    store.acknowledgeComments(["cmt_insist"]);
    store.updateCommentSuggestion("cmt_insist", { state: "insisted", resetAcknowledged: true });

    const res = await handleCheckFeedback(makeCtx(store), {});
    expect((res.content[0] as { text: string }).text).toContain("Suggested edits");
    expect(expectBlocked(res as never)).toContain("suggested edit");
  });

  it("Q3-3: structuredContent.status agrees with the suggestion in the same object", async () => {
    // A carried-over question is invisible to hasActionableFeedback, so this
    // payload read status:"proceed" beside a blocking suggestedAction — and
    // because M3 only spreads suggestedAction when status === "proceed", the
    // contradiction was guaranteed to sit inside ONE object.
    const store = makeStore();
    store.createArtifact({
      id: "art_ex",
      type: "explainer",
      title: "Walk-through",
      content: { title: "Walk-through", overview: "o", sections: [] },
    });
    store.addComment({
      id: "cmt_old_q",
      artifactId: "art_ex",
      content: "still open?",
      author: "human",
      intent: "question",
      target: { artifactId: "art_ex" },
    });
    store.acknowledgeComments(["cmt_old_q"]);
    store.updateArtifactStatus("art_ex", "approved", "ui_approve_button");
    const ctx = makeCtx(store);
    await handleCheckFeedback(ctx, {}); // drain the approval status change

    const res = await handleCheckFeedback(ctx, {});
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.status).toBe("waiting");
    // M3's rule still holds: the verbatim echo is dropped off the 'proceed' hot
    // path only — the prose keeps the full clause.
    expect(sc).not.toHaveProperty("suggestedAction");
    expect(expectBlocked(res as never)).toContain("carried over from earlier");
  });
});

describe("Q3 review — durable send-backs, the directive, and felt weight", () => {
  it("MED 4: a sent-back changeset still blocks on poll 2 (and clears when superseded)", async () => {
    const store = makeStore();
    seedSentBackChangeset(store);
    const ctx = makeCtx(store);

    // Poll 1 drains the status-change event...
    expectBlocked(await handleCheckFeedback(ctx, {}) as never);
    // ...and poll 2, with the event long drained, must STILL block: the
    // changeset is sitting there `revised`. Deriving the clause from the drained
    // EVENT was the one-poll hole the carryover path exists to close; it now
    // derives from the STATE.
    expect(expectBlocked(await handleCheckFeedback(ctx, {}) as never)).toContain("SENT BACK");

    // And it self-clears without a drain: revise_artifact(supersede) closes the
    // parent, and a closed artifact owes nothing.
    store.updateArtifactStatus("art_cs", "superseded", "agent_supersede");
    const after = await handleCheckFeedback(ctx, {});
    expect(suggestedActionOf((after.content[0] as { text: string }).text)).toBe(PROCEED);
    expect((after.structuredContent as Record<string, unknown>).status).toBe("proceed");
  });

  it("MED 5: a session directive is never 'you may proceed'", async () => {
    const store = makeStore();
    store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "stop — do not touch auth", author: "human" });

    const res = await handleCheckFeedback(makeCtx(store), {});
    expect((res.content[0] as { text: string }).text).toContain("Human directive");
    // It re-steers the whole run, so it leads — ahead of even the question queue.
    expect(expectBlocked(res as never).startsWith("The human sent a directive")).toBe(true);
  });

  it("LOW 8: a payload owing many things leads with the top three, not all six", async () => {
    // Round-5 felt weight: a six-sentence "Suggested action:" reads like an
    // enterprise review board. Every clause's full text is still in the body.
    const store = makeStore();
    seedSentBackChangeset(store);
    store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "focus on auth first", author: "human" });
    store.createArtifact({ id: "art_spec", type: "spec", title: "Spec", content: { summary: "s", requirements: [], findings: [] } });
    store.addComment({
      id: "cmt_q", artifactId: "art_spec", content: "which DB?", author: "human",
      intent: "question", target: { artifactId: "art_spec" },
    });
    store.recordRenderFailure({ artifactId: "art_spec", visualId: "v1", error: "Parse error" });

    const action = expectBlocked(await handleCheckFeedback(makeCtx(store), {}) as never);
    expect(action).toMatch(/\(\+\d+ more below\.\)$/);
    // The highest-priority obligation still leads.
    expect(action.startsWith("The human sent a directive")).toBe(true);
  });

  it("LOW 8: the cap NEVER truncates the 'Do NOT apply' rejection posture", async () => {
    // The one trade this cap must not make. A directive + a fresh question + a
    // carried question fills all three slots before the base clause is reached;
    // the safety posture takes the last slot rather than falling off.
    const store = makeStore();
    store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "focus on auth first", author: "human" });
    // A carried-over question (acknowledged in a prior run, never answered).
    store.createArtifact({
      id: "art_ex", type: "explainer", title: "Walk-through",
      content: { title: "Walk-through", overview: "o", sections: [] },
    });
    store.addComment({
      id: "cmt_carried", artifactId: "art_ex", content: "still open?", author: "human",
      intent: "question", target: { artifactId: "art_ex" },
    });
    store.acknowledgeComments(["cmt_carried"]);
    store.updateArtifactStatus("art_ex", "approved", "ui_approve_button");
    // A fresh question.
    store.createArtifact({ id: "art_spec", type: "spec", title: "Spec", content: { summary: "s", requirements: [], findings: [] } });
    store.addComment({
      id: "cmt_q", artifactId: "art_spec", content: "which DB?", author: "human",
      intent: "question", target: { artifactId: "art_spec" },
    });
    // And the thing that must never be swallowed.
    store.createArtifact({
      id: "art_rej", type: "changeset", title: "Risky refactor",
      content: { files: [{ path: "a.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }] },
    });
    store.updateArtifactStatus("art_rej", "rejected", "ui_reject_button");

    const action = expectBlocked(await handleCheckFeedback(makeCtx(store), {}) as never);
    expect(action).toContain("Do NOT apply");
    expect(action).toContain("Risky refactor");
    expect(action).toMatch(/\(\+\d+ more below\.\)$/);
  });
});
