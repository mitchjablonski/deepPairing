import {
  BriefRefSchema,
  briefRefProblems,
  describeBriefPin,
  formatBriefPin,
  readBriefRef,
  type Artifact,
  type BriefPinView,
  type BriefRef,
} from "@deeppairing/shared";
import { stableStringify } from "./proposal-resolution.js";

/**
 * #572 slice A — the server side of `briefRef` on present_options.
 *
 * NORMALIZE ONCE. A new ref is normalized exactly once, where the proposal is
 * resolved for its write (the normal create, or the snapshot a block binds).
 * The result — the pin, or its absence after a dropped ref — is what gets
 * saved, snapshotted and digested. Nothing downstream re-normalizes raw input:
 * an allowance claim reuses the pin the human allowed (the daemon hands it
 * back through `inspect`, see frozenBriefRef), and every replay / dedup reads
 * the pin off the saved artifact. Write-time warnings appear only in the
 * response that made the write; later responses carry advisories derived from
 * the saved pin, labelled "current".
 */

export interface BriefRefNormalization {
  /** The pin to persist; absent when none was given or the ref was dropped. */
  ref?: BriefRef;
  /** Agent-facing lines for the response that made this write. */
  notes: string[];
}

const DROPPED = "briefRef dropped, so this card has no brief link:";

/** True when the caller sent a `briefRef` key at all (any value). */
export function hasRawBriefRef(args: unknown): boolean {
  return !!args && typeof args === "object" && (args as { briefRef?: unknown }).briefRef !== undefined;
}

/**
 * Normalize a NEW ref against this session's artifacts. Never throws, never
 * truncates, never searches another session, never substitutes a successor.
 */
export function normalizeNewBriefRef(raw: unknown, artifacts: readonly Artifact[] | null, sessionId: string): BriefRefNormalization {
  if (raw === undefined) return { notes: [] };
  const problems = briefRefProblems(raw);
  if (problems.length > 0) {
    return { notes: [`${DROPPED} ${problems.join("; ")}. Nothing was truncated; the card itself was presented. Fix the ref and present a new card if it should name its brief.`] };
  }
  const parsed = BriefRefSchema.parse(raw);
  // Exactly the given keys, in canonical form (no trimming, no dedup).
  const ref: BriefRef = {
    artifactId: parsed.artifactId,
    ...(parsed.requirementIds ? { requirementIds: [...parsed.requirementIds] } : {}),
    ...(parsed.edgePathIds ? { edgePathIds: [...parsed.edgePathIds] } : {}),
  };
  if (!artifacts) {
    return { notes: [`${DROPPED} this session's artifacts couldn't be read to check ${ref.artifactId}. The card itself was presented.`] };
  }
  const target = artifacts.find((a) => a.id === ref.artifactId);
  if (!target || target.sessionId !== sessionId) {
    return { notes: [`${DROPPED} ${ref.artifactId} is not an artifact in this session. Other sessions aren't searched. The card itself was presented.`] };
  }
  if (target.type !== "spec") {
    return { notes: [`${DROPPED} ${ref.artifactId} is a ${target.type}, not a brief (a present_spec artifact). The card itself was presented.`] };
  }
  const view = describeBriefPin(ref, artifacts, sessionId);
  const notes = [`Linked: ${formatBriefPin(view)}. This is a declared link, not a check that the requirement is the right one.`];
  if (view.closed) {
    notes.push(`The pinned brief ${ref.artifactId} (v${view.version}) is ${view.status}. The link stays on that exact version and was not moved to a newer one. To raise this against the current brief, present a new card with its id.`);
  }
  for (const g of view.grains) {
    const what = g.kind === "edgePath" ? "edge path" : "requirement";
    if (g.match === "unknown") notes.push(`${what} ${JSON.stringify(g.id)} isn't in ${ref.artifactId} v${view.version}. It's kept and marked unknown.`);
    if (g.match === "ambiguous") notes.push(`${what} ${JSON.stringify(g.id)} matches more than one row in ${ref.artifactId} v${view.version} (a legacy duplicate id). It's kept and marked ambiguous.`);
  }
  return { ref, notes };
}

/** The write-time notes as a response suffix. */
export function formatBriefNotes(n: BriefRefNormalization): string {
  return n.notes.length > 0 ? `\n\n${n.notes.join("\n")}` : "";
}

