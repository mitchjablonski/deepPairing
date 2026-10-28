import fs from "node:fs";
import path from "node:path";
import type { PlanVisual, SkeletonCodeSnapshot, SkeletonFenceView } from "@deeppairing/shared";
import { isSkeletonVisualId, skeletonVisualId } from "./skeleton-line.js";
import { scanSkeletonFences, scanSkeletonText, type SkeletonFence } from "../skeleton-scope.js";
import { ruleForRelPath } from "../guardrail-rules.js";
import { resolveProjectRoot } from "../project-root.js";

export { SKELETON_VISUAL_PREFIX, isSkeletonVisualId, skeletonVisualId, describeSkeletonLine } from "./skeleton-line.js";

/**
 * Skeleton plans, parity PR 2 — the skeleton AS CODE in the plan card.
 *
 * A skeleton plan's real review object is the code on disk: the fenced stubs,
 * signatures and wiring the agent wrote before presenting. At present_plan
 * (and at a revise_artifact supersede of a skeleton plan) the server reads
 *   - every file holding a SKEL[id] fence some step claims (`skelId`), and
 *   - every file_map "create" entry that has no fence (the standalone
 *     `skel track`: new types, wiring files),
 * and attaches each one as an ordinary `annotated_code` visual. Nothing new on
 * the wire: the renderer is CommentableCode, so per-line comments anchor to
 * (visualId, filePath, line) and reach the agent through check_feedback like
 * any other visual's line comment. The visual id is derived from the PATH
 * (`skelcode:<path>`), so a comment thread on a file survives a revise.
 *
 * Bounded and safe:
 *   - paths are confined to the working tree: no absolute paths outside it, no
 *     `..`, and the REAL path (symlinks resolved) must stay inside the real
 *     root — the same realpath-prefix rule the file-viewer route applies;
 *   - git and deepPairing state, secrets-class paths and binary files are
 *     never read into an artifact;
 *   - file count, per-file and total bytes are capped; a cut is marked on the
 *     visual (caption + `skeleton.truncated`) and in the tool reply;
 *   - the text lands in artifact content, so the store's authoritative
 *     secret scan (scanContentForSecrets at createArtifact) covers it like
 *     any other present_* string.
 *
 * The fence parser is #606's (scanSkeletonFences / scanSkeletonText) — this
 * module never parses markers itself. Never throws: a fault leaves the plan
 * exactly as the agent presented it.
 */

export interface SkeletonSnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Files larger than this are not read at all (the scanner's own ceiling). */
  maxReadBytes: number;
}

export const SKELETON_SNAPSHOT_LIMITS: SkeletonSnapshotLimits = {
  maxFiles: 12,
  maxFileBytes: 48 * 1024,
  maxTotalBytes: 192 * 1024,
  maxReadBytes: 1_000_000,
};

/** Below this much remaining budget a file is omitted rather than shown as a stub. */
const MIN_USEFUL_BYTES = 512;


type ScanResult = { fences: SkeletonFence[]; errors: string[] };

export interface SkeletonSnapshotResult {
  /** The snapshot visuals (empty for a non-skeleton plan). */
  visuals: PlanVisual[];
  /** One line for the tool reply ("" when nothing was attached or skipped). */
  note: string;
  /** The fence scan, so present_plan's fence check reuses one walk. */
  scan?: ScanResult;
}

type ReadOutcome = { ok: true; text: string } | { ok: false; reason: string };

function within(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Normalize an agent-written path to a repo-relative POSIX path, or null when
 *  it can't name a file inside `root` lexically. */
export function normalizeSkeletonPath(root: string, raw: string): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return null;
  const spelled = raw.trim().replace(/\\/g, "/");
  const abs = path.resolve(root, spelled);
  if (!within(root, abs) || abs === path.resolve(root)) return null;
  return path.relative(root, abs).split(path.sep).join("/");
}

const SECRET_FILE = /\.(pem|key|p12|pfx|jks|keystore)$/i;

/** Read one file for the snapshot — confined, size-checked, text-only. */
function readConfined(root: string, rel: string, limits: SkeletonSnapshotLimits): ReadOutcome {
  const segs = rel.split("/");
  if (segs.includes(".git") || segs.includes(".deeppairing")) return { ok: false, reason: "git/deepPairing state is never snapshotted" };
  if (ruleForRelPath(rel)?.category === "secrets" || SECRET_FILE.test(rel)) return { ok: false, reason: "a secrets path — withheld" };
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { ok: false, reason: "the project root is unreadable" };
  }
  try {
    realAbs = fs.realpathSync(path.resolve(root, rel));
  } catch {
    return { ok: false, reason: "not on disk" };
  }
  if (!within(realRoot, realAbs)) return { ok: false, reason: "it resolves outside the project (symlink)" };
  let size: number;
  try {
    const st = fs.statSync(realAbs);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    size = st.size;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (size > limits.maxReadBytes) return { ok: false, reason: `too large to snapshot (${size} bytes)` };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(realAbs);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, reason: "binary — not shown" };
  return { ok: true, text: buf.toString("utf-8") };
}

