import { matchBriefGrain, readBriefRef, type Artifact, type BriefGrainMatch } from "@deeppairing/shared";

/**
 * #572 slice A2 — the brief's EXCEPTION INDEX: which decision cards declare
 * (via their saved `briefRef`, slice A) that they are exceptions to this brief.
 *
 * One pure, read-only derivation shared by the brief-level summary, the
 * per-requirement lists on the spec, and the governing-brief strip count, so
 * all three show the same numbers. It adds no field, endpoint, acknowledgement,
 * attention lane or authority; it never infers drift or requirement
 * completion. A listed card is a declared link, nothing more.
 *
 * Rules (Sol's A2 contract on #572, as amended by the root disposition):
 *  - Only the brief's OWN session is read. Other sessions never supply cards,
 *    ancestry, labels or diagnostic members.
 *  - A LINEAGE is explicit `parentId` ancestry among same-session decision
 *    artifacts (never title/context/decisionId). A well-formed unbranched
 *    component collapses to its one terminal card, counted once whatever its
 *    status. Only the terminal's own pin is read (no ancestor pin borrowing).
 *  - A missing parent leaves an identified component with INCOMPLETE history.
 *    Branches, cycles, duplicate ids and cross-type parents make the component
 *    AMBIGUOUS: excluded from every total, shown as a diagnostic (only when a
 *    member's saved pin names this brief or a verified ancestor of it).
 *  - Pins go through the policy-aware `readBriefRef`. An unreadable or
 *    out-of-policy pin is never counted; it is a diagnostic when it names this
 *    brief (or a verified ancestor). Pins to other / unavailable briefs,
 *    siblings or descendants are not counted here.
 *  - A pin to the exact brief is attributed per requirement by EXACT raw
 *    explicit id (`matchBriefGrain`). A unique match lists the card under that
 *    requirement; an unknown or ambiguous id is "unattributed" (it still
 *    counts once per lineage in the brief total, never in requirement
 *    coverage). Whole-brief / edge-path-only pins are "not
 *    requirement-specific".
 *  - A pin to a verified ANCESTOR version is historical: grouped by the exact
 *    pinned artifact id + raw grain, labelled "raised against vN", never
 *    attached to a current requirement row by a reused id.
 *  - Status buckets are the terminal's exact artifact status only (Sol's
 *    final A2 review: no recorded selected-choice claim, no confirmation
 *    state, no "awaiting/saving selection"). `revised` is shown as its own
 *    exact status, never as an open ancestor. An approved card is a resolved
 *    CARD, never a satisfied requirement; its choice is unverified here. A
 *    superseded terminal with no visible successor is incomplete, never
 *    live or open.
 */

export type ExceptionBucket = "draft" | "reviewing" | "approved" | "rejected" | "retracted" | "obsolete" | "incomplete" | "other";

export const EXCEPTION_BUCKETS: readonly ExceptionBucket[] = ["draft", "reviewing", "approved", "rejected", "retracted", "obsolete", "incomplete", "other"];

export const EXCEPTION_BUCKET_LABELS: Record<ExceptionBucket, string> = {
  draft: "draft",
  reviewing: "reviewing",
  approved: "approved · choice unverified",
  rejected: "rejected",
  retracted: "retracted",
  obsolete: "obsolete",
  incomplete: "superseded, no visible successor",
  other: "other status", // shown with the exact status string
};

export function exceptionBucket(status: string): ExceptionBucket {
  switch (status) {
    case "draft":
    case "reviewing":
    case "approved":
    case "rejected":
    case "retracted":
    case "obsolete":
      return status as ExceptionBucket;
    case "superseded":
      return "incomplete";
    default:
      return "other";
  }
}

export interface ExceptionGrain {
  kind: "requirement" | "edgePath";
  id: string;
  match: BriefGrainMatch;
}

