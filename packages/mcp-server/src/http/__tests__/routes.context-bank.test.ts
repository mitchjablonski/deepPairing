// The context bank's HTTP surface: GET /api/context-bank (the cross-project
// read-model) and POST /api/decisions/:decisionId/close-out (the triage
// affordance's backend).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionOption } from "@deeppairing/shared";
import { setProjectRegistryPathForTests, upsertProject } from "../../store/project-registry.js";
import { clearContextBankCache, BANK_FRESH_FLOOR_MS } from "../../store/context-bank.js";
import { createHttpRoutes } from "../routes.js";
import { createRoutesTestContext, destroyRoutesTestContext, withHash, type RoutesTestContext } from "./routes.harness.js";

let ctx: RoutesTestContext;
let registryTmp: string;

const OPTS: DecisionOption[] = [
  { id: "o1", title: "Redis", description: "d", pros: ["fast"], cons: ["ops"], effort: "low", risk: "low", recommendation: true },
  { id: "o2", title: "In-proc", description: "d", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
];

beforeEach(() => {
  ctx = createRoutesTestContext();
  registryTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-bank-routes-"));
  setProjectRegistryPathForTests(path.join(registryTmp, "projects.json"));
  clearContextBankCache();
});

afterEach(() => {
  destroyRoutesTestContext(ctx);
  setProjectRegistryPathForTests(null);
  clearContextBankCache();
  fs.rmSync(registryTmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * An app whose store GETTER returns null for every session — the daemon's real
 * shape once a session has been unregistered. The harness's default app hands
 * back one live store for any sessionId, which can never exercise the
 * dead-session (transient FileStore) path.
 */
function appWithNoLiveStores(): ReturnType<typeof createHttpRoutes> {
  return withHash(createHttpRoutes(() => null, ctx.tmpDir, () => {}), ctx.tmpDir);
}

/** Put an unresolved decision + its backing artifact in the bound session. */
function seedOpenDecision(id = "d1", artifactId = "a1"): void {
  ctx.store.createArtifact({ id: artifactId, type: "decision", title: "Which cache?", content: {} });
  ctx.store.recordDecisionRequest({ decisionId: id, artifactId, context: "Which cache?", options: OPTS, stakes: "high" });
  ctx.store.forceFlush();
}

describe("GET /api/context-bank", () => {
  it("returns the empty-but-well-formed shape when the registry knows nothing", async () => {
    const res = await ctx.app.request("/api/context-bank");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([]);
    expect(body.totals).toMatchObject({ projects: 0, sessions: 0, openDecisions: 0, needsYou: 0 });
    expect(typeof body.generatedAt).toBe("string");
  });

  it("surfaces this project's open decision once it is in the registry", async () => {
    seedOpenDecision();
    upsertProject(ctx.tmpDir);

    const res = await ctx.app.request("/api/context-bank?fresh=1");
    const body = await res.json();
    expect(body.projects).toHaveLength(1);
    const project = body.projects[0];
    expect(project.projectRoot).toBe(path.resolve(ctx.tmpDir));
    const session = project.sessions.find((s: { sessionId: string }) => s.sessionId === "test_session");
    expect(session.openDecisionCount).toBe(1);
    expect(session.openDecisions[0]).toMatchObject({ decisionId: "d1", stakes: "high" });
    expect(session.salience).toContain("needs-you");
    // Honesty grade rides along on every card.
    expect(["rich", "medium", "thin"]).toContain(session.derivationQuality);
    expect(body.totals.openDecisions).toBe(1);
  });

  it("?fresh=1 reflects a mutation the cached read would not", async () => {
    upsertProject(ctx.tmpDir);
    const before = await (await ctx.app.request("/api/context-bank")).json();
    expect(before.totals.openDecisions).toBe(0);

    seedOpenDecision();
    // The cache is intentionally sticky…
    expect((await (await ctx.app.request("/api/context-bank")).json()).totals.openDecisions).toBe(0);
    // …until asked for fresh data. (The route's fresh path has a 2s min-age
    // floor; `before` above was built by an earlier request in this test, which
    // is why the floor has to be waited out rather than assumed away.)
    await new Promise((r) => setTimeout(r, BANK_FRESH_FLOOR_MS + 50));
    expect((await (await ctx.app.request("/api/context-bank?fresh=1")).json()).totals.openDecisions).toBe(1);
  });
});

describe("the question lane, end to end (the rider)", () => {
  it("a question-composed comment becomes an unanswered question in the read-model", async () => {
    ctx.store.createArtifact({ id: "a1", type: "research", title: "Auth walk", content: {} });
    upsertProject(ctx.tmpDir);

    // Exactly what the Ask button now sends (web/src/stores/artifact.ts).
    const posted = await ctx.app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({
        artifactId: "a1",
        content: "Why does auth verify happen before the cache check?",
        target: { artifactId: "a1" },
        intent: "question",
      }),
    });
    expect(posted.status).toBe(200);
    ctx.store.forceFlush();

    const body = await (await ctx.app.request("/api/context-bank?fresh=1")).json();
    const session = body.projects[0].sessions.find((s: { sessionId: string }) => s.sessionId === "test_session");
    expect(session.unansweredQuestionCount).toBe(1);
    // WHOSE TURN — the question is owed BY the agent, so it belongs to the
    // waiting-on-agent lane and must stay out of the "what needs me" headline.
    expect(session.salience).toContain("waiting-on-agent");
    expect(session.salience).not.toContain("needs-you");
    expect(body.totals).toMatchObject({ needsYou: 0, waitingOnAgent: 1 });
  });

  it("the SAME comment posted WITHOUT intent stays invisible to the lane (the bug it fixes)", async () => {
    ctx.store.createArtifact({ id: "a1", type: "research", title: "Auth walk", content: {} });
    upsertProject(ctx.tmpDir);

    await ctx.app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({
        artifactId: "a1",
        content: "Why does auth verify happen before the cache check?",
        target: { artifactId: "a1" },
      }),
    });
    ctx.store.forceFlush();

    const body = await (await ctx.app.request("/api/context-bank?fresh=1")).json();
    const session = body.projects[0].sessions.find((s: { sessionId: string }) => s.sessionId === "test_session");
    expect(session.unansweredQuestionCount).toBe(0);
  });
});

