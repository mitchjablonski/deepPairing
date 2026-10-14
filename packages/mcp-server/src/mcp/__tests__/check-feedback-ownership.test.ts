/**
 * #533 — check_feedback ownership routing + crash-safe hand-off.
 *
 * Subagents share the parent's MCP connection (one session bucket), so an
 * unfiltered check_feedback used to hand a subagent's answer to whichever
 * agent polled next — and it acknowledged each lane BEFORE the response was
 * finished, so a throw (or a cancelled call) after that point lost the
 * feedback for good. Fakes not mocks: real FileStore, real MCP server + tool
 * handlers over an in-memory transport; the "crash" is a FileStore subclass
 * whose post-selection read throws once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import { LIVE_POLL_GRACE_MS } from "../tools/feedback-ownership.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { SERVER_VERSION } from "../../version.js";

let fx: GlobalStoreFixture;
beforeEach(() => {
  fx = withGlobalStore("dp-cf-owner-");
});
afterEach(() => {
  vi.useRealTimers();
  fx.dispose();
});

/** A FileStore whose plan-review read (which runs AFTER the handler has
 *  selected — and, pre-#533, acknowledged — the comments) throws once. */
class CrashOnceStore extends FileStore {
  crashNext = false;
  override getPendingPlanReviews() {
    if (this.crashNext) {
      this.crashNext = false;
      throw new Error("injected crash after the selection step");
    }
    return super.getPendingPlanReviews();
  }
}

function directCtx(store: FileStore, signal?: AbortSignal): ToolContext {
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
    ...(signal ? { signal } : {}),
  } as unknown as ToolContext;
}

async function connect(store: FileStore) {
  const { server } = createMcpServer(store, () => {}, 4000);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = ((r.content as Array<{ type: string; text?: string }>) ?? [])
      .map((b) => b.text ?? "")
      .join("");
    return { text, isError: r.isError, sc: (r as { structuredContent?: Record<string, any> }).structuredContent ?? {} };
  };
}

const OPTIONS = (p: string) => [
  { id: "a", title: `${p} Redis`, description: "network cache", pros: ["fast"], cons: ["ops"], effort: "medium", risk: "medium", recommendation: true, concept: { name: `${p} redis cache` } },
  { id: "b", title: `${p} LRU`, description: "heap cache", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false, concept: { name: `${p} lru cache` } },
];

const commentIds = (sc: Record<string, any>) =>
  [...(sc.comments ?? []), ...(sc.questions ?? [])].map((c: any) => c.id ?? c.commentId).sort();
const decisionArtifacts = (sc: Record<string, any>) => (sc.decisions ?? []).map((d: any) => d.artifactId).sort();