export interface ExceptionEntry {
  /** The lineage's terminal decision (the card the lists navigate to). */
  decisionId: string;
  title: string;
  status: string;
  bucket: ExceptionBucket;
  /** The lineage's root names a parent that isn't visible in this session. */
  incompleteHistory: boolean;
  /** The exact brief version the card's saved pin names. */
  pinnedBriefId: string;
  pinnedVersion: number;
  /** The pin names a verified earlier version, not the brief being viewed. */
  historical: boolean;
  /** Every grain of the pin, matched against the PINNED version's rows. */
  grains: ExceptionGrain[];
}

export interface HistoricalGroup {
  /** `${pinnedBriefId}\u0000${grain}` — the exact pinned artifact id, not the version number. */
  key: string;
  pinnedBriefId: string;
  pinnedVersion: number;
  /** null = the pin names no grain (whole brief). */
  grain: ExceptionGrain | null;
  entries: ExceptionEntry[];
}

export interface AmbiguousLineage {
  /** Exact ids of the accessible same-session members, in store order. */
  memberIds: string[];
  reasons: string[];
}

export interface UnreadablePin {
  decisionId: string;
  rawId: string | undefined;
}

export interface BriefExceptionIndex {
  briefId: string;
  /** The brief's own id is duplicated in its session: nothing can be attributed. */
  briefIdAmbiguous: boolean;
  /** Distinct identified lineages linked to this brief (exact or historical), each once. */
  total: number;
  buckets: Record<ExceptionBucket, number>;
  /** Exact status strings behind the "other" bucket, with their lineage counts. */
  otherStatuses: Record<string, number>;
  /** Counted lineages whose history is incomplete (missing parent). */
  incompleteHistory: number;
  entries: ExceptionEntry[];
  /** Unique raw explicit requirement ids on the viewed brief, in order. */
  requirementIds: string[];
  /** Exact-version cards per requirement id (a card may sit under several). */
  byRequirement: Record<string, ExceptionEntry[]>;
  /** Exact-version cards with a whole-brief or edge-path-only pin. */
  briefLevel: ExceptionEntry[];
  /** Exact-version cards with an unknown / ambiguous grain, and which grains. */
  unattributed: Array<{ entry: ExceptionEntry; grains: ExceptionGrain[] }>;
  historical: HistoricalGroup[];
  ambiguous: AmbiguousLineage[];
  unreadable: UnreadablePin[];
}

function emptyBuckets(): Record<ExceptionBucket, number> {
  return { draft: 0, reviewing: 0, approved: 0, rejected: 0, retracted: 0, obsolete: 0, incomplete: 0, other: 0 };
}

/** Unique explicit string ids of a stored row list, in order (never generated/index ids). */
function uniqueExplicitIds(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows) {
    const id = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
    if (typeof id === "string" && !ids.includes(id) && matchBriefGrain(rows, id) === "known") ids.push(id);
  }
  return ids;
}

function grainsFor(ref: { requirementIds?: string[]; edgePathIds?: string[] }, spec: Artifact): ExceptionGrain[] {
  const content = (spec.content ?? {}) as { requirements?: unknown; edgePaths?: unknown };
  return [
    ...(ref.requirementIds ?? []).map((id) => ({ kind: "requirement" as const, id, match: matchBriefGrain(content.requirements, id) })),
    ...(ref.edgePathIds ?? []).map((id) => ({ kind: "edgePath" as const, id, match: matchBriefGrain(content.edgePaths, id) })),
  ];
}

/**
 * Verified spec ancestors of the brief: explicit parentId, same session, type
 * spec, exactly one artifact per id. Stops at a missing / duplicate / non-spec
 * parent; a cycle verifies nothing (the "ancestor" would also be a descendant).
 */
function verifiedAncestors(byId: Record<string, Artifact[]>, brief: Artifact): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>([brief.id]);
  let parentId = brief.parentId;
  while (parentId) {
    if (seen.has(parentId)) return [];
    seen.add(parentId);
    const found = byId[parentId] ?? [];
    if (found.length !== 1 || found[0]!.type !== "spec") break;
    out.push(found[0]!);
    parentId = found[0]!.parentId;
  }
  return out;
}

