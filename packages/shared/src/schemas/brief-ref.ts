import { z } from "zod";

/**
 * #572 slice A — an exception card names its governing brief.
 *
 * `briefRef` is DECLARED relationship metadata on a decision artifact: "this
 * card is an exception to that exact brief version (and these of its
 * requirements / edge paths)". It is not drift detection, not authority, not
 * acceptance, and not proof a requirement was met. The version is pinned by
 * `artifactId` alone (every revision mints a new id); no version number is
 * stored, so a reader resolves version/status from that exact id or says
 * "version unknown" — never from a newer brief.
 *
 * This module is pure and dependency-light on purpose: the MCP tools, the
 * daemon and the companion web UI all read it, and the web must not import
 * the server-only #589 writer (`mcp/spec-ids.ts`).
 */

/** #589 — the spec id cap, in UTF-16 code units (`String#length`). One number
 *  for the spec writer (`mcp/spec-ids.ts` re-exports it) and for brief refs. */
export const MAX_SPEC_ID_LENGTH = 64;
/** At most this many ids in each of `requirementIds` / `edgePathIds`. */
export const MAX_BRIEF_REF_IDS = 8;
/** `artifactId` is 1–64 UTF-16 code units (generated ids are far shorter). */
export const MAX_BRIEF_REF_ARTIFACT_ID_LENGTH = 64;

/**
 * The persisted / snapshotted shape. Read-tolerant: no caps here, so a stored
 * ref is never rejected on load. The caps apply only to a NEW ref, through
 * `briefRefProblems` at the tool boundary.
 */
export const BriefRefSchema = z.object({
  artifactId: z.string(),
  requirementIds: z.array(z.string()).optional(),
  edgePathIds: z.array(z.string()).optional(),
}).strict();
export type BriefRef = z.infer<typeof BriefRefSchema>;

const REF_KEYS: ReadonlySet<string> = new Set(["artifactId", "requirementIds", "edgePathIds"]);

function show(s: string): string {
  return JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);
}

function listProblems(raw: unknown, field: string, problems: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    problems.push(`${field} must be an array of ids`);
    return;
  }
  if (raw.length > MAX_BRIEF_REF_IDS) problems.push(`${field} has ${raw.length} ids (at most ${MAX_BRIEF_REF_IDS})`);
  const seen = new Set<string>();
  raw.forEach((id, i) => {
    if (typeof id !== "string") {
      problems.push(`${field}[${i}] must be a string`);
      return;
    }
    if (id.trim().length === 0) problems.push(`${field}[${i}] is blank`);
    else if (id.length > MAX_SPEC_ID_LENGTH) problems.push(`${field}[${i}] ${show(id)} is ${id.length} characters (at most ${MAX_SPEC_ID_LENGTH})`);
    if (seen.has(id)) problems.push(`${field}[${i}] ${show(id)} is listed twice`);
    seen.add(id);
  });
}

/**
 * The NEW-ref policy (empty = acceptable). Any problem drops the WHOLE ref at
 * the caller; nothing is truncated, trimmed, deduplicated or split.
 */
export function briefRefProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["briefRef must be an object {artifactId, requirementIds?, edgePathIds?}"];
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(obj)) if (!REF_KEYS.has(k)) problems.push(`unknown key ${show(k)}`);
  const id = obj.artifactId;
  if (typeof id !== "string") problems.push("artifactId must be a string");
  else if (id.trim().length === 0) problems.push("artifactId is blank");
  else if (id.length > MAX_BRIEF_REF_ARTIFACT_ID_LENGTH) problems.push(`artifactId is ${id.length} characters (at most ${MAX_BRIEF_REF_ARTIFACT_ID_LENGTH})`);
  listProblems(obj.requirementIds, "requirementIds", problems);
  listProblems(obj.edgePathIds, "edgePathIds", problems);
  return problems;
}

/**
 * Read a stored `briefRef` without revalidating it destructively.
 *  - `undefined` → no ref was saved;
 *  - `{ok: true}` → a well-formed ref that also meets the ref policy
 *    (`briefRefProblems`: caps, non-blank, no duplicate ids in a list);
 *  - `{ok: false}` → present but malformed OR out of policy: render the raw
 *    id (if any) as unavailable, version unknown, never as a resolved pin.
 * Classification only: the stored value is never rejected, truncated,
 * deduplicated or rewritten, and the artifact carrying it still loads.
 * (Legacy duplicate/numeric SPEC rows are a separate concern: matchBriefGrain.)
 */