describe("#533 routing — presentedBy + check_feedback filter", () => {
  it("a filtered poll returns and acks ONLY its own feedback; a live consumer's is held (status held), then orphans reach the coordinator after the grace window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
    const store = fx.track(new FileStore(fx.dir, "own_s1"));
    const call = await connect(store);

    await call("present_options", { context: "Cache for A?", title: "A cache", options: OPTIONS("A"), presentedBy: "builder:a" });
    await call("present_options", { context: "Cache for B?", title: "B cache", options: OPTIONS("B"), presentedBy: "builder:b" });
    // The coordinator's own (unlabelled) work.
    await call("present_findings", { summary: "coord audit", findings: [{ category: "c", detail: "d", significance: "low" }] });
    const arts = store.getArtifacts();
    const artA = arts.find((a) => a.title === "A cache")!;
    const artB = arts.find((a) => a.title === "B cache")!;
    const artC = arts.find((a) => a.type === "research")!;
    expect(artA.presentedBy).toBe("builder:a");
    expect(artB.presentedBy).toBe("builder:b");
    expect(artC.presentedBy).toBeUndefined();

    // builder:b polls once (it has an immediate comment, so no long-poll) → live.
    store.addComment({ id: "cmt_b0", artifactId: artB.id, content: "B: early note", author: "human", target: { artifactId: artB.id } });
    const b0 = await call("check_feedback", { presentedBy: "builder:b" });
    expect(commentIds(b0.sc)).toEqual(["cmt_b0"]);

    for (const d of store.getPendingDecisions()) store.resolveDecision(d.decisionId, "a", "pick a");
    store.addComment({ id: "cmt_a", artifactId: artA.id, content: "A: watch the TTL", author: "human", target: { artifactId: artA.id } });
    store.addComment({ id: "cmt_b", artifactId: artB.id, content: "B: watch eviction", author: "human", target: { artifactId: artB.id } });
    store.addComment({ id: "cmt_c", artifactId: artC.id, content: "coord: good audit", author: "human", target: { artifactId: artC.id } });
    store.addComment({ id: "cmt_dir", artifactId: "__session__", content: "focus on auth", author: "human" });

    // Subagent A polls filtered: only A's comment + A's decision.
    const a = await call("check_feedback", { presentedBy: "builder:a" });
    expect(a.isError).toBeFalsy();
    expect(commentIds(a.sc)).toEqual(["cmt_a"]);
    expect(decisionArtifacts(a.sc)).toEqual([artA.id]);
    expect(a.sc.filter).toEqual({ presentedBy: "builder:a" });
    expect(a.text).not.toContain("B: watch eviction");
    expect(a.text).not.toContain("focus on auth");
    expect(store.getUnacknowledgedComments().map((c) => c.id).sort()).toEqual(["cmt_b", "cmt_c", "cmt_dir"]);
    expect(store.getResolvedDecisions().map((d) => d.artifactId)).toEqual([artB.id]);

    // The coordinator polls UNFILTERED within builder:b's grace window: its own
    // comment + the directive, and B's feedback is HELD — and said so.
    const coord = await call("check_feedback");
    expect(commentIds(coord.sc)).toEqual(["cmt_c", "cmt_dir"]);
    expect(decisionArtifacts(coord.sc)).toEqual([]);
    expect(coord.sc.heldBackFor).toEqual(["builder:b"]);
    expect(coord.sc.held).toEqual([expect.objectContaining({ label: "builder:b", count: 3, decisions: 1, comments: 1 })]);
    expect(coord.text).toContain('1 decision, 1 comment, 1 status change held for "builder:b"');
    expect(store.getUnacknowledgedComments().map((c) => c.id)).toEqual(["cmt_b"]);

    // builder:b went quiet past the grace window → orphans reach the coordinator.
    vi.setSystemTime(new Date(Date.now() + LIVE_POLL_GRACE_MS + 1000));
    const orphan = await call("check_feedback");
    expect(commentIds(orphan.sc)).toEqual(["cmt_b"]);
    expect(decisionArtifacts(orphan.sc)).toEqual([artB.id]);
    expect(orphan.sc.heldBackFor).toBeUndefined();
    expect(store.getUnacknowledgedComments()).toEqual([]);
    expect(store.getResolvedDecisions()).toEqual([]);
  });

  it("a presenter that exits without polling reserves nothing: its decision reaches the coordinator at once", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_exit0"));
    const call = await connect(store);
    await call("present_options", { context: "Cache?", title: "X cache", options: OPTIONS("X"), presentedBy: "builder:x" });
    for (const d of store.getPendingDecisions()) store.resolveDecision(d.decisionId, "a", "go");
    const coord = await call("check_feedback");
    expect(coord.sc.decisions).toHaveLength(1);
    expect(coord.sc.status).not.toBe("held");
  });

  it("a presenter that polled then exited: the coordinator sees status 'held' (never 'proceed'), then gets the decision within the short grace window, not 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
    const store = fx.track(new FileStore(fx.dir, "own_exit1"));
    const call = await connect(store);
    await call("present_options", { context: "Cache?", title: "X cache", options: OPTIONS("X"), presentedBy: "builder:x" });
    const art = store.getArtifacts()[0]!;
    store.addComment({ id: "cmt_x0", artifactId: art.id, content: "first", author: "human", target: { artifactId: art.id } });
    await call("check_feedback", { presentedBy: "builder:x" }); // then the builder exits
    for (const d of store.getPendingDecisions()) store.resolveDecision(d.decisionId, "a", "go");

    const held = await call("check_feedback");
    expect(held.sc.status).toBe("held");
    expect(held.sc.decisions).toEqual([]);
    expect(held.sc.suggestedAction).toContain('1 decision, 1 status change held for "builder:x"');
    expect(held.text).not.toContain("You may proceed with implementation.");
    expect(held.sc.held[0].releaseInSec).toBeLessThanOrEqual(LIVE_POLL_GRACE_MS / 1000);

    vi.setSystemTime(new Date(Date.now() + LIVE_POLL_GRACE_MS + 1000));
    const released = await call("check_feedback");
    expect(released.sc.decisions).toHaveLength(1);
    expect(released.sc.status).not.toBe("held");
    expect(LIVE_POLL_GRACE_MS).toBeLessThanOrEqual(60_000);
  });

  it("an artifactIds-only consumer is protected like a label: its artifacts are reserved while it is live", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_ids"));
    const call = await connect(store);
    await call("present_findings", { title: "X audit", summary: "x", findings: [{ category: "c", detail: "d", significance: "low" }] });
    const x = store.getArtifacts()[0]!;
    store.updateArtifactStatus(x.id, "approved");
    store.addComment({ id: "cmt_x0", artifactId: x.id, content: "first", author: "human", target: { artifactId: x.id } });
    const sub0 = await call("check_feedback", { artifactIds: [x.id] });
    expect(commentIds(sub0.sc)).toEqual(["cmt_x0"]);

    store.addComment({ id: "cmt_x1", artifactId: x.id, content: "for the subagent", author: "human", target: { artifactId: x.id } });
    const coord = await call("check_feedback");
    expect(commentIds(coord.sc)).toEqual([]);
    expect(coord.sc.heldBackFor).toEqual([`artifacts ${x.id}`]);
    expect(coord.sc.status).toBe("held");
    expect(store.getUnacknowledgedComments().map((c) => c.id)).toEqual(["cmt_x1"]);

    const sub1 = await call("check_feedback", { artifactIds: [x.id] });
    expect(commentIds(sub1.sc)).toEqual(["cmt_x1"]);
  });

  it("artifactIds filters follow revisions; revise_artifact carries presentedBy", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_s2"));
    const call = await connect(store);
    await call("present_findings", { title: "B audit", summary: "b", findings: [{ category: "c", detail: "d", significance: "low" }], presentedBy: "reviewer" });
    const v1 = store.getArtifacts()[0]!;
    const rev = await call("revise_artifact", { artifactId: v1.id, mode: "supersede", reason: "tighten", content: { summary: "b2", findings: [{ category: "c", detail: "d2", significance: "low" }] } });
    expect(rev.isError, rev.text).toBeFalsy();
    const v2 = store.getArtifacts().find((a) => a.parentId === v1.id);
    expect(v2?.presentedBy).toBe("reviewer");
    store.addComment({ id: "cmt_v2", artifactId: v2!.id, content: "on v2", author: "human", target: { artifactId: v2!.id } });
    store.addComment({ id: "cmt_other", artifactId: "__session__", content: "not yours", author: "human" });

    const byId = await call("check_feedback", { artifactIds: [v1.id] });
    expect(commentIds(byId.sc)).toEqual(["cmt_v2"]);
    expect(store.getUnacknowledgedComments().map((c) => c.id)).toEqual(["cmt_other"]);
  });

  it("a filtered long-poll wakes only for its OWN feedback", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_wake"));
    const call = await connect(store);
    await call("present_options", { context: "Cache for A?", title: "A cache", options: OPTIONS("A"), presentedBy: "builder:a" });
    await call("present_findings", { title: "B audit", summary: "b", findings: [{ category: "c", detail: "d", significance: "low" }], presentedBy: "builder:b" });
    const artA = store.getArtifacts().find((a) => a.presentedBy === "builder:a")!;
    const artB = store.getArtifacts().find((a) => a.presentedBy === "builder:b")!;
    const poll = call("check_feedback", { presentedBy: "builder:a" });
    await new Promise((r) => setTimeout(r, 100));
    store.addComment({ id: "cmt_b", artifactId: artB.id, content: "for B", author: "human", target: { artifactId: artB.id } });
    await new Promise((r) => setTimeout(r, 400));
    store.addComment({ id: "cmt_a", artifactId: artA.id, content: "for A", author: "human", target: { artifactId: artA.id } });
    const a = await poll;
    expect(commentIds(a.sc)).toEqual(["cmt_a"]);
    expect(store.getUnacknowledgedComments().map((c) => c.id)).toEqual(["cmt_b"]);
  });
});

