/**
 * U1 (round-15) — THE WHERE-OVERLAY: a DERIVED read-model that joins the
 * session's open findings onto the changeset FILE RAIL.
 *
 * Round-15 found WHERE is the weakest comprehension axis: the findings, the
 * file rail and the shape diagrams all EXIST but don't LINK — the reviewer
 * cross-references "which file does this high-risk finding live in?" in their
 * head. This module closes that gap with ZERO agent burden and NO new schema
 * field: it cross-references data that already exists — each finding's
 * `evidence[].filePath` (from the session's present_findings / "research"
 * artifacts) against the files a changeset touches. So a reviewer dispositioning
 * files sees "auth/login.ts — 2 findings (1 high)" AS A SIDE EFFECT, riding the
 * forced changeset gate. That's why it's graveyard-proof.
 *
 * THE U2 SEAM (important): U2 is relaxing Evidence so `filePath`/`lineStart`/
 * `lineEnd` become OPTIONAL (evidence can anchor to a doc via a `locator`
 * instead). This join reads `filePath` ONLY when it is a present, non-empty
 * string — a finding whose evidence has no filePath (or a non-code locator)
 * simply badges no code file. No crash, no phantom badge. It therefore works
 * against BOTH the current schema (filePath required) and U2's relaxed one.
 */
import type { Artifact } from "@deeppairing/shared";
import { coerceResearchContent, isNotShippedStatus } from "@deeppairing/shared";

/** The effective severity used to color a file's overlay dot. Mirrors the
 *  ResearchArtifact severity vocabulary; `significance` (always present) fills
 *  in when a finding carries no explicit `severity`. */
export type OverlaySeverity = "info" | "low" | "medium" | "high" | "critical";

const SEV_RANK: Record<OverlaySeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** One finding that anchors to a given changed file. Carries just enough to
 *  navigate to it (artifactId + findingIndex → the `dp:focus-artifact` +
 *  `finding:${i}` anchor the rail already dispatches) and to name it. */
export interface FileFindingRef {
  artifactId: string;
  findingIndex: number;
  title: string;
  severity: OverlaySeverity;
}

/** The overlay for one changed file: how many findings land on it, the highest
 *  severity among them (drives the dot color), and the refs (highest-severity
 *  first, so a click jumps to the scariest one and the tooltip reads worst-down). */
export interface FileFindingOverlay {
  count: number;
  maxSeverity: OverlaySeverity;
  /** How many of the findings are high-or-critical — the "(N high)" half. */
  highCount: number;
  refs: FileFindingRef[];
}

/** A finding's effective severity: an explicit `severity` wins; otherwise the
 *  required `significance` enum (low/medium/high map straight across). */
function effectiveSeverity(finding: { severity?: string; significance?: string }): OverlaySeverity {
  const s = finding.severity;
  if (s === "info" || s === "low" || s === "medium" || s === "high" || s === "critical") return s;
  const sig = finding.significance;
  if (sig === "high" || sig === "medium" || sig === "low") return sig;
  return "info";
}

/** Normalize a path for matching: drop a leading "./" so an evidence path
 *  written "./auth/login.ts" still lands on a changeset file "auth/login.ts".
 *  Deliberately conservative — no basename fuzzing — so we never paint a
 *  phantom badge on the wrong file. */