/** Cut `text` at a line boundary so it fits `budget` bytes. */
function truncateToBytes(text: string, budget: number): { code: string; shownLines: number; totalLines: number } | null {
  const lines = text.split("\n");
  const totalLines = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (Buffer.byteLength(text, "utf-8") <= budget) return null;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf-8") + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return { code: kept.join("\n"), shownLines: kept.length, totalLines };
}

function fenceViews(fences: SkeletonFence[], shownLines: number | null): SkeletonFenceView[] {
  return fences
    .filter((f) => shownLines == null || f.openLine <= shownLines)
    .map((f) => ({
      id: f.id,
      ...(f.title ? { title: f.title } : {}),
      openLine: f.openLine,
      closeLine: shownLines == null ? f.closeLine : Math.min(f.closeLine, shownLines),
      status: f.status,
    }));
}

/** Drop every snapshot visual (and any `skeleton` field an agent echoed onto
 *  its own visual) — the server is the only author of either. */
export function stripSkeletonVisuals(visuals: unknown): unknown[] | undefined {
  if (!Array.isArray(visuals)) return undefined;
  return visuals
    .filter((v) => !(v && typeof v === "object" && isSkeletonVisualId((v as { id?: unknown }).id)))
    .map((v) => {
      if (!v || typeof v !== "object" || !("skeleton" in (v as object))) return v;
      const { skeleton: _forged, ...rest } = v as Record<string, unknown>;
      return rest;
    });
}

/**
 * Build the snapshot visuals for a plan's steps + visuals. Pure over the
 * filesystem under `root` (the working tree — a linked worktree's own dir).
 */