describe("#533 claims — concurrent polls never double-deliver", () => {
  async function seeded(name: string) {
    const store = fx.track(new FileStore(fx.dir, name));
    const call = await connect(store);
    await call("present_findings", { title: "Audit", summary: "s", findings: [{ category: "c", detail: "d", significance: "low" }], presentedBy: "builder:a" });
    const art = store.getArtifacts()[0]!;
    store.updateArtifactStatus(art.id, "approved");
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    for (const id of ids) store.addComment({ id, artifactId: art.id, content: `note ${id}`, author: "human", target: { artifactId: art.id } });
    return { store, call, ids };
  }

  for (const [label, argsA, argsB] of [
    ["same-label filtered polls", { presentedBy: "builder:a" }, { presentedBy: "builder:a" }],
    ["filtered vs unfiltered", { presentedBy: "builder:a" }, {}],
    ["two unfiltered polls", {}, {}],
  ] as const) {
    it(label, async () => {
      for (let round = 0; round < 5; round++) {
        const { store, call, ids } = await seeded(`own_cc_${label.length}_${round}`);
        const [r1, r2] = await Promise.all([call("check_feedback", { ...argsA }), call("check_feedback", { ...argsB })]);
        const got = [...commentIds(r1.sc), ...commentIds(r2.sc)];
        expect(new Set(got).size, `round ${round}: ${got.join(",")}`).toBe(got.length);
        // Whatever neither delivered is still unacknowledged (not lost).
        const left = store.getUnacknowledgedComments().map((c) => c.id);
        expect([...got, ...left].sort()).toEqual([...ids].sort());
      }
    });
  }
});

