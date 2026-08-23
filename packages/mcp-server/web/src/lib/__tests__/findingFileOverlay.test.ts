import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import {
  computeFileFindingOverlay,
  sessionFindingsArtifacts,
  describeFileFindingOverlay,
} from "../findingFileOverlay";

/**
 * U1 (round-15) — THE WHERE-OVERLAY join. Fail-on-revert pins for the derived
 * read-model that pins open findings onto the changeset file rail. The join
 * reads only data that already exists (finding.evidence[].filePath ×
 * changeset.files) — no schema field, no agent burden.
 */

function research(
  id: string,
  findings: Array<Record<string, unknown>>,
  over: Partial<Artifact> = {},
): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: "Findings",
    status: "draft",
    content: { summary: "s", findings },
    agentReasoning: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
    ...over,
  } as Artifact;
}

const FILES = [{ path: "auth/login.ts" }, { path: "auth/session.ts" }, { path: "db/pool.ts" }];

describe("computeFileFindingOverlay — the WHERE-overlay join", () => {
  it("badges a changed file with the count + max severity of findings whose evidence.filePath lands on it", () => {
    const art = research("r1", [
      {
        category: "security",
        title: "Session fixation",
        detail: "d",
        significance: "high",
        severity: "high",
        evidence: [{ filePath: "auth/login.ts", lineStart: 10, lineEnd: 12, snippet: "x", explanation: "e" }],
      },
      {
        category: "style",
        title: "Naming nit",
        detail: "d",
        significance: "low",
        severity: "low",
        evidence: [{ filePath: "auth/login.ts", lineStart: 40, lineEnd: 40, snippet: "y", explanation: "e" }],
      },
    ]);
    const out = computeFileFindingOverlay(FILES, [art]);
    expect(out["auth/login.ts"]!.count).toBe(2);
    expect(out["auth/login.ts"]!.maxSeverity).toBe("high"); // max of high + low
    expect(out["auth/login.ts"]!.highCount).toBe(1);
    // refs are highest-severity first → a click lands on the scariest.
    expect(out["auth/login.ts"]!.refs[0]!.title).toBe("Session fixation");
    expect(out["auth/login.ts"]!.refs[0]!.artifactId).toBe("r1");
    expect(out["auth/login.ts"]!.refs[0]!.findingIndex).toBe(0);
    // The other changed files carry no finding → no entry.
    expect(out["auth/session.ts"]).toBeUndefined();
    expect(out["db/pool.ts"]).toBeUndefined();
  });

  it("a finding whose evidence matches NO changed file badges nothing", () => {
    const art = research("r1", [
      {
        category: "perf",
        title: "N+1 query",
        detail: "d",
        significance: "medium",
        evidence: [{ filePath: "api/handlers.ts", lineStart: 5, lineEnd: 5, snippet: "z", explanation: "e" }],
      },
    ]);
    const out = computeFileFindingOverlay(FILES, [art]);
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("THE U2 SEAM — a finding whose evidence has NO filePath badges nothing and does not crash", () => {
    const art = research("r1", [
      {
        category: "contract",
        title: "Ambiguous clause",
        detail: "d",
        significance: "high",
        // U2 relaxes filePath to optional (doc-anchored via a locator). Evidence
        // with no filePath must be skipped cleanly — no badge, no throw.
        evidence: [
          { lineStart: 3, snippet: "the clause", explanation: "e" } as unknown as Record<string, unknown>,
          { filePath: "", snippet: "empty", explanation: "e" } as unknown as Record<string, unknown>,
          { locator: "§5¶3", snippet: "doc", explanation: "e" } as unknown as Record<string, unknown>,
        ],
      },
    ]);
    expect(() => computeFileFindingOverlay(FILES, [art])).not.toThrow();
    expect(Object.keys(computeFileFindingOverlay(FILES, [art]))).toHaveLength(0);
  });

  it("string-only evidence (legacy bare ref) badges nothing", () => {
    const art = research("r1", [
      { category: "arch", title: "High-level", detail: "d", significance: "high", evidence: "see the auth flow" },
      { category: "arch", title: "No evidence", detail: "d", significance: "high" },
    ]);
    expect(Object.keys(computeFileFindingOverlay(FILES, [art]))).toHaveLength(0);
  });

  it("falls back to significance when a finding carries no explicit severity", () => {
    const art = research("r1", [
      {
        category: "x",
        title: "Sig-only",
        detail: "d",
        significance: "medium",
        evidence: [{ filePath: "db/pool.ts", lineStart: 1, lineEnd: 1, snippet: "q", explanation: "e" }],
      },
    ]);
    const out = computeFileFindingOverlay(FILES, [art]);
    expect(out["db/pool.ts"]!.maxSeverity).toBe("medium");
  });

  it("counts a finding ONCE per file even with multiple evidence hits on it; spans multiple files", () => {
    const art = research("r1", [
      {
        category: "x",
        title: "Spans two files",
        detail: "d",
        significance: "high",
        severity: "high",
        evidence: [
          { filePath: "auth/login.ts", lineStart: 1, lineEnd: 1, snippet: "a", explanation: "e" },
          { filePath: "auth/login.ts", lineStart: 9, lineEnd: 9, snippet: "b", explanation: "e" },
          { filePath: "auth/session.ts", lineStart: 2, lineEnd: 2, snippet: "c", explanation: "e" },
        ],
      },
    ]);
    const out = computeFileFindingOverlay(FILES, [art]);
    expect(out["auth/login.ts"]!.count).toBe(1); // deduped
    expect(out["auth/session.ts"]!.count).toBe(1); // same finding, other file
  });

  it("normalizes a leading ./ so ./auth/login.ts lands on auth/login.ts", () => {
    const art = research("r1", [
      {
        category: "x",
        title: "Dot-slash",
        detail: "d",
        significance: "high",
        severity: "critical",
        evidence: [{ filePath: "./auth/login.ts", lineStart: 1, lineEnd: 1, snippet: "a", explanation: "e" }],
      },
    ]);
    const out = computeFileFindingOverlay(FILES, [art]);
    expect(out["auth/login.ts"]!.maxSeverity).toBe("critical");
    // The result is keyed by the changeset's own spelling.
    expect(out["./auth/login.ts"]).toBeUndefined();
  });

  it("aggregates findings from multiple research artifacts onto one file", () => {
    const a = research("r1", [
      { category: "x", title: "F1", detail: "d", significance: "medium", severity: "medium", evidence: [{ filePath: "auth/login.ts", lineStart: 1, lineEnd: 1, snippet: "a", explanation: "e" }] },
    ]);
    const b = research("r2", [
      { category: "x", title: "F2", detail: "d", significance: "high", severity: "high", evidence: [{ filePath: "auth/login.ts", lineStart: 2, lineEnd: 2, snippet: "b", explanation: "e" }] },
    ]);
    const out = computeFileFindingOverlay(FILES, [a, b]);
    expect(out["auth/login.ts"]!.count).toBe(2);
    expect(out["auth/login.ts"]!.maxSeverity).toBe("high");
  });

  it("empty files or empty findings yield an empty overlay", () => {
    expect(computeFileFindingOverlay([], [research("r1", [])])).toEqual({});
    expect(computeFileFindingOverlay(FILES, [])).toEqual({});
  });
});

describe("sessionFindingsArtifacts — scope + discard filtering", () => {
  it("keeps only same-session, live research artifacts", () => {
    const arts: Artifact[] = [
      research("r_live", []),
      research("r_other_session", [], { sessionId: "s2" }),
      research("r_superseded", [], { status: "superseded" }),
      research("r_rejected", [], { status: "rejected" }),
      research("r_approved", [], { status: "approved" }),
      { ...research("not_research", []), type: "changeset" } as Artifact,
    ];
    const kept = sessionFindingsArtifacts(arts, "s1").map((a) => a.id);
    expect(kept).toContain("r_live");
    expect(kept).toContain("r_approved"); // approved findings still say where risk lives
    expect(kept).not.toContain("r_other_session");
    expect(kept).not.toContain("r_superseded");
    expect(kept).not.toContain("r_rejected");
    expect(kept).not.toContain("not_research");
  });
});

describe("describeFileFindingOverlay — accessible name spells out severity (not color-only)", () => {
  it("names the count, the severity word, and the finding titles", () => {
    const art = research("r1", [
      { category: "x", title: "Session fixation", detail: "d", significance: "high", severity: "high", evidence: [{ filePath: "auth/login.ts", lineStart: 1, lineEnd: 1, snippet: "a", explanation: "e" }] },
      { category: "x", title: "Naming nit", detail: "d", significance: "low", severity: "low", evidence: [{ filePath: "auth/login.ts", lineStart: 2, lineEnd: 2, snippet: "b", explanation: "e" }] },
    ]);
    const label = describeFileFindingOverlay(computeFileFindingOverlay(FILES, [art])["auth/login.ts"]!);
    expect(label).toContain("2 findings");
    expect(label).toContain("high risk");
    expect(label).toContain("Session fixation");
    expect(label).toContain("Naming nit");
  });
});