/**
 * @param artifacts every artifact in the store (superseded included: lineage
 *   needs them). Only those in `sessionId` are read.
 */
export function buildBriefExceptionIndex(artifacts: readonly Artifact[], briefId: string, sessionId: string): BriefExceptionIndex {
  const session = artifacts.filter((a) => a.sessionId === sessionId);
  const byId: Record<string, Artifact[]> = {};
  for (const a of session) (byId[a.id] ??= []).push(a);

  const index: BriefExceptionIndex = {
    briefId, briefIdAmbiguous: false, total: 0, buckets: emptyBuckets(), otherStatuses: {}, incompleteHistory: 0,
    entries: [], requirementIds: [], byRequirement: {}, briefLevel: [], unattributed: [], historical: [], ambiguous: [], unreadable: [],
  };
  const briefs = (byId[briefId] ?? []).filter((a) => a.type === "spec");
  if ((byId[briefId] ?? []).length > 1) {
    index.briefIdAmbiguous = true;
    return index;
  }
  const brief = briefs[0];
  if (!brief) return index;
  const ancestors = verifiedAncestors(byId, brief);
  const linked = new Map<string, Artifact>([[brief.id, brief], ...ancestors.map((a) => [a.id, a] as const)]);
  index.requirementIds = uniqueExplicitIds((brief.content as { requirements?: unknown } | undefined)?.requirements);
  for (const id of index.requirementIds) index.byRequirement[id] = [];

  // ── Lineage components over same-session decisions (node = array position,
  //    so duplicate ids stay distinct nodes and are flagged, never merged).
  const nodes = session.filter((a) => a.type === "decision");
  const posById: Record<string, number[]> = {};
  nodes.forEach((d, i) => (posById[d.id] ??= []).push(i));
  const comp = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (comp[i] !== i) { comp[i] = comp[comp[i]!]!; i = comp[i]!; }
    return i;
  };
  const union = (a: number, b: number) => { comp[find(a)] = find(b); };
  // Duplicate ids are one ambiguous component (no array-first winner).
  for (const same of Object.values(posById)) for (const p of same.slice(1)) union(p, same[0]!);
  const parentOf: Array<number | null> = nodes.map(() => null);
  const flags: string[][] = nodes.map(() => []);
  const missingParent: boolean[] = nodes.map(() => false);
  nodes.forEach((d, i) => {
    if ((posById[d.id] ?? []).length > 1) flags[i]!.push(`duplicate id ${d.id}`);
    const pid = d.parentId;
    if (!pid) return;
    const sameSession = byId[pid] ?? [];
    if (sameSession.length === 0) { missingParent[i] = true; return; }
    if (sameSession.length > 1) flags[i]!.push(`parent ${pid} is not unique`);
    if (sameSession.some((p) => p.type !== "decision")) flags[i]!.push(`parent ${pid} is not a decision`);
    const decisionParents = posById[pid] ?? [];
    for (const p of decisionParents) union(i, p);
    if (decisionParents.length === 1 && sameSession.length === 1) parentOf[i] = decisionParents[0]!;
  });
  const children: number[][] = nodes.map(() => []);
  parentOf.forEach((p, i) => { if (p !== null) children[p]!.push(i); });

  const members: Record<number, number[]> = {};
  nodes.forEach((_, i) => (members[find(i)] ??= []).push(i));

  /** The saved pin's raw artifact id, readable or not (diagnostic routing). */
  const pinRawId = (d: Artifact): string | undefined => {
    const read = readBriefRef(d.briefRef);
    return read === undefined ? undefined : read.ok ? read.ref.artifactId : read.rawId;
  };
  const historicalGroups = new Map<string, HistoricalGroup>();

  for (const group of Object.values(members)) {
    const reasons = group.flatMap((i) => flags[i]!);
    const roots = group.filter((i) => parentOf[i] === null);
    if (group.some((i) => children[i]!.length > 1)) reasons.push("branched lineage");
    if (roots.length === 0) reasons.push("cyclic lineage");
    else if (roots.length > 1 && reasons.length === 0) reasons.push("lineage has several roots");
    const terminals = group.filter((i) => children[i]!.length === 0);
    if (reasons.length > 0 || terminals.length !== 1) {
      if (group.some((i) => { const raw = pinRawId(nodes[i]!); return raw !== undefined && linked.has(raw); })) {
        index.ambiguous.push({ memberIds: group.map((i) => nodes[i]!.id), reasons: [...new Set(reasons)] });
      }
      continue;
    }
    const terminal = nodes[terminals[0]!]!;
    const read = readBriefRef(terminal.briefRef);
    if (read === undefined) continue; // unlinked (legacy / no pin): not evidence of anything
    if (!read.ok) {
      if (read.rawId !== undefined && linked.has(read.rawId)) index.unreadable.push({ decisionId: terminal.id, rawId: read.rawId });
      continue;
    }
    const pinned = linked.get(read.ref.artifactId);
    if (!pinned) continue; // another brief, a sibling/descendant, or unavailable
    const status = String(terminal.status);
    const entry: ExceptionEntry = {
      decisionId: terminal.id,
      title: terminal.title,
      status,
      bucket: exceptionBucket(status),
      incompleteHistory: roots.some((i) => missingParent[i]),
      pinnedBriefId: pinned.id,
      pinnedVersion: typeof pinned.version === "number" ? pinned.version : 1,
      historical: pinned.id !== brief.id,
      grains: grainsFor(read.ref, pinned),
    };
    index.entries.push(entry);
    index.total++;
    index.buckets[entry.bucket]++;
    if (entry.bucket === "other") index.otherStatuses[status] = (index.otherStatuses[status] ?? 0) + 1;
    if (entry.incompleteHistory) index.incompleteHistory++;

    if (entry.historical) {
      const keyed = entry.grains.length > 0 ? entry.grains : [null];
      for (const g of keyed) {
        const key = `${entry.pinnedBriefId}\u0000${g ? `${g.kind}:${g.id}` : "whole"}`;
        let hg = historicalGroups.get(key);
        if (!hg) {
          hg = { key, pinnedBriefId: entry.pinnedBriefId, pinnedVersion: entry.pinnedVersion, grain: g, entries: [] };
          historicalGroups.set(key, hg);
        }
        hg.entries.push(entry);
      }
      continue;
    }
    const known = entry.grains.filter((g) => g.match === "known");
    const unattributed = entry.grains.filter((g) => g.match !== "known");
    const reqs = known.filter((g) => g.kind === "requirement").map((g) => g.id);
    for (const id of new Set(reqs)) (index.byRequirement[id] ??= []).push(entry);
    if (unattributed.length > 0) index.unattributed.push({ entry, grains: unattributed });
    if (reqs.length === 0 && unattributed.length === 0) index.briefLevel.push(entry);
  }
  index.historical = [...historicalGroups.values()];
  return index;
}

/** "N linked exception lineages in this view" + honest qualifiers. Never "no exceptions". */
export function summarizeBriefExceptions(index: BriefExceptionIndex): string {
  if (index.briefIdAmbiguous) return "Linked exception cards unavailable: this brief's id is not unique in its session";
  const qualifiers: string[] = [];
  if (index.incompleteHistory > 0) qualifiers.push(`${index.incompleteHistory} with incomplete history`);
  if (index.ambiguous.length > 0) {
    qualifiers.push(`${index.ambiguous.length} ambiguous lineage group${index.ambiguous.length === 1 ? "" : "s"} not counted`);
  }
  if (index.unreadable.length > 0) {
    qualifiers.push(`${index.unreadable.length} unreadable link${index.unreadable.length === 1 ? "" : "s"} not counted`);
  }
  const head = index.total === 0
    ? "No linked exception cards in this view"
    : `${index.total} linked exception lineage${index.total === 1 ? "" : "s"} in this view`;
  return [head, ...qualifiers].join(" · ");
}