describe("#533 unfiltered poll is unchanged", () => {
  // GOLDEN — captured on main (pre-#533) for this exact scenario: artifacts
  // created straight on the store (some carrying a presentedBy label, which
  // main ignores) with no live presenter in the poller's state. The
  // unfiltered output must stay byte-identical. The broader 15-scenario byte
  // pin is check-feedback-golden-parity.test.ts, untouched by #533.
  const GOLDEN = {
    prose: "6556cf94216f1c42269a36a8865778a40382cff9e0bd419eee3bc176ffc8bcb3",
    struct: "7e0436583b7b95f3ab2f0c73c48104dbf3119411e90092a265e93b7602f2876c",
  };
  it("prose + structuredContent byte-identical to main", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const store = fx.track(new FileStore(fx.dir, "own_golden"));
    store.createArtifact({ id: "art_1", type: "research", title: "Audit", content: { summary: "s", findings: [] }, presentedBy: "builder:x" } as never);
    store.createArtifact({ id: "art_2", type: "spec", title: "Spec", content: { summary: "s", requirements: [] } });
    store.addComment({ id: "cmt_1", artifactId: "art_1", content: "first", author: "human", target: { artifactId: "art_1" } });
    store.addComment({ id: "cmt_2", artifactId: "art_2", content: "why?", author: "human", intent: "question", target: { artifactId: "art_2" } });
    store.addComment({ id: "cmt_3", artifactId: "__session__", content: "directive", author: "human" });
    const res = await handleCheckFeedback(directCtx(store), {});
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const prose = res.content[0]!.text.split(SERVER_VERSION).join("<version>");
    const struct = JSON.stringify({ ...res.structuredContent, serverVersion: "<version>" });
    expect(sha(prose), prose).toBe(GOLDEN.prose);
    expect(sha(struct), struct).toBe(GOLDEN.struct);
    expect(store.getUnacknowledgedComments()).toEqual([]);
  });
});

