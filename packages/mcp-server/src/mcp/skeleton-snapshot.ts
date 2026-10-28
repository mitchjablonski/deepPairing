import fs from "node:fs";
import path from "node:path";
import { isSkeletonApprovedVisualId, liveVisualIdFor, type PlanVisual, type SkeletonCodeSnapshot, type SkeletonFenceView } from "@deeppairing/shared";
import { isSkeletonVisualId, skeletonVisualId, stripSkeletonVisuals } from "./skeleton-line.js";
import { planDeclaredFiles, scanSkeletonFences, scanSkeletonText, type SkeletonFence } from "../skeleton-scope.js";
import { ruleForRelPath } from "../guardrail-rules.js";
import { resolveProjectRoot } from "../project-root.js";
import { scanForSecrets } from "../secret-scan.js";

export {
  SKELETON_VISUAL_PREFIX,
  isSkeletonVisualId,
  skeletonVisualId,
  describeSkeletonLine,
  stripSkeletonVisuals,
  stripForgedSkeleton,
} from "./skeleton-line.js";

/**
 * Skeleton plans, parity PR 2 — the skeleton AS CODE in the plan card.
 *
 * At present_plan (and at an ordinary revise_artifact supersede of a plan) the
 * server reads the files holding a SKEL[id] fence some step claims (`skelId`)
 * and attaches each as an ordinary `annotated_code` visual keyed by path
 * (`skelcode:<path>`). The renderer is CommentableCode, so per-line comments
 * anchor to (visualId, filePath, line) and reach the agent through
 * check_feedback.
 *
 * #607 review — content is ALLOWLISTED, not denylisted:
 *   - H1: only a file whose own text holds a claimed fence is ever read into
 *     an artifact. Unfenced file_map "create" entries are listed by PATH ONLY
 *     (one `skelcode:unfenced` file_map) — never read. A file must resolve
 *     (realpath) inside the real root, be a regular file opened without
 *     following a final symlink, and pass a case-insensitive denylist on
 *     every segment of BOTH its spelled and its real path (.env*, .git, .ssh,
 *     .deeppairing, *.pem, *.key, *.p12, id_rsa*, id_ed25519*, .npmrc,
 *     .netrc, .pypirc, credentials*) — defence in depth behind the allowlist.
 *   - M1: a file whose text matches the secret scanner is WITHHELD: the
 *     visual carries no code at all (`skeleton.withheld`), so nothing secret
 *     is stored, broadcast or exported.
 *   - L1: size and type are checked on the opened handle, and the handle's
 *     dev/ino must match the realpath's, which narrows the swap window.
 *   - L3: no file is opened once the total byte budget is spent.
 *
 * The fence parser is #606's (scanSkeletonFences / scanSkeletonText). Never
 * throws: a fault leaves the plan exactly as the agent presented it.
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

/** The path-only list of unfenced skeleton files. */
export const UNFENCED_VISUAL_ID = skeletonVisualId("unfenced");

/** Below this much remaining budget a file is omitted rather than shown as a stub. */
const MIN_USEFUL_BYTES = 512;

type ScanResult = ReturnType<typeof scanSkeletonFences>;

export interface SkeletonSnapshotResult {
  /** The snapshot visuals (empty for a non-skeleton plan). */
  visuals: PlanVisual[];
  /** One line for the tool reply ("" when nothing was attached or skipped). */
  note: string;
  /** The fence scan, so present_plan's fence check reuses it. */
  scan?: ScanResult;
  /** resnapshotSkeleton only: this read's monotonic stamp. */
  readAt?: number;
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

/** One path segment, lower-cased, that must never be snapshotted. */
export function isDeniedSegment(segment: string): boolean {
  const s = segment.toLowerCase();
  return (
    s.startsWith(".env") ||
    s === ".git" ||
    s === ".ssh" ||
    s === ".deeppairing" ||
    s === ".npmrc" ||
    s === ".netrc" ||
    s === ".pypirc" ||
    s.startsWith("id_rsa") ||
    s.startsWith("id_ed25519") ||
    s.startsWith("credentials") ||
    s.endsWith(".pem") ||
    s.endsWith(".key") ||
    s.endsWith(".p12")
  );
}

/** Case-insensitive denylist over every segment, plus the guardrail secrets
 *  class on the lower-cased path. */
export function isDeniedPath(rel: string): boolean {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some(isDeniedSegment)) return true;
  return ruleForRelPath(rel.toLowerCase())?.category === "secrets";
}