export function readBriefRef(raw: unknown): { ok: true; ref: BriefRef } | { ok: false; rawId?: string } | undefined {
  if (raw === undefined) return undefined;
  const parsed = BriefRefSchema.safeParse(raw);
  if (parsed.success && briefRefProblems(raw).length === 0) return { ok: true, ref: parsed.data };
  const rawId = raw && typeof raw === "object" && typeof (raw as { artifactId?: unknown }).artifactId === "string"
    ? (raw as { artifactId: string }).artifactId
    : undefined;
  return { ok: false, ...(rawId !== undefined ? { rawId } : {}) };
}

/**
 * HISTORICAL CARRY reader (shape only). A revision carries its predecessor's
 * stored relationship exactly as far as it is shape-readable — including a
 * legacy pin that is out of the new-ref policy (duplicate, blank, over-cap)
 * and that `readBriefRef` therefore PRESENTS as unavailable. Carry is not
 * presentation: it never applies `briefRefProblems`, never rejects the
 * artifact and never normalizes the arrays. Undefined when nothing
 * shape-readable is stored.
 */
export function carryableBriefRef(raw: unknown): BriefRef | undefined {
  if (raw === undefined) return undefined;
  const parsed = BriefRefSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** known = exactly one explicit-id match; unknown = none; ambiguous = 2+. */
export type BriefGrainMatch = "known" | "unknown" | "ambiguous";

/**
 * Exact explicit-id lookup in a stored row list (a spec's `requirements` or
 * `edgePaths`). No trim, no case-fold, no index or first-match fallback: an
 * id-less row at position 2 never matches "2", while a unique legacy row whose
 * explicit id is "2" does. Read-compatible — never runs #589's writer policy.
 */
export function matchBriefGrain(rows: unknown, id: string): BriefGrainMatch {
  if (!Array.isArray(rows)) return "unknown";
  let n = 0;
  for (const row of rows) {
    if (row && typeof row === "object" && (row as { id?: unknown }).id === id) n++;
  }
  return n === 0 ? "unknown" : n === 1 ? "known" : "ambiguous";
}

export interface BriefGrainView {
  kind: "requirement" | "edgePath";
  id: string;
  /** Absent when the pinned brief itself is unavailable. */
  match?: BriefGrainMatch;
}

/** Statuses after which a pinned brief is historical (no successor implied). */
export const BRIEF_CLOSED_STATUSES: ReadonlySet<string> = new Set(["superseded", "rejected", "retracted", "obsolete"]);

/** The minimal artifact shape a pin lookup reads. */
export interface BriefLookupArtifact {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  version: number;
  status: string;
  content: Record<string, unknown>;
}

export interface BriefPinView {
  artifactId: string;
  /** False when the exact pinned spec isn't in this session (yet, or at all). */
  available: boolean;
  title?: string;
  version?: number;
  status?: string;
  /** The pinned version is superseded/rejected/retracted/obsolete. */
  closed: boolean;
  grains: BriefGrainView[];
}

/**
 * Resolve a saved pin for display: the EXACT artifact id, same session, type
 * spec. Never walks to a successor, never picks "the current brief".
 */
export function describeBriefPin(ref: BriefRef, artifacts: readonly BriefLookupArtifact[], sessionId: string): BriefPinView {
  const brief = artifacts.find((a) => a.id === ref.artifactId && a.sessionId === sessionId && a.type === "spec");
  const ids = (list: string[] | undefined, kind: BriefGrainView["kind"], rows: unknown): BriefGrainView[] =>
    (list ?? []).map((id) => (brief ? { kind, id, match: matchBriefGrain(rows, id) } : { kind, id }));
  const content = brief?.content as { requirements?: unknown; edgePaths?: unknown } | undefined;
  const grains = [
    ...ids(ref.requirementIds, "requirement", content?.requirements),
    ...ids(ref.edgePathIds, "edgePath", content?.edgePaths),
  ];
  if (!brief) return { artifactId: ref.artifactId, available: false, closed: false, grains };
  return {
    artifactId: ref.artifactId,
    available: true,
    title: brief.title,
    version: brief.version,
    status: brief.status,
    closed: BRIEF_CLOSED_STATUSES.has(brief.status),
    grains,
  };
}

function grainLabel(g: BriefGrainView): string {
  const name = g.kind === "edgePath" ? `edge path ${g.id}` : g.id;
  return g.match === "unknown" ? `${name} (unknown)` : g.match === "ambiguous" ? `${name} (ambiguous)` : name;
}

/** One text line for a pin: `Exception to "Brief" v2 · REQ-1 (superseded)`. */
export function formatBriefPin(view: BriefPinView): string {
  const grains = view.grains.length > 0 ? ` · ${view.grains.map(grainLabel).join(", ")}` : "";
  if (!view.available) return `Exception to brief ${view.artifactId} (version unknown, brief unavailable)${grains}`;
  const closed = view.closed ? ` (${view.status})` : "";
  return `Exception to "${view.title}" v${view.version}${grains}${closed}`;
}