function normPath(p: string): string {
  return p.replace(/^\.\//, "");
}

/** The session's live findings artifacts (present_findings → type "research"),
 *  scoped to one session and excluding discarded work (superseded/retracted/
 *  rejected/obsolete) so a stale v1 doesn't double-badge alongside its v2. */
export function sessionFindingsArtifacts(
  artifacts: Artifact[],
  sessionId: string | undefined,
): Artifact[] {
  return artifacts.filter(
    (a) =>
      a.type === "research" &&
      (sessionId == null || a.sessionId === sessionId) &&
      !isNotShippedStatus(a.status),
  );
}

/**
 * The core derived join. For each changed file, collect the findings whose
 * evidence anchors to it (file-grain; `lineStart`/`lineEnd` are read defensively
 * but not required — file-grain is the safe minimum). A single finding counts
 * ONCE per file even if several of its evidence items point at that file.
 */
export function computeFileFindingOverlay(
  files: { path: string }[],
  findingsArtifacts: Artifact[],
): Record<string, FileFindingOverlay> {
  // Map a normalized path back to the changeset's own spelling, so the result
  // is keyed by the exact `file.path` the rail renders with.
  const byNorm = new Map<string, string>();
  for (const f of files) byNorm.set(normPath(f.path), f.path);
  if (byNorm.size === 0) return {};

  const refsByFile: Record<string, FileFindingRef[]> = {};
  for (const art of findingsArtifacts) {
    let findings: ReturnType<typeof coerceResearchContent>["findings"];
    try {
      findings = coerceResearchContent(art.content).findings;
    } catch {
      continue; // never let one malformed artifact break the whole overlay
    }
    findings.forEach((finding, findingIndex) => {
      const ev = finding.evidence;
      // string evidence (legacy bare-ref) carries no structured file anchor.
      if (!Array.isArray(ev)) return;
      const severity = effectiveSeverity(finding);
      const title = finding.title?.trim() || finding.category?.trim() || `Finding ${findingIndex + 1}`;
      // Dedupe: one finding badges a given file once, even with N evidence hits.
      const hitPaths = new Set<string>();
      for (const item of ev) {
        // U2 SEAM: object evidence may (now / soon) lack filePath — read it only
        // when it's a present, non-empty string; a locator-only item is skipped.
        if (typeof item !== "object" || item == null) continue;
        const fp = (item as { filePath?: unknown }).filePath;
        if (typeof fp !== "string" || fp.trim() === "") continue;
        const origPath = byNorm.get(normPath(fp));
        if (!origPath || hitPaths.has(origPath)) continue;
        hitPaths.add(origPath);
        (refsByFile[origPath] ??= []).push({ artifactId: art.id, findingIndex, title, severity });
      }
    });
  }

  const out: Record<string, FileFindingOverlay> = {};
  for (const [path, refs] of Object.entries(refsByFile)) {
    // Highest-severity first (stable within a tier), so refs[0] is the scariest.
    refs.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
    const maxSeverity = refs[0]?.severity ?? "info";
    const highCount = refs.filter((r) => r.severity === "high" || r.severity === "critical").length;
    out[path] = { count: refs.length, maxSeverity, refs, highCount };
  }
  return out;
}

const SEV_WORD: Record<OverlaySeverity, string> = {
  info: "info",
  low: "low risk",
  medium: "medium risk",
  high: "high risk",
  critical: "critical",
};

/**
 * The accessible name / tooltip for a file's overlay badge. The severity is
 * spelled OUT here (not carried by color alone) so the badge passes the
 * color-is-not-the-only-signal bar, and the finding titles are listed so the
 * badge is useful even where navigation isn't wired (the tooltip minimum).
 */
export function describeFileFindingOverlay(overlay: FileFindingOverlay): string {
  const n = overlay.count;
  const head = `${n} finding${n === 1 ? "" : "s"} anchored here`;
  const topIsHigh = overlay.maxSeverity === "high" || overlay.maxSeverity === "critical";
  const sev =
    overlay.highCount > 0 && !topIsHigh
      ? `${SEV_WORD[overlay.maxSeverity]}, ${overlay.highCount} high`
      : overlay.highCount > 0
        ? `highest ${SEV_WORD[overlay.maxSeverity]}, ${overlay.highCount} high`
        : `highest ${SEV_WORD[overlay.maxSeverity]}`;
  const titles = overlay.refs.map((r) => r.title).join("; ");
  return `${head} (${sev}): ${titles}`;
}