/**
 * A CURRENT advisory derived only from the saved artifact's pin: what a
 * replay, a committed retry or a dedup hit says. Never mutates or retargets
 * the pin, and never reconstructs a link the save didn't keep.
 */
export function savedBriefAdvisory(saved: Artifact | undefined, args: unknown, artifacts: readonly Artifact[]): string {
  if (!saved) return "";
  const read = readBriefRef(saved.briefRef);
  if (read === undefined) {
    return hasRawBriefRef(args)
      ? `\n\nNo brief link was saved for ${saved.id}; the original reason is unavailable on replay. To link it, present a new card.`
      : "";
  }
  if (!read.ok) {
    return `\n\nBrief link (current): the saved link${read.rawId ? ` to ${read.rawId}` : ""} is unreadable, so it's shown raw and marked unavailable.`;
  }
  const view = describeBriefPin(read.ref, artifacts, saved.sessionId);
  return `\n\nBrief link (current, from the saved card): ${formatBriefPin(view)}.`;
}

/** The structured echo of a saved pin (check_feedback `decisions[].briefRef`). */
export interface BriefRefEcho {
  artifactId: string | null;
  /** The pinned version's number, or "unknown" when that exact brief is unavailable. */
  version: number | "unknown";
  /** The pinned version's status, or "unavailable". */
  status: string;
  requirementIds: string[];
  edgePathIds: string[];
  /** Per-grain match within the pinned version ("unavailable" without the brief). */
  grains: Array<{ kind: "requirement" | "edgePath"; id: string; match: string }>;
  /** Present (true) only for a stored ref that couldn't be read. */
  malformed?: true;
}

/**
 * #572 — the resolved-decision echo, sourced from the SAVED decision artifact
 * (`decision`) and the exact pinned brief in that artifact's session. Null when
 * the decision artifact is unavailable or carries no ref: only the echo is
 * omitted, never the decision.
 */
export function briefEchoOf(decision: Artifact | undefined, artifacts: readonly Artifact[]): { line: string; echo: BriefRefEcho } | null {
  if (!decision) return null;
  const read = readBriefRef(decision.briefRef);
  if (read === undefined) return null;
  if (!read.ok) {
    return {
      line: `Exception to an unreadable brief link${read.rawId ? ` (${read.rawId})` : ""}, version unknown`,
      echo: { artifactId: read.rawId ?? null, version: "unknown", status: "unavailable", requirementIds: [], edgePathIds: [], grains: [], malformed: true },
    };
  }
  const view: BriefPinView = describeBriefPin(read.ref, artifacts, decision.sessionId);
  return {
    line: formatBriefPin(view),
    echo: {
      artifactId: read.ref.artifactId,
      version: view.available && typeof view.version === "number" ? view.version : "unknown",
      status: view.available && view.status ? view.status : "unavailable",
      requirementIds: [...(read.ref.requirementIds ?? [])],
      edgePathIds: [...(read.ref.edgePathIds ?? [])],
      grains: view.grains.map((g) => ({ kind: g.kind, id: g.id, match: g.match ?? "unavailable" })),
    },
  };
}

/**
 * The pin an allowance froze, as the daemon's `inspect` reports it on each
 * candidate (`frozenBriefRef`: the ref, or null for "no ref saved"). Returns
 * `{found: false}` when the daemon predates the field or the candidates
 * disagree — the caller then keeps its own resolution, and the daemon's
 * digest check decides as before.
 */
export function frozenBriefRefOf(candidates: ReadonlyArray<Record<string, unknown>>): { found: true; ref?: BriefRef } | { found: false } {
  if (candidates.length === 0) return { found: false };
  let first: string | undefined;
  let value: BriefRef | undefined;
  for (const c of candidates) {
    if (!Object.prototype.hasOwnProperty.call(c, "frozenBriefRef")) return { found: false };
    const raw = c.frozenBriefRef;
    let ref: BriefRef | undefined;
    if (raw !== null) {
      const parsed = BriefRefSchema.safeParse(raw);
      if (!parsed.success) return { found: false };
      ref = parsed.data;
    }
    const key = stableStringify(ref ?? null);
    if (first === undefined) { first = key; value = ref; }
    else if (key !== first) return { found: false };
  }
  return value ? { found: true, ref: value } : { found: true };
}