describe("#533 crash-safe hand-off", () => {
  function seed(store: FileStore) {
    store.createArtifact({ id: "art_r", type: "research", title: "Audit", content: { summary: "s", findings: [] } });
    // Approved, so an empty poll returns at once instead of long-polling 30s.
    store.updateArtifactStatus("art_r", "approved");
    store.addComment({ id: "cmt_x", artifactId: "art_r", content: "please re-check", author: "human", target: { artifactId: "art_r" } });
    store.addComment({ id: "cmt_d", artifactId: "__session__", content: "stop touching auth", author: "human" });
  }

  it("a crash after the selection step re-delivers the same items, with the same ids, on the next poll", async () => {
    const store = fx.track(new CrashOnceStore(fx.dir, "own_crash"));
    seed(store);
    store.crashNext = true;
    const ctx = directCtx(store);
    await expect(handleCheckFeedback(ctx, {})).rejects.toThrow("injected crash");
    // Nothing was acknowledged by the poll that died.
    expect(store.getUnacknowledgedComments().map((c) => c.id).sort()).toEqual(["cmt_d", "cmt_x"]);

    const retry = await handleCheckFeedback(ctx, {});
    const ids = (retry.structuredContent!.comments as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual(["cmt_d", "cmt_x"]);
    expect(retry.content[0]!.text).toContain("stop touching auth");
    expect(store.getUnacknowledgedComments()).toEqual([]);
  });

  it("a cancelled call acknowledges nothing", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_abort"));
    seed(store);
    const ac = new AbortController();
    ac.abort();
    await handleCheckFeedback(directCtx(store, ac.signal), {});
    expect(store.getUnacknowledgedComments().map((c) => c.id).sort()).toEqual(["cmt_d", "cmt_x"]);
  });

  it("no double delivery after a confirmed ACK", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_once"));
    seed(store);
    const ctx = directCtx(store);
    const first = await handleCheckFeedback(ctx, {});
    expect((first.structuredContent!.comments as unknown[]).length).toBe(2);
    const second = await handleCheckFeedback(ctx, {});
    expect(second.structuredContent!.comments).toEqual([]);
    expect(second.content[0]!.text).not.toContain("please re-check");
  });

  it("an unanswered artifact question still re-delivers (carryover), filtered or not", async () => {
    const store = fx.track(new FileStore(fx.dir, "own_q"));
    store.createArtifact({ id: "art_q", type: "research", title: "Audit", content: { summary: "s", findings: [] }, presentedBy: "builder:q" } as never);
    store.updateArtifactStatus("art_q", "approved");
    store.addComment({ id: "cmt_q", artifactId: "art_q", content: "why this?", author: "human", intent: "question", target: { artifactId: "art_q" } });
    const ctx = directCtx(store);
    const first = await handleCheckFeedback(ctx, { presentedBy: "builder:q" });
    expect((first.structuredContent!.questions as Array<{ commentId?: string; id?: string }>).map((q) => q.commentId ?? q.id)).toEqual(["cmt_q"]);
    const again = await handleCheckFeedback(ctx, { presentedBy: "builder:q" });
    expect((again.structuredContent!.unansweredCarryover as Array<{ commentId: string }>).map((q) => q.commentId)).toEqual(["cmt_q"]);
    const coordinator = await handleCheckFeedback(ctx, {});
    expect((coordinator.structuredContent!.unansweredCarryover as Array<{ commentId: string }>).map((q) => q.commentId)).toEqual(["cmt_q"]);
  });
});
