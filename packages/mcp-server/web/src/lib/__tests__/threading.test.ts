import { describe, it, expect } from "vitest";
import { buildThreads, threadRootId } from "../threading";

const c = (id: string, parentCommentId: string | null = null, createdAt = "2026-07-01T00:00:00.000Z") =>
  ({ id, parentCommentId, createdAt, artifactId: "a1", author: "human", content: id, target: { artifactId: "a1" } }) as any;

describe("F7 — transitive threading", () => {
  it("a depth-2 reply lands in its root's thread (the vanishing-reply class)", () => {
    // root ← agent answer ← human follow-up ← agent answer to THAT (depth 3)
    const comments = [c("root"), c("ans", "root", "2026-07-01T00:01:00.000Z"),
                      c("followup", "ans", "2026-07-01T00:02:00.000Z"),
                      c("ans2", "followup", "2026-07-01T00:03:00.000Z")];
    const threads = buildThreads(comments);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("root");
    expect(threads[0].replies.map((r) => r.id)).toEqual(["ans", "followup", "ans2"]);
  });

  it("orphaned replies (parent filtered out) root at themselves — never vanish", () => {
    const threads = buildThreads([c("orphan", "gone")]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("orphan");
  });

  it("a parent cycle neither hangs nor vanishes — one thread, deterministic root", () => {
    const a = c("a", "b", "2026-07-01T00:01:00.000Z");
    const b = c("b", "a", "2026-07-01T00:02:00.000Z");
    const byId = new Map([["a", a], ["b", b]]);
    // Same root from EITHER entry point (the chronologically-first member).
    expect(threadRootId(a, byId)).toBe("a");
    expect(threadRootId(b, byId)).toBe("a");
    const threads = buildThreads([a, b]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("a");
    expect(threads[0].replies.map((r) => r.id)).toEqual(["b"]);
  });

  it("a tail entering a cycle (with a timestamp inversion) still yields ONE thread", () => {
    // a(t0, OLDER than the cycle) → b(t1) → c(t2) → b. Rooting on the whole
    // walk path made a root at itself while b/c rooted at b — a split.
    const a = c("a", "b", "2026-07-01T00:00:00.000Z");
    const b = c("b", "c", "2026-07-01T00:01:00.000Z");
    const cy = c("c", "b", "2026-07-01T00:02:00.000Z");
    const byId = new Map([["a", a], ["b", b], ["c", cy]]);
    // Every entry point roots at the CYCLE's oldest member.
    expect(threadRootId(a, byId)).toBe("b");
    expect(threadRootId(b, byId)).toBe("b");
    expect(threadRootId(cy, byId)).toBe("b");
    const threads = buildThreads([a, b, cy]);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("roots chronological; descendants chronological within a thread", () => {
    const threads = buildThreads([
      c("r2", null, "2026-07-01T00:05:00.000Z"),
      c("r1", null, "2026-07-01T00:01:00.000Z"),
      c("r1b", "r1", "2026-07-01T00:04:00.000Z"),
      c("r1a", "r1", "2026-07-01T00:02:00.000Z"),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["r1", "r2"]);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["r1a", "r1b"]);
  });
});
