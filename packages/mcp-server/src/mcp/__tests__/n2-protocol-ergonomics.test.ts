/**
 * N2 (#226) — "the protocol stops lying" batch. One file per scope, all driving
 * real FileStores / the real MCP server (fakes not mocks):
 *   1. present_* short-window content-hash de-dup (+ re-present-after-reject pin)
 *   2. honest too_big scalar error (title cap)
 *   3. present_options exposes the art_ id
 *   4. stale-arc annotation in the first-call hint
 *   5. self-heal companion-URL note in check_feedback
 *   6. answer_question doesn't echo the question it just answered
 *   1b. answer_question is idempotent on an identical re-answer
 *   1c. formatHandlerError's retry advice is honest for present_*
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { validatePresentOptionsInput, formatHandlerError } from "../validate-tool-input.js";
import { PresentIdempotencyRegistry, hashPresentArgs, getPassiveFeedback, buildDedupResponse } from "../tool-helpers.js";
import { buildFirstCallHint } from "../first-call-hint.js";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";

const FINDINGS = {
  title: "Dup finding",
  summary: "identical summary",
  findings: [{ category: "bug", detail: "identical detail", significance: "medium" }],
};
const validOption = (id: string, title: string) => ({
  id, title, description: "d", pros: ["p"], cons: ["c"], effort: "low", risk: "low", recommendation: false,
});

// -------------------- Scopes 1 / 1b / 3 (server integration) --------------------
describe("N2 present_* idempotency + present_options art_ id", () => {
  const ctx = setupServerTest();
  const callTool = makeCallTool(ctx);

  it("de-dups two identical present_findings into ONE draft artifact", async () => {
    const first = await callTool("present_findings", FINDINGS);
    expect(first.isError).toBeFalsy();
    const second = await callTool("present_findings", FINDINGS);
    expect(second.isError).toBeFalsy();
    expect(second.text).toContain("Already presented");
    expect((second.structuredContent as any)?.deduplicated).toBe(true);
    const research = (await ctx.store.getArtifacts()).filter((a) => a.type === "research");
    expect(research.length).toBe(1);
  });

  it("F5 — de-dups two identical present_debrief into ONE draft", async () => {
    const debrief = { title: "Wrap-up", summary: "we shipped it", sections: [{ title: "What", body: "did the thing" }] };
    const first = await callTool("present_debrief", debrief);
    expect(first.isError).toBeFalsy();
    const second = await callTool("present_debrief", debrief);
    expect(second.text).toContain("Already presented");
    expect((await ctx.store.getArtifacts()).filter((a) => a.type === "debrief").length).toBe(1);
  });

  it("re-presents (mints) after the prior draft is REJECTED — the freshlyRejected pin", async () => {
    await callTool("present_findings", FINDINGS);
    const [first] = (await ctx.store.getArtifacts()).filter((a) => a.type === "research");
    await ctx.store.updateArtifactStatus(first.id, "rejected", "not this");
    const rePresent = await callTool("present_findings", FINDINGS);
    expect(rePresent.isError).toBeFalsy();
    expect(rePresent.text).not.toContain("Already presented");
    const research = (await ctx.store.getArtifacts()).filter((a) => a.type === "research");
    expect(research.length).toBe(2);
  });

  it("present_options returns the art_ id in text AND structuredContent (scope 3)", async () => {
    const res = await callTool("present_options", {
      context: "Which cache?",
      options: [validOption("a", "Redis"), validOption("b", "LRU")],
    });
    expect(res.isError).toBeFalsy();
    const artId = (res.structuredContent as any)?.artifactId as string;
    expect(artId).toMatch(/^art_/);
    expect((res.structuredContent as any)?.decisionId).toMatch(/^dec_/);
    expect(res.text).toContain(`artifact ${artId}`);
  });

  it("F4 — the present_options DEDUP reply carries artifactId AND decisionId", async () => {
    const opts = { context: "Which store?", options: [validOption("a", "SQLite"), validOption("b", "Postgres")] };
    const first = await callTool("present_options", opts);
    const firstDec = (first.structuredContent as any)?.decisionId as string;
    const dup = await callTool("present_options", opts);
    expect(dup.text).toContain("Already presented");
    expect((dup.structuredContent as any)?.deduplicated).toBe(true);
    expect((dup.structuredContent as any)?.artifactId).toMatch(/^art_/);
    expect((dup.structuredContent as any)?.decisionId).toBe(firstDec);
  });
});

// -------------------- Scope 1/F4 — buildDedupResponse honors live port + extras --------------------
describe("N2 buildDedupResponse", () => {
  it("uses the passed (live) port and merges extra structured fields", () => {
    const res = buildDedupResponse({ artifactId: "art_z", type: "decision" }, 5555, { decisionId: "dec_z" });
    expect(res.content[0].text).toContain("localhost:5555");
    expect((res.structuredContent as any)?.artifactId).toBe("art_z");
    expect((res.structuredContent as any)?.decisionId).toBe("dec_z");
    expect((res.structuredContent as any)?.deduplicated).toBe(true);
  });
});

// -------------------- Scope 1 — registry unit (concurrency + status) --------------------
describe("N2 PresentIdempotencyRegistry", () => {
  let fx: GlobalStoreFixture;
  beforeEach(() => { fx = withGlobalStore("dp-n2-reg-"); });

  it("concurrent identical presentations → one owner mints, the other de-dups", async () => {
    const store = fx.track(new FileStore(fx.dir, "reg1"));
    const reg = new PresentIdempotencyRegistry();
    const hash = hashPresentArgs(FINDINGS);
    // Mirror the real handler flow: begin → (owner) createArtifact + commit,
    // all inside the same async task, so the waiter's begin resolves.
    const present = async (suffix: string) => {
      const t = await reg.begin(store, "present_findings", hash);
      if (t.duplicate) return "dup" as const;
      const art = await store.createArtifact({ id: `art_${suffix}`, type: "research", title: "R", content: { summary: "s", findings: [] } });
      t.commit!(art.id);
      return "owner" as const;
    };
    const roles = await Promise.all([present("c1"), present("c2")]);
    expect(roles.filter((r) => r === "owner").length).toBe(1);
    expect(roles.filter((r) => r === "dup").length).toBe(1);
    expect((await store.getArtifacts()).filter((a) => a.type === "research").length).toBe(1);
  });

  it("does NOT de-dup once the prior artifact leaves draft", async () => {
    const store = fx.track(new FileStore(fx.dir, "reg2"));
    const reg = new PresentIdempotencyRegistry();
    const hash = hashPresentArgs(FINDINGS);
    const t1 = await reg.begin(store, "present_findings", hash);
    const art = await store.createArtifact({ id: "art_r2", type: "research", title: "R", content: { summary: "s", findings: [] } });
    t1.commit!(art.id);
    await store.updateArtifactStatus(art.id, "rejected", "no");
    const t2 = await reg.begin(store, "present_findings", hash);
    expect(t2.duplicate).toBeUndefined();
    expect(t2.commit).toBeTruthy();
  });

  it("expires the window", async () => {
    const store = fx.track(new FileStore(fx.dir, "reg3"));
    let clock = 1_000_000;
    const reg = new PresentIdempotencyRegistry(30_000, () => clock);
    const hash = hashPresentArgs(FINDINGS);
    const t1 = await reg.begin(store, "present_findings", hash);
    const art = await store.createArtifact({ id: "art_r3", type: "research", title: "R", content: { summary: "s", findings: [] } });
    t1.commit!(art.id);
    clock += 31_000; // past the 30s window
    const t2 = await reg.begin(store, "present_findings", hash);
    expect(t2.duplicate).toBeUndefined();
    expect(t2.commit).toBeTruthy();
  });

  it("F1 — sweeps settled+expired entries so the map can't grow unbounded", async () => {
    const store = fx.track(new FileStore(fx.dir, "regF1"));
    let clock = 1_000_000;
    const reg = new PresentIdempotencyRegistry(30_000, () => clock);
    const commitOne = async (suffix: string, hashInput: unknown) => {
      const t = await reg.begin(store, "present_findings", hashPresentArgs(hashInput));
      const art = await store.createArtifact({ id: `art_${suffix}`, type: "research", title: "R", content: { summary: suffix, findings: [] } });
      t.commit!(art.id);
    };
    await commitOne("a", { ...FINDINGS, summary: "A" });
    await commitOne("b", { ...FINDINGS, summary: "B" });
    expect(reg.size).toBe(2);
    clock += 31_000; // both now settled + expired
    // A begin on a THIRD distinct hash sweeps the two stale entries first.
    const t = await reg.begin(store, "present_findings", hashPresentArgs({ ...FINDINGS, summary: "C" }));
    expect(reg.size).toBe(1); // only the just-reserved C survives
    t.abort?.();
  });

  it("F2 — owner error + 3 concurrent identical calls → exactly ONE artifact after the retry", async () => {
    // A store whose FIRST createArtifact throws (the owner), then succeeds.
    class ThrowOnceStore extends FileStore {
      private threw = false;
      async createArtifact(params: Parameters<FileStore["createArtifact"]>[0]) {
        if (!this.threw) { this.threw = true; throw new Error("transient createArtifact failure"); }
        return super.createArtifact(params);
      }
    }
    const store = fx.track(new ThrowOnceStore(fx.dir, "regF2")) as ThrowOnceStore;
    const reg = new PresentIdempotencyRegistry();
    const hash = hashPresentArgs(FINDINGS);
    const present = async (suffix: string) => {
      const t = await reg.begin(store, "present_findings", hash);
      if (t.duplicate) return "dup" as const;
      try {
        const art = await store.createArtifact({ id: `art_${suffix}`, type: "research", title: "R", content: { summary: "s", findings: [] } });
        t.commit!(art.id);
        return "owner" as const;
      } catch {
        t.abort!();
        return "error" as const;
      }
    };
    const roles = await Promise.all([present("a"), present("b"), present("c")]);
    expect(roles.filter((r) => r === "error").length).toBe(1);
    expect(roles.filter((r) => r === "owner").length).toBe(1);
    expect(roles.filter((r) => r === "dup").length).toBe(1);
    expect((await store.getArtifacts()).filter((a) => a.type === "research").length).toBe(1);
  });
});

// -------------------- Scope 2 — honest too_big title error --------------------
describe("N2 honest scalar-cap validation error", () => {
  it("a 300-char title reports the REAL constraint, not 'missing or wrong type'", () => {
    const res = validatePresentOptionsInput({
      context: "ctx",
      title: "x".repeat(300),
      options: [validOption("a", "A"), validOption("b", "B")],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const text = res.error.content[0].text;
    expect(text).toContain("too long (max 80 chars, got 300)");
    expect(text).not.toContain("missing or the wrong type");
    expect(text).toContain("`title`");
  });

  it("a missing scalar still reads as an omission", () => {
    const res = validatePresentOptionsInput({ options: [validOption("a", "A"), validOption("b", "B")] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.content[0].text).toContain("missing or the wrong type");
  });
});

// -------------------- Scope 1c — honest retry advice --------------------
describe("N2 formatHandlerError dedup-safe note", () => {
  it("tells present_* callers a re-send won't duplicate", () => {
    const err = Object.assign(new Error("daemon busy"), { status: 503 });
    const res = formatHandlerError("present_findings", err);
    expect(res._meta?.retryable).toBe(true);
    expect(res.content[0].text).toContain("will NOT create a duplicate");
  });
  it("does NOT make that claim for non-present tools", () => {
    const err = Object.assign(new Error("daemon busy"), { status: 503 });
    const res = formatHandlerError("check_feedback", err);
    expect(res.content[0].text).not.toContain("will NOT create a duplicate");
  });
});

// -------------------- Scope 4 — stale-arc annotation --------------------
describe("N2 stale-arc annotation in the first-call hint", () => {
  let fx: GlobalStoreFixture;
  beforeEach(() => { fx = withGlobalStore("dp-n2-stale-"); });

  it("annotates a draft presented long ago as stale", async () => {
    const store = fx.track(new FileStore(fx.dir, "stale1"));
    await store.createArtifact({ id: "art_old", type: "research", title: "Old draft", content: { summary: "s", findings: [] } });
    const arts = await store.getArtifacts();
    arts.find((a) => a.id === "art_old")!.createdAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toContain("stale");
    expect(hint).toMatch(/2h ago/);
  });

  it("does NOT annotate a fresh draft", async () => {
    const store = fx.track(new FileStore(fx.dir, "stale2"));
    await store.createArtifact({ id: "art_new", type: "research", title: "Fresh draft", content: { summary: "s", findings: [] } });
    const hint = await buildFirstCallHint(store, 4000);
    expect(hint).toContain("still await"); // the M4 inventory line is present
    expect(hint).not.toContain("stale");
  });
});

// -------------------- Scope 5 — self-heal companion-URL note --------------------
class HealStore extends FileStore {
  live = 4000;
  notice: { previousPort: number; newPort: number } | null = null;
  getLivePort(): number { return this.live; }
  consumePortChangeNotice(): { previousPort: number; newPort: number } | null {
    const n = this.notice;
    this.notice = null;
    return n;
  }
}
function checkCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: { getPassiveFeedback: async () => "" } as ToolContext["helpers"],
    state: { checkFeedbackPollCount: 0, reportedRejectedVerdicts: new Set(), reportedPlanVerdicts: new Set() },
  } as unknown as ToolContext;
}

describe("N2 self-heal companion-URL note", () => {
  let fx: GlobalStoreFixture;
  beforeEach(() => { fx = withGlobalStore("dp-n2-heal-"); });

  it("surfaces the new port + prose nudge after a daemon respawn", async () => {
    const store = fx.track(new HealStore(fx.dir, "heal1")) as HealStore;
    await store.createArtifact({ id: "art_h", type: "research", title: "H", content: { summary: "s", findings: [] } });
    await store.addComment({ id: "cmt_h", artifactId: "art_h", content: "look here", author: "human", target: { artifactId: "art_h" } } as any);
    store.live = 5001;
    store.notice = { previousPort: 4000, newPort: 5001 };
    const res = await handleCheckFeedback(checkCtx(store), { waitFor: "any" });
    expect(res.content[0].text).toContain("restarted on a new port");
    expect(res.content[0].text).toContain("http://localhost:5001");
    expect((res.structuredContent as any)?.companionUrl).toBe("http://localhost:5001");
  });

  it("stays silent when the port did not change", async () => {
    const store = fx.track(new HealStore(fx.dir, "heal2")) as HealStore;
    await store.createArtifact({ id: "art_h2", type: "research", title: "H", content: { summary: "s", findings: [] } });
    await store.addComment({ id: "cmt_h2", artifactId: "art_h2", content: "look", author: "human", target: { artifactId: "art_h2" } } as any);
    const res = await handleCheckFeedback(checkCtx(store), { waitFor: "any" });
    expect(res.content[0].text).not.toContain("restarted on a new port");
    expect((res.structuredContent as any)?.companionUrl).toBe("http://localhost:4000");
  });
});

// -------------------- Scope 6 + 1b — answer_question echo + idempotency --------------------
describe("N2 answer_question echo + idempotency", () => {
  const ctx = setupServerTest();
  const callTool = makeCallTool(ctx);

  it("does not echo the just-answered question as [Human feedback]", async () => {
    await ctx.store.createArtifact({ id: "art_q", type: "research", title: "Q", content: { summary: "s", findings: [] } });
    await ctx.store.addComment({ id: "cmt_q", artifactId: "art_q", content: "why is this a bug?", author: "human", intent: "question", target: { artifactId: "art_q" } } as any);
    const res = await callTool("answer_question", { commentId: "cmt_q", answer: "because of the off-by-one" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Answered cmt_q");
    expect(res.text).not.toContain("why is this a bug?");
    expect(res.text).not.toContain("[Human feedback]");
  });

  it("is idempotent on an identical re-answer, but appends a genuinely-different follow-up", async () => {
    await ctx.store.createArtifact({ id: "art_q2", type: "research", title: "Q", content: { summary: "s", findings: [] } });
    await ctx.store.addComment({ id: "cmt_q2", artifactId: "art_q2", content: "why?", author: "human", intent: "question", target: { artifactId: "art_q2" } } as any);
    await callTool("answer_question", { commentId: "cmt_q2", answer: "first answer" });
    const dup = await callTool("answer_question", { commentId: "cmt_q2", answer: "first answer" });
    expect(dup.text).toContain("already answered");
    const agentComments1 = (await ctx.store.getCommentsForArtifact("art_q2")).filter((c) => c.author === "agent");
    expect(agentComments1.length).toBe(1);
    // A different answer is a legitimate follow-up.
    const diff = await callTool("answer_question", { commentId: "cmt_q2", answer: "second, different answer" });
    expect(diff.text).toContain("Answered cmt_q2");
    const agentComments2 = (await ctx.store.getCommentsForArtifact("art_q2")).filter((c) => c.author === "agent");
    expect(agentComments2.length).toBe(2);
    // F3 — re-sending an OLDER answer (not the most recent) after a follow-up is
    // still caught as a duplicate: the guard scans ALL replies, not just the last.
    const older = await callTool("answer_question", { commentId: "cmt_q2", answer: "first answer" });
    expect(older.text).toContain("already answered");
    const agentComments3 = (await ctx.store.getCommentsForArtifact("art_q2")).filter((c) => c.author === "agent");
    expect(agentComments3.length).toBe(2); // no third append
  });
});

// -------------------- Scope 6 unit — getPassiveFeedback exclude --------------------
describe("N2 getPassiveFeedback exclude", () => {
  let fx: GlobalStoreFixture;
  beforeEach(() => { fx = withGlobalStore("dp-n2-pf-"); });

  it("acknowledges excluded comments but keeps them out of the echo", async () => {
    const store = fx.track(new FileStore(fx.dir, "pf1"));
    await store.createArtifact({ id: "art_p", type: "research", title: "P", content: { summary: "s", findings: [] } });
    await store.addComment({ id: "cmt_x", artifactId: "art_p", content: "excluded one", author: "human", target: { artifactId: "art_p" } } as any);
    await store.addComment({ id: "cmt_y", artifactId: "art_p", content: "kept one", author: "human", target: { artifactId: "art_p" } } as any);
    const out = await getPassiveFeedback(store, ["cmt_x"]);
    expect(out).toContain("kept one");
    expect(out).not.toContain("excluded one");
    // Both were acknowledged → a second drain yields nothing.
    expect(await getPassiveFeedback(store)).toBe("");
  });
});