export function buildSkeletonSnapshot(args: {
  steps: unknown;
  visuals?: unknown;
  root: string;
  limits?: SkeletonSnapshotLimits;
}): SkeletonSnapshotResult {
  const limits = args.limits ?? SKELETON_SNAPSHOT_LIMITS;
  const steps = Array.isArray(args.steps) ? (args.steps as Array<{ skelId?: unknown }>) : [];
  const skelIds = [...new Set(steps.map((s) => s?.skelId).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (skelIds.length === 0) return { visuals: [], note: "" };
  const root = path.resolve(args.root);

  const scan = scanSkeletonFences(root);
  // Fenced files, in the order the plan's steps claim them.
  const fenced: string[] = [];
  for (const id of skelIds) {
    for (const f of scan.fences) if (f.id === id && !fenced.includes(f.file)) fenced.push(f.file);
  }
  // Tracked: file_map "create" entries with no fence (standalone `skel track`).
  const tracked: string[] = [];
  const skipped: string[] = [];
  for (const v of Array.isArray(args.visuals) ? args.visuals : []) {
    const vis = v as { kind?: unknown; files?: unknown };
    if (vis?.kind !== "file_map" || !Array.isArray(vis.files)) continue;
    for (const entry of vis.files as Array<{ path?: unknown; change?: unknown }>) {
      if (entry?.change !== "create" || typeof entry.path !== "string") continue;
      const rel = normalizeSkeletonPath(root, entry.path);
      if (!rel) {
        skipped.push(`${entry.path} (outside the project)`);
        continue;
      }
      if (!fenced.includes(rel) && !tracked.includes(rel)) tracked.push(rel);
    }
  }

  const visuals: PlanVisual[] = [];
  const omitted: string[] = [];
  let used = 0;
  const candidates: Array<{ rel: string; tracked: boolean }> = [
    ...fenced.map((rel) => ({ rel, tracked: false })),
    ...tracked.map((rel) => ({ rel, tracked: true })),
  ];
  for (const { rel, tracked: isTracked } of candidates) {
    if (visuals.length >= limits.maxFiles) {
      omitted.push(rel);
      continue;
    }
    const read = readConfined(root, rel, limits);
    if (!read.ok) {
      // A tracked file the agent hasn't written yet is normal; say so quietly.
      skipped.push(`${rel} (${read.reason})`);
      continue;
    }
    const remaining = limits.maxTotalBytes - used;
    const budget = Math.min(limits.maxFileBytes, remaining);
    // Out of TOTAL budget: omit rather than show a sliver. (A small per-file
    // cap still truncates — that's a deliberate setting, not leftovers.)
    if (remaining < MIN_USEFUL_BYTES && Buffer.byteLength(read.text, "utf-8") > remaining) {
      omitted.push(rel);
      continue;
    }
    const cut = truncateToBytes(read.text, budget);
    const code = cut ? cut.code : read.text.replace(/\n$/, "");
    used += Buffer.byteLength(code, "utf-8");

    let fences: SkeletonFence[] = [];
    let markerError: string | undefined;
    try {
      fences = scanSkeletonText(read.text, rel);
    } catch (err) {
      markerError = err instanceof Error ? err.message : String(err);
    }
    const skeleton: SkeletonCodeSnapshot = {
      fences: fenceViews(fences, cut ? cut.shownLines : null),
      ...(isTracked && fences.length === 0 ? { tracked: true } : {}),
      ...(cut ? { truncated: { shownLines: cut.shownLines, totalLines: cut.totalLines } } : {}),
      ...(markerError ? { markerError } : {}),
    };
    const n = skeleton.fences.length;
    const captionParts = [
      skeleton.tracked ? "Skeleton file with no fences (a file-map \"create\" entry)." : `${n} fence${n === 1 ? "" : "s"}.`,
      "Read from disk when the plan was presented. Comment on any line.",
      ...(cut ? [`Truncated: lines 1–${cut.shownLines} of ${cut.totalLines} shown (snapshot size cap).`] : []),
      ...(markerError ? [`Malformed SKEL markers: ${markerError}`] : []),
    ];
    visuals.push({
      id: skeletonVisualId(rel),
      kind: "annotated_code",
      title: rel,
      filePath: rel,
      lineStart: 1,
      code,
      caption: captionParts.join(" "),
      skeleton,
    });
  }
  if (omitted.length > 0 && visuals.length > 0) {
    const last = visuals[visuals.length - 1]!;
    last.caption = `${last.caption ?? ""} Not shown (snapshot cap): ${omitted.join(", ")}.`.trim();
  }

  const noteParts: string[] = [];
  if (visuals.length > 0) noteParts.push(`attached ${visuals.length} file${visuals.length === 1 ? "" : "s"} to the plan card as reviewable code`);
  if (omitted.length > 0) noteParts.push(`not shown (cap of ${limits.maxFiles} files / ${Math.round(limits.maxTotalBytes / 1024)} KiB): ${omitted.join(", ")}`);
  if (skipped.length > 0) noteParts.push(`skipped: ${skipped.join("; ")}`);
  if (visuals.some((v) => v.skeleton?.truncated)) noteParts.push("some files are truncated (marked on the card)");
  return { visuals, note: noteParts.length > 0 ? `\nSkeleton code view: ${noteParts.join("; ")}.` : "", scan };
}

/**
 * Replace a plan content's snapshot visuals with a fresh snapshot. Agent
 * visuals are kept, in order, ahead of the snapshot. A plan with no `skelId`
 * steps and no snapshot visuals comes back as the SAME object (byte-unchanged).
 */
export function attachSkeletonSnapshot<T extends Record<string, unknown>>(
  content: T,
  opts: { root?: string; limits?: SkeletonSnapshotLimits } = {},
): { content: T; note: string; scan?: ScanResult } {
  try {
    const steps = content.steps;
    const hasSkel = Array.isArray(steps) && steps.some((s) => typeof (s as { skelId?: unknown })?.skelId === "string" && (s as { skelId: string }).skelId.length > 0);
    const visuals = Array.isArray(content.visuals) ? (content.visuals as unknown[]) : undefined;
    const hasReserved = !!visuals?.some((v) => v && typeof v === "object" && (isSkeletonVisualId((v as { id?: unknown }).id) || "skeleton" in (v as object)));
    if (!hasSkel && !hasReserved) return { content, note: "" };
    const root = opts.root ?? (() => {
      const r = resolveProjectRoot();
      return r.worktree?.workspaceRoot ?? r.projectRoot;
    })();
    const kept = stripSkeletonVisuals(visuals) ?? [];
    const snap: SkeletonSnapshotResult = hasSkel
      ? buildSkeletonSnapshot({ steps, visuals: kept, root, ...(opts.limits ? { limits: opts.limits } : {}) })
      : { visuals: [], note: "" };
    const nextVisuals = [...kept, ...snap.visuals];
    const next: Record<string, unknown> = { ...content };
    if (nextVisuals.length > 0) next.visuals = nextVisuals;
    else delete next.visuals;
    return { content: next as T, note: snap.note, ...(snap.scan ? { scan: snap.scan } : {}) };
  } catch {
    return { content, note: "" };
  }
}