describe("POST /api/decisions/:id/close-out", () => {
  it("retires the decision WITHOUT selecting an option", async () => {
    seedOpenDecision();

    const res = await ctx.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({ projectRoot: ctx.tmpDir }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "closed_out", artifactId: "a1", artifactStatus: "obsolete" });

    // The artifact reached the existing terminal status…
    const artifact = (await ctx.store.getArtifacts()).find((a) => a.id === "a1")!;
    expect(artifact.status).toBe("obsolete");
    // …and NOTHING was recorded as chosen.
    expect(await ctx.store.getDecisionResponse("d1")).toBeFalsy();
  });

  it("drops the decision out of the awaiting queue (/api/decisions closedUnresolved)", async () => {
    seedOpenDecision();
    await ctx.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({}),
    });

    const body = await (await ctx.app.request("/api/decisions")).json();
    const d = body.decisions.find((x: { decisionId: string }) => x.decisionId === "d1");
    expect(d.resolved).toBe(false);
    expect(d.closedUnresolved).toBe(true);
    expect(d.closedStatus).toBe("obsolete");
    expect(d.chosenOptionId).toBeUndefined();
  });

  it("400s cleanly for a decision owned by ANOTHER project (cross-project writes deferred)", async () => {
    seedOpenDecision();
    const res = await ctx.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({ projectRoot: path.join(os.tmpdir(), "some-other-project") }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("cross_project_close_out_unsupported");
    // The refusal must be total — nothing changed here.
    expect((await ctx.store.getArtifacts()).find((a) => a.id === "a1")!.status).toBe("draft");
  });

  it("records an optional human note as a comment on the card", async () => {
    seedOpenDecision();
    await ctx.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({ note: "A later card replaced this." }),
    });
    const comments = await ctx.store.getCommentsForArtifact("a1");
    expect(comments.map((c) => c.content)).toContain("A later card replaced this.");
  });

  it("refuses to close out a decision that was actually ANSWERED", async () => {
    seedOpenDecision();
    ctx.store.resolveDecision("d1", "o1", "lowest latency");
    ctx.store.forceFlush();

    const res = await ctx.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("decision_already_resolved");
    expect((await ctx.store.getDecisionResponse("d1"))!.optionId).toBe("o1");
  });

  it("is idempotent — a second close-out reports already_closed without a second history entry", async () => {
    seedOpenDecision();
    const send = () =>
      ctx.app.request("/api/decisions/d1/close-out", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
        body: JSON.stringify({}),
      });
    await send();
    const second = await send();
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("already_closed");

    const artifact = (await ctx.store.getArtifacts()).find((a) => a.id === "a1")!;
    const obsoleteEntries = (artifact.statusHistory ?? []).filter((h) => h.status === "obsolete");
    expect(obsoleteEntries).toHaveLength(1);
  });

  it("refuses to retire a NON-decision artifact a decision record points at", async () => {
    // The record and the artifacts are written by different processes over the
    // same files (X6), so a record whose artifactId has drifted onto another
    // artifact is reachable. Without the type check on the record path, this
    // flipped a PLAN to obsolete and returned 200.
    ctx.store.createArtifact({ id: "a_plan", type: "plan", title: "Rollout plan", content: {} });
    ctx.store.recordDecisionRequest({ decisionId: "d_bad", artifactId: "a_plan", context: "?", options: OPTS });
    ctx.store.forceFlush();

    const res = await ctx.app.request("/api/decisions/d_bad/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect((await ctx.store.getArtifacts()).find((a) => a.id === "a_plan")!.status).toBe("draft");
  });

  it("404s for a decision this session doesn't own", async () => {
    const res = await ctx.app.request("/api/decisions/d_nope/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("decision_not_in_session");
  });

  it("400s on a malformed body rather than 500ing", async () => {
    const res = await ctx.app.request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "test_session" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("never creates a session dir as a side effect of an unknown sessionId", async () => {
    // FileStore's constructor mkdirs its session dir, so an unguarded transient
    // store would CREATE an empty session as a side effect of a triage click.
    const res = await appWithNoLiveStores().request("/api/decisions/d1/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "never_existed" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(fs.existsSync(path.join(ctx.tmpDir, ".deeppairing", "sessions", "never_existed"))).toBe(false);
  });

  it("closes out a decision in a DEAD (unregistered) session through a transient store", async () => {
    // The stale decisions the bank surfaces mostly live in long-unregistered
    // rolling sessions, so this is the important path, not an edge case.
    const deadDir = path.join(ctx.tmpDir, ".deeppairing", "sessions", "dead_session");
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(
      path.join(deadDir, "artifacts.json"),
      JSON.stringify([{ id: "a_dead", version: 1, type: "decision", title: "Old fork", status: "draft", content: {}, createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" }]),
    );
    fs.writeFileSync(
      path.join(deadDir, "decisions.json"),
      JSON.stringify([{ decisionId: "d_dead", artifactId: "a_dead", context: "Old fork", options: OPTS, createdAt: "2026-05-01T00:00:00.000Z" }]),
    );

    const res = await appWithNoLiveStores().request("/api/decisions/d_dead/close-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "dead_session" }),
    });
    expect(res.status).toBe(200);

    const onDisk = JSON.parse(fs.readFileSync(path.join(deadDir, "artifacts.json"), "utf-8"));
    expect(onDisk[0].status).toBe("obsolete");
    // Still no fabricated choice.
    const decisionsOnDisk = JSON.parse(fs.readFileSync(path.join(deadDir, "decisions.json"), "utf-8"));
    expect(decisionsOnDisk[0].response).toBeUndefined();
  });
});
