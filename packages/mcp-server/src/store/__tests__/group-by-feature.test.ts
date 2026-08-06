// #203 (H2) — the Features view's derived read-model: normalizeFeaturePrefix
// (table-pinned to real corpus shapes + hostile inputs) and groupByFeature
// (parentId-beats-prefix conflict, aggregates, Ungrouped-last ordering).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { normalizeFeaturePrefix, normalizeFeatureId, groupByFeature } from "../session-scan.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-features-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a session's on-disk files directly — full control of createdAt,
 *  parentId, titles, decisions and comments (the reader is a pure disk walk, so
 *  precise fixtures are the clearest test). */
function writeSession(
  sessionId: string,
  artifacts: Array<Record<string, unknown>>,
  decisions: Array<Record<string, unknown>> = [],
  comments: Array<Record<string, unknown>> = [],
): void {
  const dir = path.join(tmpDir, ".deeppairing", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(artifacts));
  if (decisions.length) fs.writeFileSync(path.join(dir, "decisions.json"), JSON.stringify(decisions));
  if (comments.length) fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(comments));
}

/** A minimal on-disk artifact (satisfies salvageArray's "id" key + the fields
 *  groupByFeature reads). */
function art(o: {
  id: string;
  title: string;
  type?: string;
  status?: string;
  parentId?: string | null;
  createdAt?: string;
  content?: Record<string, unknown>;
  featureId?: string;
}): Record<string, unknown> {
  return {
    id: o.id,
    sessionId: "s",
    type: o.type ?? "plan",
    version: 1,
    parentId: o.parentId ?? null,
    title: o.title,
    status: o.status ?? "draft",
    content: o.content ?? {},
    agentReasoning: null,
    ...(o.featureId ? { featureId: o.featureId } : {}),
    createdAt: o.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: o.createdAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("normalizeFeaturePrefix — table-pinned corpus shapes", () => {
  const CASES: Array<[string, { slug: string; label: string } | null]> = [
    // Real corpus shapes.
    ["Milestone 6 — content quota backfill", { slug: "milestone-6", label: "Milestone 6" }],
    ["Milestone 12: retry ceiling", { slug: "milestone-12", label: "Milestone 12" }],
    ["Phase 0: bootstrap", { slug: "phase-0", label: "Phase 0" }],
    ["Phase 3 — daemon reliability", { slug: "phase-3", label: "Phase 3" }],
    // Short milestone form collapses into the SAME group as the long form.
    ["M6 — quota UI", { slug: "milestone-6", label: "Milestone 6" }],
    ["m6: quota persistence", { slug: "milestone-6", label: "Milestone 6" }],
    // Decimal sub-phases are DISTINCT anchors (never merged into the integer).
    ["Phase 0.5 — interim shim", { slug: "phase-0-5", label: "Phase 0.5" }],
    ["Milestone 6.5 — hotfix", { slug: "milestone-6-5", label: "Milestone 6.5" }],
    ["M6.5 — quota patch", { slug: "milestone-6-5", label: "Milestone 6.5" }],
    // Leading zeros on the integer part normalize ("06" → "6").
    ["Milestone 06 — padded", { slug: "milestone-6", label: "Milestone 6" }],
    // Feature: X and [X] name the feature directly.
    ["Feature: auth revamp", { slug: "auth-revamp", label: "Auth revamp" }],
    ["Feature - billing export", { slug: "billing-export", label: "Billing export" }],
    ["[search] fuzzy ranking", { slug: "search", label: "Search" }],
    ["[Auth] logout flow", { slug: "auth", label: "Auth" }],
    // #206 review Fix 1 — a bracket/Feature tag naming a NUMBERED milestone/phase
    // mines its inner text FIRST, so it converges with the equivalent title
    // prefix ("[M7]" ↔ "M7 …" ↔ "Milestone 7 …") AND makes the family idempotent.
    ["[M7] logout flow", { slug: "milestone-7", label: "Milestone 7" }],
    ["[Milestone 6] backfill", { slug: "milestone-6", label: "Milestone 6" }],
    ["Feature: M7", { slug: "milestone-7", label: "Milestone 7" }],
    ["Feature: Phase 0", { slug: "phase-0", label: "Phase 0" }],
    // Case-insensitivity.
    ["MILESTONE 6 — shout", { slug: "milestone-6", label: "Milestone 6" }],
    // Prefix-only titles still classify.
    ["Milestone 6", { slug: "milestone-6", label: "Milestone 6" }],
    // Plain titles → Ungrouped.
    ["Refactor the token bucket", null],
    ["Add a retry cap to the crawler", null],
    // Hostile: empty / whitespace.
    ["", null],
    ["   ", null],
    // Hostile: a word that merely starts with M+letters (no digit) or M+digit
    // with no boundary must NOT false-match the short-milestone form.
    ["MP3 tagger rewrite", null],
    ["m5stack firmware", null],
    ["Marketing dashboard", null],
    // Hostile: empty bracket / bracket with no sluggable content.
    ["[] nothing", null],
    ["[!!] punctuation only", null],
    // Hostile: a COMPOUND word beginning with "Feature-" (bare hyphen, no
    // surrounding space) is NOT a "Feature: X" tag — real corpus title.
    ["Feature-extractor research: PiD is a dead end", null],
    ["Feature-flag rollout plan", null],
  ];

  it.each(CASES)("normalizes %j", (title, expected) => {
    expect(normalizeFeaturePrefix(title)).toEqual(expected);
  });

  it("mines unicode em/en-dash separators the same as a hyphen", () => {
    expect(normalizeFeaturePrefix("Milestone 6 — em")).toEqual({ slug: "milestone-6", label: "Milestone 6" });
    expect(normalizeFeaturePrefix("Milestone 6 – en")).toEqual({ slug: "milestone-6", label: "Milestone 6" });
    expect(normalizeFeaturePrefix("Feature — payments")).toEqual({ slug: "payments", label: "Payments" });
  });

  // #206 review Fix 1 — the PROPERTY that closes the mis-file bug: every slug the
  // normalizer can PRODUCE must re-normalize to ITSELF. Without it, a Move onto a
  // group whose id re-mined ("m7" → "milestone-7") re-filed the artifact into a
  // divergent twin group. We derive the slug set from the full pinned table (+
  // the raw-tag forms normalizeFeatureId adds) rather than hand-listing, so a
  // future non-idempotent slug can't slip in unpinned.
  it("is IDEMPOTENT: normalizeFeatureId(slug).slug === slug for every producible slug", () => {
    const producedSlugs = new Set<string>();
    for (const [title, expected] of CASES) {
      if (expected) producedSlugs.add(expected.slug);
      // Also feed each raw title through normalizeFeatureId (the agent-tag path).
      const viaTag = normalizeFeatureId(title);
      if (viaTag) producedSlugs.add(viaTag.slug);
    }
    // Belt-and-suspenders: the exact hostile/short forms the review flagged.
    for (const raw of ["[M7]", "m7", "M7", "Milestone 7", "milestone-7", "[Milestone 6]", "Feature: M7"]) {
      const r = normalizeFeatureId(raw);
      if (r) producedSlugs.add(r.slug);
    }
    expect(producedSlugs.size).toBeGreaterThan(0);
    for (const slug of producedSlugs) {
      const re = normalizeFeatureId(slug);
      expect(re, `slug ${slug} did not re-normalize`).not.toBeNull();
      expect(re!.slug, `slug ${slug} is NOT idempotent`).toBe(slug);
    }
  });
});

describe("groupByFeature — grouping", () => {
  it("returns the empty shape when no sessions dir exists", () => {
    expect(FileStore.groupByFeature(tmpDir)).toEqual({ groups: [], failedSessions: [] });
  });

  it("groups artifacts sharing a mined prefix, and puts plain titles in Ungrouped (last)", () => {
    writeSession("s1", [
      art({ id: "a1", title: "Milestone 6 — quota backfill", createdAt: "2026-01-01T01:00:00.000Z" }),
      art({ id: "a2", title: "M6 — quota UI", createdAt: "2026-01-01T02:00:00.000Z" }),
      art({ id: "a3", title: "Refactor token bucket", createdAt: "2026-01-01T03:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    const m6 = groups.find((g) => g.id === "milestone-6")!;
    expect(m6.title).toBe("Milestone 6");
    expect(m6.artifactCount).toBe(2);
    // Timeline order is createdAt ascending.
    expect(m6.artifactRefs.map((r) => r.artifactId)).toEqual(["a1", "a2"]);
    // Ungrouped bucket exists and is LAST.
    expect(groups.at(-1)!.id).toBe("__ungrouped__");
    expect(groups.at(-1)!.ungrouped).toBe(true);
    expect(groups.at(-1)!.artifactRefs.map((r) => r.artifactId)).toEqual(["a3"]);
  });

  it("all-plain-titles → one Ungrouped group only", () => {
    writeSession("s1", [
      art({ id: "a1", title: "Fix the crawler" }),
      art({ id: "a2", title: "Tune the cache" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("__ungrouped__");
    expect(groups[0]!.artifactCount).toBe(2);
  });

  it("parentId chain BEATS the child's own prefix (a superseded v2 stays with its v1's group even if retitled)", () => {
    writeSession("s1", [
      // v1 is grouped by prefix into Milestone 6.
      art({ id: "v1", title: "Milestone 6 — quota backfill", status: "superseded", createdAt: "2026-01-01T01:00:00.000Z" }),
      // v2 is a child of v1, RE-TITLED with a DIFFERENT prefix (Milestone 7).
      // The chain wins: v2 joins Milestone 6, NOT Milestone 7.
      art({ id: "v2", title: "Milestone 7 — retitled", parentId: "v1", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    const m6 = groups.find((g) => g.id === "milestone-6")!;
    expect(m6.artifactRefs.map((r) => r.artifactId).sort()).toEqual(["v1", "v2"]);
    // No stray Milestone 7 group was created from v2's own prefix.
    expect(groups.find((g) => g.id === "milestone-7")).toBeUndefined();
  });

  it("an ungrouped parent lets a prefixed child keep its own prefix", () => {
    writeSession("s1", [
      art({ id: "p", title: "Plain root", createdAt: "2026-01-01T01:00:00.000Z" }),
      art({ id: "c", title: "Phase 2 — child", parentId: "p", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    expect(groups.find((g) => g.id === "phase-2")!.artifactRefs.map((r) => r.artifactId)).toEqual(["c"]);
    expect(groups.at(-1)!.id).toBe("__ungrouped__"); // the plain root
  });

  it("orders grouped features by most-recent activity, Ungrouped always last", () => {
    writeSession("s1", [
      art({ id: "a1", title: "Milestone 1 — old", createdAt: "2026-01-01T00:00:00.000Z" }),
      art({ id: "a2", title: "Milestone 9 — recent", createdAt: "2026-06-01T00:00:00.000Z" }),
      art({ id: "a3", title: "loose end", createdAt: "2026-12-01T00:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    expect(groups.map((g) => g.id)).toEqual(["milestone-9", "milestone-1", "__ungrouped__"]);
  });

  it("survives a parentId cycle (corrupt data) without hanging, falling back to own prefix", () => {
    writeSession("s1", [
      art({ id: "x", title: "Milestone 4 — a", parentId: "y" }),
      art({ id: "y", title: "Milestone 4 — b", parentId: "x" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    expect(groups.find((g) => g.id === "milestone-4")!.artifactCount).toBe(2);
  });

  it("keeps a decimal sub-phase in its OWN group (Phase 0 and Phase 0.5 are distinct)", () => {
    writeSession("s1", [
      art({ id: "a1", title: "Phase 0 — bootstrap", createdAt: "2026-01-01T01:00:00.000Z" }),
      art({ id: "a2", title: "Phase 0.5 — interim shim", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    expect(groups.find((g) => g.id === "phase-0")!.artifactRefs.map((r) => r.artifactId)).toEqual(["a1"]);
    expect(groups.find((g) => g.id === "phase-0-5")!.artifactRefs.map((r) => r.artifactId)).toEqual(["a2"]);
  });

  it("does NOT throw when two artifacts in one group both lack createdAt (salvage contract: skip+report, never crash)", () => {
    // The art() helper always defaults createdAt — this is why the unguarded
    // sort slipped past the suite. Write raw refs with NO createdAt to repro the
    // TypeError the guarded compare now prevents.
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(dir, { recursive: true });
    const noDate = (id: string, title: string) => ({
      id, sessionId: "s1", type: "plan", version: 1, parentId: null,
      title, status: "draft", content: {}, agentReasoning: null,
      // deliberately NO createdAt / updatedAt
    });
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify([
      noDate("a1", "Milestone 6 — one"),
      noDate("a2", "Milestone 6 — two"),
    ]));
    let result!: ReturnType<typeof groupByFeature>;
    expect(() => { result = groupByFeature(tmpDir); }).not.toThrow();
    const m6 = result.groups.find((g) => g.id === "milestone-6")!;
    expect(m6.artifactCount).toBe(2);
    // An all-undated group has no fabricated activity time.
    expect(m6.lastActivity).toBeUndefined();
    // The read succeeded — this is NOT a failedSessions case.
    expect(result.failedSessions).toEqual([]);
  });
});

describe("groupByFeature — aggregates", () => {
  it("counts open items: an unresolved decision + a debrief needsYourEyes + an unanswered question, scoped to the group", () => {
    writeSession(
      "s1",
      [
        art({ id: "dec1", title: "Milestone 6 — cache choice", type: "decision", createdAt: "2026-01-01T01:00:00.000Z" }),
        art({
          id: "db1", title: "Milestone 6 — debrief", type: "debrief", createdAt: "2026-01-01T02:00:00.000Z",
          content: { summary: "did stuff", needsYourEyes: [{ what: "check the expiry math", why: "auth path", artifactRef: "dec1" }] },
        }),
        art({ id: "cs1", title: "Milestone 6 — changeset", type: "changeset", createdAt: "2026-01-01T03:00:00.000Z" }),
        // A DIFFERENT feature — its open items must NOT leak into Milestone 6.
        art({ id: "other", title: "Phase 9 — unrelated", type: "decision", createdAt: "2026-01-01T04:00:00.000Z" }),
      ],
      [
        // Unresolved (no response) → open item in Milestone 6.
        { decisionId: "d1", artifactId: "dec1", context: "Which cache backend?", options: [], createdAt: "2026-01-01T01:00:00.000Z" },
        // Resolved → NOT an open item.
        { decisionId: "d2", artifactId: "other", context: "Unrelated?", options: [{ id: "o1", title: "yes" }], response: { optionId: "o1" }, createdAt: "2026-01-01T04:00:00.000Z" },
      ],
      [
        // An OPEN human question on the debrief (Milestone 6).
        { id: "q1", author: "human", intent: "question", content: "why the 15m TTL?", target: { artifactId: "db1" }, parentCommentId: null, createdAt: "2026-01-01T05:00:00.000Z" },
      ],
    );
    const { groups } = groupByFeature(tmpDir);
    const m6 = groups.find((g) => g.id === "milestone-6")!;
    expect(m6.openItemCount).toBe(3);
    const kinds = m6.openItems.map((i) => i.kind).sort();
    expect(kinds).toEqual(["decision", "needs_eyes", "question"]);
    const decItem = m6.openItems.find((i) => i.kind === "decision")!;
    expect(decItem.label).toBe("Which cache backend?");
    expect(decItem.artifactId).toBe("dec1");
    const eyes = m6.openItems.find((i) => i.kind === "needs_eyes")!;
    expect(eyes.label).toBe("check the expiry math");
    expect(eyes.artifactId).toBe("dec1"); // follows artifactRef
    const q = m6.openItems.find((i) => i.kind === "question")!;
    expect(q.commentId).toBe("q1");
    // The resolved decision in Phase 9 is not an open item.
    expect(groups.find((g) => g.id === "phase-9")!.openItemCount).toBe(0);
  });

  it("a decision whose origin artifact was superseded (closedUnresolved) is NOT an open item", () => {
    writeSession(
      "s1",
      [art({ id: "dec1", title: "Milestone 6 — choice", type: "decision", status: "superseded" })],
      [{ decisionId: "d1", artifactId: "dec1", context: "?", options: [], createdAt: "2026-01-01T00:00:00.000Z" }],
    );
    const m6 = groupByFeature(tmpDir).groups.find((g) => g.id === "milestone-6")!;
    expect(m6.openItemCount).toBe(0);
  });

  // #209 (J1) — broadened from superseded-only: a RETRACTED (or otherwise
  // closed) decision can never resolve, so it must NOT keep inflating the
  // feature's open-item count either.
  it("a decision whose origin artifact was RETRACTED is NOT an open item", () => {
    writeSession(
      "s1",
      [art({ id: "dec1", title: "Milestone 6 — choice", type: "decision", status: "retracted" })],
      [{ decisionId: "d1", artifactId: "dec1", context: "?", options: [], createdAt: "2026-01-01T00:00:00.000Z" }],
    );
    const m6 = groupByFeature(tmpDir).groups.find((g) => g.id === "milestone-6")!;
    expect(m6.openItemCount).toBe(0);
  });

  it("unions code_change.filePath + changeset.files[].path, deduped + sorted, with cross-group 'alsoIn'", () => {
    writeSession("s1", [
      art({ id: "a1", title: "Milestone 6 — edit", type: "code_change", content: { filePath: "src/b.ts" } }),
      art({ id: "a2", title: "Milestone 6 — batch", type: "changeset", content: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } }),
      // A different group also touches src/a.ts → intersection breadcrumb.
      art({ id: "a3", title: "Phase 9 — edit", type: "code_change", content: { filePath: "src/a.ts" } }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    const m6 = groups.find((g) => g.id === "milestone-6")!;
    expect(m6.fileTouches.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]); // deduped + sorted
    expect(m6.fileTouches.find((f) => f.path === "src/a.ts")!.alsoIn).toEqual(["Phase 9"]);
    expect(m6.fileTouches.find((f) => f.path === "src/b.ts")!.alsoIn).toEqual([]);
  });
});

describe("normalizeFeatureId — the agent-tag → group-key normalizer (#206 I1)", () => {
  it("routes a raw milestone tag through the SAME key the title miner produces", () => {
    // The convergence property, at the unit level: every spelling of the tag
    // and the equivalent TITLE prefix collapse to one key + label.
    expect(normalizeFeatureId("Milestone 7")).toEqual({ slug: "milestone-7", label: "Milestone 7" });
    expect(normalizeFeatureId("milestone-7")).toEqual({ slug: "milestone-7", label: "Milestone 7" });
    expect(normalizeFeatureId("M7")).toEqual({ slug: "milestone-7", label: "Milestone 7" });
    expect(normalizeFeaturePrefix("Milestone 7 — backfill")!.slug).toBe("milestone-7");
  });
  it("slugifies a free-form tag and is idempotent on its own slug", () => {
    expect(normalizeFeatureId("Auth Rework")).toEqual({ slug: "auth-rework", label: "Auth Rework" });
    expect(normalizeFeatureId("auth-rework")!.slug).toBe("auth-rework");
    // Idempotent: feeding the slug back yields the same slug.
    const once = normalizeFeatureId("Auth Rework")!.slug;
    expect(normalizeFeatureId(once)!.slug).toBe(once);
  });
  it("returns null for an empty / unsluggable tag", () => {
    expect(normalizeFeatureId("")).toBeNull();
    expect(normalizeFeatureId("   ")).toBeNull();
    expect(normalizeFeatureId("!!!")).toBeNull();
    expect(normalizeFeatureId(undefined)).toBeNull();
  });
});

describe("groupByFeature — explicit featureId tag + precedence (#206 I1)", () => {
  it("CONVERGENCE: an agent-tagged 'milestone-7' artifact groups WITH a 'Milestone 7 — x'-TITLED one", () => {
    writeSession("s1", [
      // Title carries no prefix, but the agent stamped the tag.
      art({ id: "tagged", title: "backfill the quota table", featureId: "milestone-7", createdAt: "2026-01-01T01:00:00.000Z" }),
      // Title-prefix only, no tag.
      art({ id: "titled", title: "Milestone 7 — retry ceiling", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    const m7 = groups.find((g) => g.id === "milestone-7")!;
    expect(m7.title).toBe("Milestone 7");
    expect(m7.artifactRefs.map((r) => r.artifactId).sort()).toEqual(["tagged", "titled"]);
    // No stray group split them.
    expect(groups.filter((g) => g.id.startsWith("milestone-7")).length).toBe(1);
  });

  it("a raw 'Milestone 7' tag normalizes to the same key as the miner", () => {
    writeSession("s1", [
      art({ id: "raw", title: "plain title", featureId: "Milestone 7" }),
      art({ id: "titled", title: "Milestone 7 — x" }),
    ]);
    const m7 = groupByFeature(tmpDir).groups.find((g) => g.id === "milestone-7")!;
    expect(m7.artifactCount).toBe(2);
  });

  it("explicit featureId BEATS an inherited parent group (explicit beats chain)", () => {
    writeSession("s1", [
      art({ id: "v1", title: "Milestone 6 — root", status: "superseded", createdAt: "2026-01-01T01:00:00.000Z" }),
      // Child chains to v1 (Milestone 6) BUT carries its own explicit tag.
      art({ id: "v2", title: "retitled work", parentId: "v1", featureId: "milestone-8", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir);
    // v2 keeps its OWN tag, not the parent's group.
    expect(groups.find((g) => g.id === "milestone-8")!.artifactRefs.map((r) => r.artifactId)).toEqual(["v2"]);
    expect(groups.find((g) => g.id === "milestone-6")!.artifactRefs.map((r) => r.artifactId)).toEqual(["v1"]);
  });

  it("an agent-only tag with no title prefix gets a de-slugged display label", () => {
    writeSession("s1", [art({ id: "a1", title: "no prefix here", featureId: "auth-rework" })]);
    const g = groupByFeature(tmpDir).groups.find((x) => x.id === "auth-rework")!;
    expect(g.title).toBe("Auth Rework");
  });
});

describe("groupByFeature — human overrides (#206 I1)", () => {
  it("a human MOVE beats an explicit featureId (top precedence)", () => {
    writeSession("s1", [
      art({ id: "a1", title: "tagged work", featureId: "milestone-7", createdAt: "2026-01-01T01:00:00.000Z" }),
      art({ id: "target", title: "Milestone 9 — home", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    // Without the override, a1 is in milestone-7.
    const before = groupByFeature(tmpDir).groups.find((g) => g.id === "milestone-7")!;
    expect(before.artifactRefs.map((r) => r.artifactId)).toEqual(["a1"]);
    // The human moves a1 into milestone-9 — it beats the explicit tag.
    const { groups } = groupByFeature(tmpDir, { artifactAssignments: { a1: "milestone-9" } });
    expect(groups.find((g) => g.id === "milestone-9")!.artifactRefs.map((r) => r.artifactId).sort()).toEqual(["a1", "target"]);
    expect(groups.find((g) => g.id === "milestone-7")).toBeUndefined();
  });

  it("a human move to __ungrouped__ pulls a tagged artifact OUT of its feature", () => {
    writeSession("s1", [
      art({ id: "a1", title: "Milestone 6 — x", createdAt: "2026-01-01T01:00:00.000Z" }),
      art({ id: "a2", title: "Milestone 6 — y", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir, { artifactAssignments: { a1: "__ungrouped__" } });
    expect(groups.find((g) => g.id === "milestone-6")!.artifactRefs.map((r) => r.artifactId)).toEqual(["a2"]);
    expect(groups.at(-1)!.id).toBe("__ungrouped__");
    expect(groups.at(-1)!.artifactRefs.map((r) => r.artifactId)).toEqual(["a1"]);
  });

  it("a human RENAME overrides the derived group title", () => {
    writeSession("s1", [art({ id: "a1", title: "Milestone 6 — x" })]);
    const { groups } = groupByFeature(tmpDir, { groupTitles: { "milestone-6": "Quota backfill" } });
    expect(groups.find((g) => g.id === "milestone-6")!.title).toBe("Quota backfill");
  });

  it("a move onto a brand-new key creates the group (de-slugged label)", () => {
    writeSession("s1", [art({ id: "a1", title: "loose end" })]);
    const { groups } = groupByFeature(tmpDir, { artifactAssignments: { a1: "hotfix-lane" } });
    const g = groups.find((x) => x.id === "hotfix-lane")!;
    expect(g.title).toBe("Hotfix Lane");
    expect(g.artifactRefs.map((r) => r.artifactId)).toEqual(["a1"]);
  });

  it("a child inherits its moved parent's group through the chain", () => {
    writeSession("s1", [
      art({ id: "p", title: "loose parent", createdAt: "2026-01-01T01:00:00.000Z" }),
      art({ id: "c", title: "child of loose parent", parentId: "p", createdAt: "2026-01-01T02:00:00.000Z" }),
    ]);
    const { groups } = groupByFeature(tmpDir, { artifactAssignments: { p: "milestone-3" } });
    // p was moved; c chains to p and inherits milestone-3.
    expect(groups.find((g) => g.id === "milestone-3")!.artifactRefs.map((r) => r.artifactId).sort()).toEqual(["c", "p"]);
  });
});

describe("groupByFeature — read tolerance", () => {
  it("reports a whole-file-unreadable artifacts.json in failedSessions, never throwing", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "artifacts.json"), "not json ]");
    writeSession("good", [art({ id: "g1", title: "Milestone 2 — ok" })]);
    const { groups, failedSessions } = groupByFeature(tmpDir);
    expect(groups.find((g) => g.id === "milestone-2")).toBeDefined();
    expect(failedSessions).toEqual([{ sessionId: "bad", reason: expect.any(String) }]);
  });

  it("degrades to empty decisions/comments when those files are corrupt (artifacts still group)", () => {
    const dir = path.join(tmpDir, ".deeppairing", "sessions", "s1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify([art({ id: "a1", title: "Milestone 6 — x" })]));
    fs.writeFileSync(path.join(dir, "decisions.json"), "{ broken");
    fs.writeFileSync(path.join(dir, "comments.json"), "also broken");
    const m6 = groupByFeature(tmpDir).groups.find((g) => g.id === "milestone-6")!;
    expect(m6.artifactCount).toBe(1);
    expect(m6.openItemCount).toBe(0);
  });
});
