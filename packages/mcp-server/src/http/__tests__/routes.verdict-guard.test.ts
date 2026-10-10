// O3 (#231) — cross-tab last-wins VERDICT guard. A stale second tab must not be
// able to REVERSE an already-final human verdict (approved↔rejected↔revised).
// Covers: the store backstop, the route 409 + refresh broadcast, and the pinned
// invariants that MUST stay normal (draft→terminal, same-verdict re-assert,
// agent supersede/revise, J1 decision-resolve).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";
import { isCrossTerminalVerdictFlip } from "../../store/verdict-guard.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: Array<Record<string, unknown>>;

beforeEach(() => {
  fx = withGlobalStore("dp-verdict-guard-");
  store = fx.track(new FileStore(fx.dir, "test_session"));
  broadcasts = [];
  app = withHash(createHttpRoutes(store, fx.dir, (m) => broadcasts.push(m as Record<string, unknown>)), fx.dir);
});

afterEach(() => {
  fx.dispose();
});

const postStatus = (id: string, status: string, feedback?: string) =>
  app.request(`/api/artifacts/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(feedback ? { status, feedback } : { status }),
  });

describe("O3 (#231) — verdict-guard predicate", () => {
  it("flags a human verdict flip between DIFFERENT terminal states", () => {
    expect(isCrossTerminalVerdictFlip("approved", "rejected", "ui_reject_button")).toBe(true);
    expect(isCrossTerminalVerdictFlip("rejected", "approved", "ui_approve_button")).toBe(true);
    expect(isCrossTerminalVerdictFlip("approved", "revised", "ui_revise_button")).toBe(true);
  });

  it("does NOT flag draft→terminal, same-verdict re-assert, or agent transitions", () => {
    // Draft → terminal is the normal first verdict.
    expect(isCrossTerminalVerdictFlip("draft", "approved", "ui_approve_button")).toBe(false);
    expect(isCrossTerminalVerdictFlip("reviewing", "rejected", "ui_reject_button")).toBe(false);
    // Same verdict re-asserted (idempotent double-click) is allowed.
    expect(isCrossTerminalVerdictFlip("approved", "approved", "ui_approve_button")).toBe(false);
    // Agent lifecycle transitions carry non-human reasons → never guarded.
    expect(isCrossTerminalVerdictFlip("approved", "superseded", "agent_supersede")).toBe(false);
    expect(isCrossTerminalVerdictFlip("approved", "rejected", "agent_revise")).toBe(false);
    expect(isCrossTerminalVerdictFlip("approved", "obsolete", "ui_dismiss_obsolete")).toBe(false);
  });
});

describe("O3 (#231) — store backstop", () => {
  it("refuses to reverse an already-final human verdict (approved stays approved)", () => {
    store.createArtifact({ id: "art_1", type: "research", title: "t", content: {} });
    store.updateArtifactStatus("art_1", "approved", "ui_approve_button");
    // A stale tab's reject lands on the store directly.
    store.updateArtifactStatus("art_1", "rejected", "ui_reject_button");
    expect(store.getArtifacts().find((a) => a.id === "art_1")?.status).toBe("approved");
    // No spurious statusHistory entry for the refused flip.
    const history = (store.getArtifacts().find((a) => a.id === "art_1") as { statusHistory?: Array<{ status: string }> }).statusHistory ?? [];
    expect(history.filter((h) => h.status === "rejected")).toHaveLength(0);
  });

  it("allows a same-verdict re-assert and draft→terminal", () => {
    store.createArtifact({ id: "art_2", type: "research", title: "t", content: {} });
    store.updateArtifactStatus("art_2", "approved", "ui_approve_button");
    store.updateArtifactStatus("art_2", "approved", "ui_approve_button"); // idempotent
    expect(store.getArtifacts().find((a) => a.id === "art_2")?.status).toBe("approved");
  });
});

describe("O3 (#231) — HTTP route 409 + refresh", () => {
  it("returns actionable 409s, preserves verdict feedback, and emits no success when proposal content changed during review", async () => {
    store.createArtifact({
      id: "art_changed",
      type: "plan",
      title: "Review this plan",
      content: { steps: [{ title: "Original proposal", status: "pending" }], estimatedChanges: 1 },
    });
    store.forceFlush();
    const contentWriter = fx.track(new FileStore(fx.dir, "test_session"));
    const changed = contentWriter.getArtifacts()[0]!;
    changed.content = {
      steps: [{ title: "Unseen replacement", action: "delete production data", status: "pending" }],
      estimatedChanges: 12,
    };
    changed.version = 2;
    contentWriter.renameArtifact("art_changed", changed.title);
    contentWriter.forceFlush();
    broadcasts.length = 0;

    const res = await postStatus("art_changed", "approved", "Keep the useful rationale even though the verdict raced");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "session_review_conflict" });
    expect(broadcasts.find((event) => event.type === "artifact_updated")).toBeUndefined();

    const recovered = fx.track(new FileStore(fx.dir, "test_session"));
    const persisted = recovered.getArtifacts()[0]!;
    expect(persisted).toMatchObject({ status: "draft", version: 2 });
    expect(recovered.getCommentsForArtifact("art_changed").map((comment) => comment.content)).toContain(
      "Keep the useful rationale even though the verdict raced",
    );

    const state = await app.request("/api/state");
    expect(state.status).toBe(409);
    expect(await state.json()).toMatchObject({
      code: "session_review_conflict",
      message: expect.stringMatching(/restart.*review/i),
    });
  });

  it("THE RACE: approved then a stale reject → 409, verdict preserved, truth re-broadcast", async () => {
    store.createArtifact({ id: "art_r", type: "research", title: "t", content: {} });
    const ok = await postStatus("art_r", "approved");
    expect(ok.status).toBe(200);
    broadcasts.length = 0;

    const res = await postStatus("art_r", "rejected", "changed my mind");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("verdict_already_final");
    expect(body.currentStatus).toBe("approved");

    // The verdict is preserved.
    expect(store.getArtifacts().find((a) => a.id === "art_r")?.status).toBe("approved");
    // The stale tab is refreshed to the TRUE status (not the attempted reject).
    const refresh = broadcasts.find((b) => b.type === "artifact_updated");
    expect(refresh).toMatchObject({ artifactId: "art_r", status: "approved" });
  });

  it("draft→approved is unaffected (200) and a same-verdict re-assert is not a 409", async () => {
    store.createArtifact({ id: "art_ok", type: "research", title: "t", content: {} });
    expect((await postStatus("art_ok", "approved")).status).toBe(200);
    // Re-asserting the SAME verdict is idempotent, not a conflict.
    expect((await postStatus("art_ok", "approved")).status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_ok")?.status).toBe("approved");
  });

  it("an AGENT supersede after a human approve is NOT blocked (revise lifecycle intact)", () => {
    store.createArtifact({ id: "art_s", type: "plan", title: "t", content: { steps: [] } });
    store.updateArtifactStatus("art_s", "approved", "ui_approve_button");
    // The agent supersedes with a v2 — a non-human reason, so it flows through.
    store.updateArtifactStatus("art_s", "superseded", "agent_supersede");
    expect(store.getArtifacts().find((a) => a.id === "art_s")?.status).toBe("superseded");
  });

  it("J1 decision-resolve still flips a draft decision to approved", async () => {
    store.createArtifact({
      id: "art_dec",
      type: "decision",
      title: "Which hash?",
      content: { decisionId: "dec_1", question: "Which hash?", options: [{ id: "opt_a", title: "argon2id" }] },
    });
    const res = await app.request("/api/decisions/dec_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "opt_a", reasoning: "modern" }),
    });
    expect(res.status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_dec")?.status).toBe("approved");
  });

  it("returns 409 and emits no decision success when the backing artifact changed", async () => {
    const option = {
      id: "opt_a", title: "Redis", description: "Shared cache", pros: ["fast"], cons: ["ops"],
      effort: "low" as const, risk: "low" as const, recommendation: true,
    };
    store.createArtifact({
      id: "art_dec_race",
      type: "decision",
      title: "Which cache?",
      content: { decisionId: "dec_race", question: "Which cache?", options: [option] },
    });
    store.recordDecisionRequest({
      decisionId: "dec_race", artifactId: "art_dec_race", context: "Which cache?", options: [option],
    });
    store.forceFlush();

    const contentWriter = fx.track(new FileStore(fx.dir, "test_session"));
    const changed = contentWriter.getArtifacts()[0]!;
    changed.content = { decisionId: "dec_race", question: "Which queue?", options: [option] };
    changed.version = 2;
    contentWriter.renameArtifact("art_dec_race", changed.title);
    contentWriter.forceFlush();
    broadcasts.length = 0;

    const res = await app.request("/api/decisions/dec_race", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "opt_a", reasoning: "Fits the old cache question" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "session_review_conflict" });
    expect(broadcasts.find((event) => event.type === "decision_resolved")).toBeUndefined();

    const recovered = fx.track(new FileStore(fx.dir, "test_session"));
    expect(recovered.getArtifacts()[0]).toMatchObject({ status: "draft", version: 2 });
    expect(recovered.getDecisionResponse("dec_race")).toBeNull();
  });
});

/**
 * P3 — the decision-resolve route's NO-RECORD fallback used to report a
 * resolution the store had refused. When the daemon's decisions map lacks the
 * record (X6), the route advances the artifact itself via
 * updateArtifactStatus(…, "approved", "ui_decision_resolve") — which the O3
 * store backstop REFUSES (log-only `return`) on an artifact already at a
 * different terminal verdict. The route nonetheless broadcast
 * `decision_resolved` and answered 200 {status:"resolved"}: a silent success on
 * a write that never landed. It now mirrors the verdict route: 409
 * verdict_already_final + a refresh broadcast of the REAL status.
 */
describe("P3 — decision-resolve no-record fallback is honest about a refused write", () => {
  const seedRecordlessDecision = (status?: "rejected" | "revised") => {
    store.createArtifact({
      id: "art_nr",
      type: "decision",
      title: "Which hash?",
      content: { decisionId: "dec_nr", question: "Which hash?", options: [{ id: "opt_a", title: "argon2id" }] },
    });
    if (status) store.updateArtifactStatus("art_nr", status, status === "rejected" ? "ui_reject_button" : "ui_revise_button");
  };
  const resolve = () =>
    app.request("/api/decisions/dec_nr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId: "opt_a", reasoning: "modern" }),
    });

  it("THE CASE: the whole card was already REJECTED in another tab → 409, no false resolve", async () => {
    seedRecordlessDecision("rejected");
    broadcasts.length = 0;

    const res = await resolve();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("verdict_already_final");
    expect(body.currentStatus).toBe("rejected");

    // The refused write did not land, and no resolution was announced.
    expect(store.getArtifacts().find((a) => a.id === "art_nr")?.status).toBe("rejected");
    expect(broadcasts.find((b) => b.type === "decision_resolved")).toBeUndefined();
    // The stale tab is refreshed to the TRUE status.
    expect(broadcasts.find((b) => b.type === "artifact_updated")).toMatchObject({
      artifactId: "art_nr",
      status: "rejected",
    });
  });

  it("an already-REVISED decision card is refused the same way", async () => {
    seedRecordlessDecision("revised");
    const res = await resolve();
    expect(res.status).toBe(409);
    expect((await res.json()).currentStatus).toBe("revised");
  });

  it("draft → resolve still succeeds, and a re-resolve of an approved card is not a 409", async () => {
    seedRecordlessDecision();
    expect((await resolve()).status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_nr")?.status).toBe("approved");
    // Same-verdict re-assert (a double-click / retry) stays idempotent.
    expect((await resolve()).status).toBe(200);
    expect(store.getArtifacts().find((a) => a.id === "art_nr")?.status).toBe("approved");
  });
});

/**
 * #338 (F5) — the failed-verdict contract on an ALREADY-frozen writer. The
 * first conflict (above) is detected at flush time: the feedback comment has
 * already been recorded and survives. Every verdict AFTER the freeze is refused
 * up front — before the status flip, before the comment, and before the
 * cross-project ledger — so a rejection that meets a 409 never records a
 * rejection stance. docs/troubleshooting.md states exactly this.
 */
describe("#338 (F5) — a verdict on a frozen writer records no ledger stance", () => {
  it("refuses a reject-with-feedback with 409, no stance, no status flip, no broadcast", async () => {
    store.createArtifact({
      id: "art_frozen", type: "plan", title: "Review this plan",
      content: { steps: [{ title: "Original proposal", status: "pending" }], estimatedChanges: 1 },
    });
    store.forceFlush();
    const contentWriter = fx.track(new FileStore(fx.dir, "test_session"));
    const changed = contentWriter.getArtifacts()[0]!;
    changed.content = { steps: [{ title: "Unseen replacement", status: "pending" }], estimatedChanges: 12 };
    changed.version = 2;
    contentWriter.renameArtifact("art_frozen", changed.title);
    contentWriter.forceFlush();
    // Freeze the route's writer via the first (flush-detected) conflict.
    expect((await postStatus("art_frozen", "approved")).status).toBe(409);
    broadcasts.length = 0;

    const res = await postStatus("art_frozen", "rejected", "Do not delete production data");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "session_review_conflict" });
    expect(broadcasts).toEqual([]);

    const prefsPath = `${fx.dir}/.deeppairing/preferences.json`;
    const prefs = (await import("node:fs")).existsSync(prefsPath)
      ? JSON.parse((await import("node:fs")).readFileSync(prefsPath, "utf8")) as { rejectedApproaches?: unknown[] }
      : {};
    expect(prefs.rejectedApproaches ?? []).toEqual([]);
    const recovered = fx.track(new FileStore(fx.dir, "test_session"));
    expect(recovered.getArtifacts()[0]).toMatchObject({ id: "art_frozen", status: "draft", version: 2 });
    expect(recovered.getRejectedApproaches?.() ?? []).toEqual([]);
  });
});

/**
 * #460 — a stale card (a sibling session's decision resolved in another tab)
 * must not silently re-answer it. store.resolveDecision OVERWRITES a recorded
 * response, and the route answered 200: the human's real choice was lost.
 */
describe("#460 — decision-resolve refuses a stale card with the current truth", () => {
  const opts = [
    { id: "opt_a", title: "Redis", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: true },
    { id: "opt_b", title: "Postgres", description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: false },
  ];
  const seedDecision = () => {
    store.createArtifact({ id: "art_dec", type: "decision", title: "Which store?", content: { decisionId: "dec_s", question: "Which store?", options: opts } });
    store.recordDecisionRequest({ decisionId: "dec_s", artifactId: "art_dec", context: "Which store?", options: opts });
  };
  const resolve = (optionId: string) => app.request("/api/decisions/dec_s", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId }),
  });

  it("a DIFFERENT pick on an already-answered decision: 409 verdict_already_final, the first answer kept", async () => {
    seedDecision();
    expect((await resolve("opt_a")).status).toBe(200);
    broadcasts.length = 0;
    const res = await resolve("opt_b");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: "verdict_already_final", currentStatus: "approved", artifactId: "art_dec", resolution: { optionId: "opt_a" } });
    expect(body.message).toMatch(/already answered.*your pick wasn't applied; this card now shows the recorded answer/);
    expect(store.getDecisionResponse("dec_s")?.optionId).toBe("opt_a");
    expect(broadcasts.find((e) => e.type === "decision_resolved")).toBeUndefined();
  });

  it("the SAME pick again is a TRUE no-op 200: reasoning and resolvedAt unchanged, nothing broadcast", async () => {
    seedDecision();
    const first = await app.request("/api/decisions/dec_s", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: "opt_a", reasoning: "first" }),
    });
    expect(first.status).toBe(200);
    const before = store.getDecision("dec_s")!.resolvedAt;
    broadcasts.length = 0;
    await new Promise((r) => setTimeout(r, 5));
    const again = await app.request("/api/decisions/dec_s", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: "opt_a", reasoning: "second" }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyResolved: true, resolution: { optionId: "opt_a", reasoning: "first" } });
    expect(store.getDecisionResponse("dec_s")?.reasoning).toBe("first");
    expect(store.getDecision("dec_s")!.resolvedAt).toBe(before);
    expect(broadcasts.find((e) => e.type === "decision_resolved")).toBeUndefined();
  });

  it("a pick on a decision REJECTED elsewhere: 409 with currentStatus rejected, no answer recorded", async () => {
    seedDecision();
    store.updateArtifactStatus("art_dec", "rejected", "ui_reject_button");
    const res = await resolve("opt_a");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "verdict_already_final", currentStatus: "rejected" });
    expect(store.getDecisionResponse("dec_s")).toBeNull();
  });
});

/**
 * #464 (Astra concurrency review) — OVERLAPPING resolves. The stale-resolve
 * check used to be a multi-await snapshot taken before a separate write: two
 * overlapping requests both saw "unanswered", both wrote, and the loser got a
 * false 400 ("not an option"). Check-and-resolve is now one atomic store
 * operation; exactly one request writes and every other one gets the winner.
 */
describe("#464 — concurrent decision resolves (public route)", () => {
  const letters = "abcdefgh".split("");
  const opts = letters.map((l) => ({ id: l, title: l.toUpperCase(), description: "d", pros: [], cons: [], effort: "low" as const, risk: "low" as const, recommendation: false }));
  const seed = () => {
    store.createArtifact({ id: "art_race", type: "decision", title: "Which?", content: { decisionId: "dec_race2", question: "Which?", options: opts } });
    store.recordDecisionRequest({ decisionId: "dec_race2", artifactId: "art_race", context: "Which?", options: opts });
  };
  const post = (optionId: string) => app.request("/api/decisions/dec_race2", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId, reasoning: `reason-${optionId}` }),
  });

  it("Astra's repro — Promise.all(a, b): exactly one write, one 200, one 409 carrying the winner", async () => {
    seed();
    const writes = vi.spyOn(store, "resolveDecision");
    const [ra, rb] = await Promise.all([post("a"), post("b")]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(writes).toHaveBeenCalledTimes(1);
    const winner = ra.status === 200 ? "a" : "b";
    const loser = ra.status === 200 ? rb : ra;
    expect(await loser.json()).toMatchObject({ code: "verdict_already_final", resolution: { optionId: winner, reasoning: `reason-${winner}` } });
    expect(store.getDecisionResponse("dec_race2")).toMatchObject({ optionId: winner, reasoning: `reason-${winner}` });
    expect(broadcasts.filter((e) => e.type === "decision_resolved")).toHaveLength(1);
  });

  it("an identical-choice concurrent retry: both 200, one write, the second a no-op carrying the first's reasoning", async () => {
    seed();
    const writes = vi.spyOn(store, "resolveDecision");
    const [r1, r2] = await Promise.all([post("a"), post("a")]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(writes).toHaveBeenCalledTimes(1);
    const bodies = [await r1.json(), await r2.json()];
    expect(bodies.filter((b) => b.alreadyResolved)).toHaveLength(1);
    expect(store.getDecisionResponse("dec_race2")?.reasoning).toBe("reason-a");
  });

  it("8 concurrent DIFFERENT choices: exactly one 200 and one write; seven 409s all naming the same winner", async () => {
    seed();
    const writes = vi.spyOn(store, "resolveDecision");
    const res = await Promise.all(letters.map((l) => post(l)));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(writes).toHaveBeenCalledTimes(1);
    const winner = letters[statuses.indexOf(200)]!;
    for (const r of res.filter((x) => x.status === 409)) {
      expect((await r.json()).resolution?.optionId).toBe(winner);
    }
    expect(store.getDecisionResponse("dec_race2")?.optionId).toBe(winner);
  });
});