const O_NOFOLLOW = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;

/** Read one fenced file for the snapshot — confined, denylisted, size- and
 *  type-checked on the opened handle, text only. */
function readConfined(root: string, rel: string, limits: SkeletonSnapshotLimits): ReadOutcome {
  if (isDeniedPath(rel)) return { ok: false, reason: "a protected path — never snapshotted" };
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
  // The REAL path is checked too: an in-root symlink to `.env` is still `.env`.
  if (isDeniedPath(path.relative(realRoot, realAbs))) return { ok: false, reason: "a protected path — never snapshotted" };

  let fd: number;
  try {
    fd = fs.openSync(realAbs, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    // The handle must be the file the realpath named (narrows a swap between
    // the realpath and the open to "nothing changed").
    try {
      const named = fs.statSync(realAbs);
      if (named.dev !== st.dev || named.ino !== st.ino) return { ok: false, reason: "it changed while being read" };
    } catch {
      return { ok: false, reason: "it changed while being read" };
    }
    if (st.size > limits.maxReadBytes) return { ok: false, reason: `too large to snapshot (${st.size} bytes)` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const data = buf.subarray(0, off);
    if (data.subarray(0, 8192).includes(0)) return { ok: false, reason: "binary — not shown" };
    return { ok: true, text: data.toString("utf-8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
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
  const agentVisuals = Array.isArray(args.visuals) ? args.visuals : [];

  // The SAME scan #606's fence check runs: the plan's declared files (step
  // `files` + file_map paths), or its bounded fallback walk when none are declared.
  const scan = scanSkeletonFences(root, {
    files: planDeclaredFiles({
      steps: steps as Array<{ files?: unknown }>,
      visuals: agentVisuals as Array<{ kind?: unknown; files?: unknown }>,
    }),
  });
  // Fenced files, in the order the plan's steps claim them.
  const fenced: string[] = [];
  for (const id of skelIds) {
    for (const f of scan.fences) if (f.id === id && !fenced.includes(f.file)) fenced.push(f.file);
  }
  // Unfenced file_map "create" entries (the standalone `skel track`): PATHS
  // ONLY. They are never opened — no fence, no content (#607 review H1).
  const unfenced: string[] = [];
  const skipped: string[] = [];
  for (const v of agentVisuals) {
    const vis = v as { kind?: unknown; files?: unknown };
    if (vis?.kind !== "file_map" || !Array.isArray(vis.files)) continue;
    for (const entry of vis.files as Array<{ path?: unknown; change?: unknown }>) {
      if (entry?.change !== "create" || typeof entry.path !== "string") continue;
      const rel = normalizeSkeletonPath(root, entry.path);
      if (!rel) {
        skipped.push(`${entry.path} (outside the project)`);
        continue;
      }
      if (!fenced.includes(rel) && !unfenced.includes(rel)) unfenced.push(rel);
    }
  }

  const visuals: PlanVisual[] = [];
  const omitted: string[] = [];
  const withheld: string[] = [];
  let used = 0;
  for (const rel of fenced) {
    const remaining = limits.maxTotalBytes - used;
    // L3 — once the count or byte budget is spent, nothing else is opened.
    if (visuals.length >= limits.maxFiles || remaining < Math.min(MIN_USEFUL_BYTES, limits.maxTotalBytes)) {
      omitted.push(rel);
      continue;
    }
    const read = readConfined(root, rel, limits);
    if (!read.ok) {
      skipped.push(`${rel} (${read.reason})`);
      continue;
    }
    // Allowlist: the text actually read must hold a fence a step claims.
    let fences: SkeletonFence[];
    try {
      fences = scanSkeletonText(read.text, rel);
    } catch (err) {
      skipped.push(`${rel} (malformed SKEL markers: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!fences.some((f) => skelIds.includes(f.id))) {
      skipped.push(`${rel} (no claimed fence)`);
      continue;
    }
    // M1 — a secret-shaped value anywhere in the file: withhold ALL of it.
    // Labels and line only; the value never leaves this function.
    const secrets = scanForSecrets(read.text);
    if (secrets.length > 0) {
      const what = secrets.map((m) => `${m.label}${m.line ? `, line ${m.line}` : ""}`).join("; ");
      withheld.push(rel);
      visuals.push({
        id: skeletonVisualId(rel),
        kind: "annotated_code",
        title: rel,
        filePath: rel,
        caption: `Content withheld: possible secret detected (${what}).`,
        // Fence status only (no titles: a marker line could hold the value),
        // so the diagram and checklist still read progress from the code.
        skeleton: {
          fences: fences.map((f) => ({ id: f.id, openLine: f.openLine, closeLine: f.closeLine, status: f.status })),
          withheld: `possible secret detected (${what})`,
          takenAt: new Date().toISOString(),
        },
      });
      continue;
    }

    const cut = truncateToBytes(read.text, Math.min(limits.maxFileBytes, remaining));
    const code = cut ? cut.code : read.text.replace(/\n$/, "");
    used += Buffer.byteLength(code, "utf-8");
    const skeleton: SkeletonCodeSnapshot = {
      fences: fenceViews(fences, cut ? cut.shownLines : null),
      ...(cut ? { truncated: { shownLines: cut.shownLines, totalLines: cut.totalLines } } : {}),
      takenAt: new Date().toISOString(),
    };
    const n = skeleton.fences.length;
    const captionParts = [
      `${n} fence${n === 1 ? "" : "s"}.`,
      "Read from disk when the plan was presented. Comment on any line.",
      ...(cut ? [`Truncated: lines 1–${cut.shownLines} of ${cut.totalLines} shown (snapshot size cap).`] : []),
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
  if (unfenced.length > 0) {
    visuals.push({
      id: UNFENCED_VISUAL_ID,
      kind: "file_map",
      title: "Unfenced skeleton files (paths only)",
      caption: "New files from the file map with no SKEL fence. Their content is not shown here.",
      files: unfenced.map((p) => ({ path: p, change: "create" as const, note: "no fence, content not shown" })),
    });
  }

  const shown = visuals.filter((v) => v.kind === "annotated_code" && !v.skeleton?.withheld).length;
  const noteParts: string[] = [];
  if (shown > 0) noteParts.push(`attached ${shown} fenced file${shown === 1 ? "" : "s"} to the plan card as reviewable code`);
  if (unfenced.length > 0) noteParts.push(`listed ${unfenced.length} unfenced file${unfenced.length === 1 ? "" : "s"} by path only`);
  if (withheld.length > 0) noteParts.push(`content withheld (possible secret detected): ${withheld.join(", ")}`);
  if (omitted.length > 0) noteParts.push(`not shown (cap of ${limits.maxFiles} files / ${Math.round(limits.maxTotalBytes / 1024)} KiB): ${omitted.join(", ")}`);
  if (skipped.length > 0) noteParts.push(`skipped: ${skipped.join("; ")}`);
  if (visuals.some((v) => v.skeleton?.truncated)) noteParts.push("some files are truncated (marked on the card)");
  return { visuals, note: noteParts.length > 0 ? `\nSkeleton code view: ${noteParts.join("; ")}.` : "", scan };
}

/**
 * Replace a plan content's snapshot visuals with a fresh snapshot. Agent
 * visuals are kept, in order, ahead of the snapshot, with any forged
 * `skeleton` field stripped. A plan with no `skelId` steps and nothing to
 * strip comes back as the SAME object (byte-unchanged).
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
    const kept = stripSkeletonVisuals(visuals) ?? [];
    let snap: SkeletonSnapshotResult = { visuals: [], note: "" };
    if (hasSkel) {
      const root = opts.root ?? (() => {
        const r = resolveProjectRoot();
        return r.worktree?.workspaceRoot ?? r.projectRoot;
      })();
      snap = buildSkeletonSnapshot({ steps, visuals: kept, root, ...(opts.limits ? { limits: opts.limits } : {}) });
    }
    const nextVisuals = [...kept, ...snap.visuals];
    const next: Record<string, unknown> = { ...content };
    if (nextVisuals.length > 0) next.visuals = nextVisuals;
    else delete next.visuals;
    return { content: next as T, note: snap.note, ...(snap.scan ? { scan: snap.scan } : {}) };
  } catch {
    return { content, note: "" };
  }
}

/**
 * Parity PR 3 — progress read from the code. update_plan_progress re-reads a
 * LIVE skeleton plan's fenced files (same bounds and allowlist as
 * present_plan) into `skelcode-live:<path>` visuals. The approved
 * `skelcode:<path>` snapshot — what the human reviewed — is never touched
 * (#609 review). A file whose text is unchanged since the last live read (or
 * since approval) keeps its `takenAt`, so line comments on it are not flagged
 * as possibly moved. `readAt` is a per-process monotonic stamp the store uses
 * to keep the newest read. Null for a non-skeleton plan. Never throws.
 */
export function resnapshotSkeleton(
  content: unknown,
  opts: { root?: string; limits?: SkeletonSnapshotLimits } = {},
): SkeletonSnapshotResult | null {
  try {
    const c = (content ?? {}) as { steps?: unknown; visuals?: unknown };
    const steps = Array.isArray(c.steps) ? (c.steps as Array<{ skelId?: unknown }>) : [];
    if (!steps.some((st) => typeof st?.skelId === "string" && st.skelId.length > 0)) return null;
    const root = opts.root ?? (() => {
      const r = resolveProjectRoot();
      return r.worktree?.workspaceRoot ?? r.projectRoot;
    })();
    const all = (Array.isArray(c.visuals) ? (c.visuals as PlanVisual[]) : []).filter((v) => v && typeof v === "object");
    const readAt = nextReadStamp();
    const snap = buildSkeletonSnapshot({ steps, visuals: stripSkeletonVisuals(c.visuals) ?? [], root, ...(opts.limits ? { limits: opts.limits } : {}) });
    // Only the per-file CODE snapshots go live; the path-only unfenced list is
    // the file map's, and doesn't change with disk.
    const live: PlanVisual[] = [];
    for (const v of snap.visuals) {
      if (v.kind !== "annotated_code" || !v.skeleton || !isSkeletonApprovedVisualId(v.id)) continue;
      const liveId = liveVisualIdFor(v.id);
      const prior = all.find((p) => p.id === liveId) ?? all.find((p) => p.id === v.id);
      const takenAt =
        prior?.skeleton?.takenAt && prior.code === v.code && (prior.skeleton.withheld ?? "") === (v.skeleton.withheld ?? "")
          ? prior.skeleton.takenAt
          : v.skeleton.takenAt;
      live.push({
        ...v,
        id: liveId,
        caption: (v.caption ?? "").replace("Read from disk when the plan was presented.", "Live: re-read from disk on the latest progress update."),
        skeleton: { ...v.skeleton, ...(takenAt ? { takenAt } : {}), readAt },
      });
    }
    return { visuals: live, note: snap.note, readAt, ...(snap.scan ? { scan: snap.scan } : {}) };
  } catch {
    return null;
  }
}

let lastStamp = 0;
/** Strictly increasing within this process (two reads in one millisecond still order). */
function nextReadStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 0.001;
  return lastStamp;
}
