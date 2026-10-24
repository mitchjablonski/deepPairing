import type { Artifact } from "@deeppairing/shared";

/**
 * #571 slice 2 — the GOVERNING BRIEF: the spec that governs a delegated run.
 *
 * A pure, read-only derivation over the artifacts already in the store. It adds
 * no type, no schema field and no attention signal: the strip that renders it
 * is navigation only. Content is read defensively (no Zod coercion) so this
 * stays out of the lazy renderer chunks and tolerates legacy specs.
 *
 * A spec qualifies only while it governs a DELEGATED run that is still going:
 *   - it carries the delegate-brief marker, a headed `Review: packet` or
 *     `Review: line-by-line` line in `context` (delegate.md move 2);
 *   - it is the LATEST version of its lineage (no successor has it as
 *     `parentId`, and it is not superseded);
 *   - it is not finished: when it has tasks, at least one is not yet
 *     `done`/`skipped` (no time-based rule);
 *   - and either it is `approved`, or it is `draft`/`reviewing` and either
 *     execution has started (a task has a non-`pending` status, #578) or an
 *     earlier version of its lineage was approved. That last case is a
 *     `revise_artifact` supersede: the strip re-points to the new version and
 *     shows it as awaiting re-approval (changed scope never silently inherits
 *     the old approval).
 * With several, the most recently approved wins.
 */
export interface GoverningBrief {
  id: string;
  title: string;
  version: number;
  status: Artifact["status"];
  /** True when this version itself is not approved yet (draft/reviewing). */
  awaitingApproval: boolean;
  objective: string | undefined;
  /** Present only when the spec has tasks. */
  tasks: { total: number; done: number; skipped: number; tracked: boolean; started: boolean } | undefined;
  /** Present only when the spec declares `edgePaths` with at least one entry. */
  edgePathCount: number | undefined;
  /** The `Review:` line's value from `context` (always present on a brief). */
  reviewMode: string;
}

const OPEN_STATUSES = new Set<string>(["draft", "reviewing"]);
/** The headed `Review:` line of a brief's `context` (delegate.md move 2): a
 *  WHOLE line, `Review: packet` or `Review: line-by-line` (case-insensitive),
 *  so prose that merely mentions review can't match. Anything else → undefined. */
export function parseReviewMode(context: unknown): "packet" | "line-by-line" | undefined {
  if (typeof context !== "string" || context.length === 0) return undefined;
  const match = /^Review:[ \t]*(packet|line-by-line)[ \t]*\r?$/im.exec(context);
  return match?.[1] ? (match[1].toLowerCase() as "packet" | "line-by-line") : undefined;
}

function lastApprovedAt(a: Artifact): string | undefined {
  let at: string | undefined;
  for (const h of a.statusHistory ?? []) {
    if (h?.status === "approved" && typeof h.at === "string" && (!at || h.at > at)) at = h.at;
  }
  return at;
}

/** Ancestors of `a`, nearest first (cycle-safe). */
function ancestors(all: Artifact[], a: Artifact): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>([a.id]);
  let parentId = a.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = all.find((x) => x.id === parentId);
    if (!parent) break;
    out.push(parent);
    parentId = parent.parentId;
  }
  return out;
}

function wasApproved(a: Artifact): boolean {
  return a.status === "approved" || lastApprovedAt(a) !== undefined;
}

function readTasks(content: Record<string, unknown>): GoverningBrief["tasks"] {
  const raw = content.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  let done = 0;
  let skipped = 0;
  let tracked = false;
  let started = false;
  for (const t of raw) {
    const status = t && typeof t === "object" ? (t as { status?: unknown }).status : undefined;
    if (typeof status === "string") tracked = true;
    if (typeof status === "string" && status !== "pending") started = true;
    if (status === "done") done++;
    else if (status === "skipped") skipped++;
  }
  return { total: raw.length, done, skipped, tracked, started };
}

/**
 * @param candidates the artifacts in view (session filter / replay applied)
 * @param all every artifact in the store, for lineage checks (defaults to candidates)
 */
export function selectGoverningBrief(candidates: Artifact[], all: Artifact[] = candidates): GoverningBrief | null {
  let best: { a: Artifact; key: string } | null = null;
  for (const a of candidates) {
    if (a.type !== "spec" || a.status === "superseded") continue;
    if (all.some((x) => x.parentId === a.id && x.id !== a.id)) continue; // not the latest version
    const content = (a.content ?? {}) as Record<string, unknown>;
    if (!parseReviewMode(content.context)) continue; // not a delegate brief
    const tasks = readTasks(content);
    if (tasks && tasks.done + tasks.skipped >= tasks.total) continue; // finished
    const lineage = ancestors(all, a);
    let qualifies = a.status === "approved";
    if (!qualifies && OPEN_STATUSES.has(a.status)) {
      qualifies = Boolean(tasks?.started) || lineage.some(wasApproved);
    }
    if (!qualifies) continue;
    // Most recently approved: this version's approval, else the lineage's,
    // else the last update. ISO strings compare chronologically.
    const key = lastApprovedAt(a)
      ?? lineage.map(lastApprovedAt).find((x) => x !== undefined)
      ?? a.updatedAt ?? a.createdAt ?? "";
    const tie = a.updatedAt ?? a.createdAt ?? "";
    if (!best || key > best.key || (key === best.key && tie > (best.a.updatedAt ?? best.a.createdAt ?? ""))) {
      best = { a, key };
    }
  }
  if (!best) return null;
  const a = best.a;
  const content = (a.content ?? {}) as Record<string, unknown>;
  const edgePaths = content.edgePaths;
  const objective = typeof content.objective === "string" && content.objective.trim() ? content.objective.trim() : undefined;
  return {
    id: a.id,
    title: a.title,
    version: typeof a.version === "number" ? a.version : 1,
    status: a.status,
    awaitingApproval: a.status !== "approved",
    objective,
    tasks: readTasks(content),
    edgePathCount: Array.isArray(edgePaths) && edgePaths.length > 0 ? edgePaths.length : undefined,
    reviewMode: parseReviewMode(content.context) ?? "packet", // always parses: the loop required it
  };
}
