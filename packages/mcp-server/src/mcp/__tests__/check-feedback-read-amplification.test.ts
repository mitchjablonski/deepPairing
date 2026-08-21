import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * O3 (#231) — READ-AMPLIFICATION guard for check_feedback.
 *
 * In production the store is a DaemonClient: every getArtifacts/getFullState/
 * getUnacknowledgedComments is an un-memoized HTTP round-trip. The pre-O3
 * handler issued the SAME read many times per poll (getArtifacts ~5-6×,
 * getFullState 3×, getUnacknowledgedComments 3×, getResolvedDecisions 3×,
 * getUnacknowledgedRenderFailures 3×, getAutonomyLevel 2×) — invisible to the
 * golden tests because a FileStore read is free.
 *
 * This test wraps a real FileStore in a call-COUNTING proxy and asserts the
 * consolidated post-O3 read counts: ONE pre-poll snapshot + ONE post-wake
 * snapshot. It is the "measure the read count" instrument the batch calls for,
 * and a regression guard so a future edit can't quietly re-introduce the
 * amplification. Output invariance is pinned separately by
 * check-feedback-golden-parity.test.ts.
 */

const FIXED_NOW = new Date("2026-07-25T12:00:00.000Z");

let fx: GlobalStoreFixture;
let tmpDir: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  fx = withGlobalStore("dp-cf-readamp-");
  tmpDir = fx.dir;
});

afterEach(() => {
  vi.useRealTimers();
  fx.dispose();
});

/** Wrap a store so every method call is tallied by name. */
function countingStore(store: FileStore): { store: FileStore; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          counts[String(prop)] = (counts[String(prop)] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  }) as FileStore;
  return { store: proxy, counts };
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

/**
 * A representative busy poll: comments + a plan verdict + a status change + a
 * pending draft — exercises most read lanes at once.
 *
 * Q3 — `planCount` is a PARAMETER, and the caller drives it above 1. The old
 * fixture seeded exactly ONE plan, which is precisely why the getPlanReviewVerdict
 * N+1 could hide here for months: at N=1 an N+1 and a consolidated read are the
 * same number. Any lane that scales with artifact count must be measured at N>1
 * or the instrument is blind to the shape it exists to catch.
 */
function seedBusy(store: FileStore, planCount = 3) {
  store.createArtifact({
    id: "art_spec",
    type: "spec",
    title: "Session spec",
    content: { summary: "s", requirements: [{ id: "REQ-1", text: "sessions expire" }], findings: [] },
  });
  store.addComment({
    id: "cmt_q",
    artifactId: "art_spec",
    content: "does this cover refresh tokens?",
    author: "human",
    intent: "question",
    target: { artifactId: "art_spec" },
  });
  for (let i = 0; i < planCount; i++) {
    const id = `art_plan_${i}`;
    store.createArtifact({ id, type: "plan", title: `Rollout ${i}`, content: { steps: [] } });
    store.recordPlanReview(id);
    store.resolvePlanReview(id, "approved", "ship it");
    store.updateArtifactStatus(id, "approved", "ui_approve_button");
  }
  store.createArtifact({
    id: "art_draft",
    type: "code_change",
    title: "modify x",
    content: { filePath: "x.ts", changeType: "modify", before: "a", after: "b", reasoning: "r" },
  });
}

describe("O3 (#231) — check_feedback read consolidation", () => {
  it("issues at most one pre-poll + one post-wake read of each shared store lane", async () => {
    const base = fx.track(new FileStore(tmpDir, "s_readamp"));
    seedBusy(base);
    const { store, counts } = countingStore(base);
    await handleCheckFeedback(makeCtx(store), {});

    // eslint-disable-next-line no-console
    console.log("[read-amp] counts:", JSON.stringify(counts));

    // Consolidated ceilings. A busy poll has immediate feedback so it skips the
    // long-poll: the pre-poll gate reads once, the post-wake assembly reads once.
    expect(counts.getArtifacts ?? 0).toBeLessThanOrEqual(2);
    expect(counts.getFullState ?? 0).toBeLessThanOrEqual(1);
    expect(counts.getUnacknowledgedComments ?? 0).toBeLessThanOrEqual(2);
    expect(counts.getResolvedDecisions ?? 0).toBeLessThanOrEqual(2);
    expect(counts.getUnacknowledgedRenderFailures ?? 0).toBeLessThanOrEqual(2);
    expect(counts.getAutonomyLevel ?? 0).toBeLessThanOrEqual(1);
    // Q3 — the two plan-review lanes join the capped set. getPendingPlanReviews
    // was always O(1); getPlanReviewVerdict was the N+1 (one call per plan
    // artifact, superseded revisions included — an HTTP round-trip each under
    // DaemonClient). It now reads off the getFullState snapshot, so ZERO.
    expect(counts.getPendingPlanReviews ?? 0).toBeLessThanOrEqual(1);
    expect(counts.getPlanReviewVerdict ?? 0).toBe(0);
  });

  it("plan-verdict reads do NOT scale with the number of plans (the N+1 shape)", async () => {
    // The instrument the caps above can't be: hold everything else fixed and
    // vary ONLY N. A per-plan read shows up as a rising count; a snapshot read
    // is flat. Runs at N=1 (where the old bug was invisible) and N=5.
    const observed: Array<{ n: number; verdictReads: number; totalReads: number }> = [];
    for (const n of [1, 5]) {
      const base = fx.track(new FileStore(tmpDir, `s_readamp_n${n}`));
      seedBusy(base, n);
      const { store, counts } = countingStore(base);
      await handleCheckFeedback(makeCtx(store), {});
      observed.push({
        n,
        verdictReads: counts.getPlanReviewVerdict ?? 0,
        totalReads: Object.values(counts).reduce((a, b) => a + b, 0),
      });
    }
    // eslint-disable-next-line no-console
    console.log("[read-amp] plan scaling:", JSON.stringify(observed));
    expect(observed[0]!.verdictReads).toBe(0);
    expect(observed[1]!.verdictReads).toBe(0);
    // Pre-Q3 this delta was +4 (one extra verdict read per extra plan). The
    // remaining reads are per-poll, not per-plan, so N must not move the total.
    expect(observed[1]!.totalReads).toBe(observed[0]!.totalReads);
  });
});
