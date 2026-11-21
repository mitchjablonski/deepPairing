import { createHash } from "node:crypto";
import { SKELETON_VISUAL_PREFIX, isLivePlanVersion, isSkeletonApprovedVisualId, type PlanVisual, type SkeletonExteriorDigest } from "@deeppairing/shared";
import { scanSkeletonText, type SkeletonFence } from "../skeleton-scope.js";

/**
 * #686 P1b (warn mode) — exterior drift for approved skeleton plans. The
 * EXTERIOR of a fenced file is the file with every SKEL[id] fence body
 * removed: the marker lines and everything outside the fences stay. Fills
 * belong inside the fences; any change to the exterior after approval is a
 * skeleton change the human has not reviewed.
 *
 * The approved exterior comes from the `skelcode:<path>` snapshot visuals
 * (never rewritten after the plan is presented). A file whose code the
 * snapshot does not hold (withheld, truncated, or past the snapshot cap) is
 * compared by its content-free exterior digest instead — changed or not, no
 * line numbers. The live side is the file as it reads now. No node:fs here;
 * the reader lives in skeleton-snapshot.ts. Warn only: nothing refuses.
 *
 * Comparison ignores line endings (CRLF / CR), a leading BOM, one trailing
 * newline and trailing whitespace on each line.
 */

/** The live side of one declared file. */
export type LiveSkeletonFile =
  | { text: string }
  | { missing: true }
  | { unchecked: string };

export interface ExteriorDriftChange {
  file: string;
  /** First few changed exterior lines, 1-based LIVE line numbers. */
  lines: number[];
  /** Changed lines beyond those listed (capped when `approximate`). */
  more: number;
  /** The file was too large for a real diff: positional, so approximate. */
  approximate?: boolean;
  /** Set when line numbers can't be given or need context. */
  note?: string;
}

export interface SkeletonExteriorDrift {
  changed: ExteriorDriftChange[];
  /** Present in the approved snapshot, missing on disk now. */
  deleted: string[];
  /** Unreadable, or approved before digests existed: never reported as drift. */
  notChecked: Array<{ file: string; reason: string }>;
  /** A deleted file's fences now found in another file of the same directory. */
  renamed?: Array<{ from: string; to: string }>;
}

/** One approved file to compare: its code (line diff) and/or its digest. */
interface ApprovedFile {
  file: string;
  code?: string;
  digest?: SkeletonExteriorDigest;
  /** Why the code isn't there (withheld / truncated / snapshot cap). */
  codeless?: string;
}

const MAX_LINES_LISTED = 5;
const MAX_APPROX_MORE = 20;
/** LCS table cap (cells); beyond it a cheaper positional diff is used. */
const MAX_LCS_CELLS = 4_000_000;

interface ExteriorLine {
  text: string;
  /** 1-based line number in the source file. */
  line: number;
}

/** Line endings, BOM and one trailing newline — what "same text" ignores. */
export const normalizeSkeletonText = (text: string): string =>
  text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
/** Per-line comparison key: trailing whitespace never counts. */
const key = (line: string): string => line.trimEnd();

/** Exterior of normalized text: keep marker lines of fences in `keep`, drop
 *  bodies of every fence, and drop marker lines of the other (stripped)
 *  fences, leaving a `null` gap where each stripped fence was. */
function exteriorWithGaps(lines: string[], fences: SkeletonFence[], keep: (f: SkeletonFence) => boolean): Array<ExteriorLine | null> {
  const out: Array<ExteriorLine | null> = [];
  let n = 1;
  for (const f of fences) {
    for (; n < f.openLine; n++) out.push({ text: key(lines[n - 1]!), line: n });
    if (keep(f)) {
      out.push({ text: key(lines[f.openLine - 1]!), line: f.openLine });
      out.push({ text: key(lines[f.closeLine - 1]!), line: f.closeLine });
    } else {
      out.push(null);
    }
    n = f.closeLine + 1;
  }
  for (; n <= lines.length; n++) out.push({ text: key(lines[n - 1]!), line: n });
  return out;
}

/** The exterior of one file's text (marker lines + every line outside a
 *  fence), with line numbers. Throws when the markers don't parse. */
export function skeletonExterior(text: string, file: string): ExteriorLine[] {
  const norm = normalizeSkeletonText(text);
  return exteriorWithGaps(norm.split("\n"), scanSkeletonText(norm, file), () => true) as ExteriorLine[];
}

/** Content-free record of a file's exterior (stored at present time). */
export function skeletonExteriorDigest(text: string, file: string): SkeletonExteriorDigest {
  const ext = skeletonExterior(text, file);
  return { sha256: createHash("sha256").update(ext.map((l) => l.text).join("\n")).digest("hex"), lines: ext.length };
}

/**
 * Chunk matching, for files whose markers were (partly) stripped: each
 * approved chunk between stripped fences must still appear, in order and
 * contiguous — the first at the top, the last at the bottom — with anything
 * (a fill) in the gaps. Returns the live line of the first misfit, or []. A
 * line added right next to a stripped fence reads as part of its fill.
 */
function chunkMisfit(chunks: ExteriorLine[][], live: ExteriorLine[]): number[] {
  const matchesAt = (chunk: ExteriorLine[], at: number): number => {
    let k = 0;
    while (k < chunk.length && at + k < live.length && live[at + k]!.text === chunk[k]!.text) k++;
    return k;
  };
  const lineAt = (i: number): number => live[Math.min(Math.max(i, 0), live.length - 1)]?.line ?? 1;
  const last = chunks.length - 1;
  const top = chunks[0]!;
  const topLen = matchesAt(top, 0);
  if (topLen < top.length) return [lineAt(topLen)];
  if (last === 0) return live.length > top.length ? [lineAt(top.length)] : [];
  const bottom = chunks[last]!;
  const bottomStart = live.length - bottom.length;
  let pos = top.length;
  if (bottomStart < pos) return [lineAt(live.length - 1)];
  for (let k = bottom.length - 1; k >= 0; k--) {
    if (live[bottomStart + k]!.text !== bottom[k]!.text) return [lineAt(bottomStart + k)];
  }
  for (let c = 1; c < last; c++) {
    const chunk = chunks[c]!;
    if (chunk.length === 0) continue;
    let found = -1;
    let best = { at: pos, len: -1 };
    for (let at = pos; at + chunk.length <= bottomStart; at++) {
      const len = matchesAt(chunk, at);
      if (len === chunk.length) {
        found = at;
        break;
      }
      if (len > best.len) best = { at, len };
    }
    if (found < 0) return [lineAt(best.len > 0 ? best.at + best.len : pos)];
    pos = found + chunk.length;
  }
  return [];
}

/** Live line numbers of exterior lines that differ (inserted or changed); a
 *  pure removal is reported at the live line where the removed lines were. */
function changedLines(a: ExteriorLine[], b: ExteriorLine[]): { lines: number[]; approximate: boolean } {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre]!.text === b[pre]!.text) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf]!.text === b[b.length - 1 - suf]!.text) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const exact = (lines: number[]) => ({ lines, approximate: false });
  if (am.length === 0 && bm.length === 0) return exact([]);
  const removalAt = (bi: number): number => b[bi]?.line ?? b[b.length - 1]?.line ?? 1;
  if (bm.length === 0) return exact([removalAt(pre)]);
  if (am.length === 0) return exact(bm.map((l) => l.line));
  const out = new Set<number>();
  if (am.length * bm.length > MAX_LCS_CELLS) {
    for (let i = 0; i < bm.length; i++) if (am[i]?.text !== bm[i]!.text) out.add(bm[i]!.line);
    if (out.size === 0) out.add(removalAt(pre + bm.length));
    return { lines: [...out].sort((x, y) => x - y), approximate: true };
  }
  const n = am.length;
  const m = bm.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = am[i]!.text === bm[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // Each run of unmatched lines is one change: its inserted (or replacing)
  // live lines, or — a pure removal — the live line where it happened.
  let i = 0;
  let j = 0;
  let runInserted = false;
  let runRemoved = false;
  const closeRun = () => {
    if (runRemoved && !runInserted) out.add(removalAt(pre + j));
    runInserted = runRemoved = false;
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i]!.text === bm[j]!.text) {
      closeRun();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      out.add(bm[j]!.line);
      runInserted = true;
      j++;
    } else {
      runRemoved = true;
      i++;
    }
  }
  closeRun();
  return exact([...out].sort((x, y) => x - y));
}

/** Compare one file's approved code with its live text. */
function compareCode(file: string, code: string, liveText: string): ExteriorDriftChange | null | "unparsable-approved" {
  const aNorm = normalizeSkeletonText(code);
  const aLines = aNorm.split("\n");
  let aFences: SkeletonFence[];
  try {
    aFences = scanSkeletonText(aNorm, file);
  } catch {
    return "unparsable-approved";
  }
  const bNorm = normalizeSkeletonText(liveText);
  let bFences: SkeletonFence[];
  try {
    bFences = scanSkeletonText(bNorm, file);
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(`${file}:`, "line ") : String(err);
    return { file, lines: [], more: 0, note: `SKEL markers no longer parse (${why})` };
  }
  const bLines = bNorm.split("\n");
  const liveIds = new Set(bFences.map((f) => f.id));
  const stripped = aFences.filter((f) => !liveIds.has(f.id));
  const liveExt = exteriorWithGaps(bLines, bFences, () => true) as ExteriorLine[];
  if (stripped.length === 0) {
    const approvedExt = exteriorWithGaps(aLines, aFences, () => true) as ExteriorLine[];
    const { lines, approximate } = changedLines(approvedExt, liveExt);
    if (lines.length === 0) return null;
    const more = Math.max(0, lines.length - MAX_LINES_LISTED);
    return { file, lines: lines.slice(0, MAX_LINES_LISTED), more: approximate ? Math.min(more, MAX_APPROX_MORE) : more, ...(approximate ? { approximate } : {}) };
  }
  // Some (or all) markers stripped: each stripped fence becomes a gap.
  const withGaps = exteriorWithGaps(aLines, aFences, (f) => liveIds.has(f.id));
  const chunks: ExteriorLine[][] = [[]];
  for (const l of withGaps) {
    if (l === null) chunks.push([]);
    else chunks[chunks.length - 1]!.push(l);
  }
  const misfit = chunkMisfit(chunks, liveExt);
  if (misfit.length === 0) return null;
  const which = stripped.length === aFences.length ? "markers stripped" : `markers of ${stripped.map((f) => `SKEL[${f.id}]`).join(", ")} stripped`;
  return { file, lines: misfit, more: 0, note: `${which}; the approved structure no longer matches near line ${misfit[0]}` };
}

/** The approved files a plan's visuals record, code and digest. */
export function approvedSkeletonFiles(approvedVisuals: readonly PlanVisual[] | undefined): ApprovedFile[] {
  const out: ApprovedFile[] = [];
  for (const v of approvedVisuals ?? []) {
    if (!v || v.kind !== "annotated_code" || !isSkeletonApprovedVisualId(v.id) || !v.skeleton) continue;
    const file = typeof v.filePath === "string" && v.filePath ? v.filePath : v.id.slice(SKELETON_VISUAL_PREFIX.length);
    const digest = v.skeleton.exterior;
    if (v.skeleton.withheld || typeof v.code !== "string") out.push({ file, ...(digest ? { digest } : {}), codeless: "withheld from the approved snapshot" });
    else if (v.skeleton.truncated) out.push({ file, ...(digest ? { digest } : {}), codeless: "the approved snapshot is truncated" });
    else out.push({ file, code: v.code, ...(digest ? { digest } : {}) });
    for (const o of v.skeleton.omitted ?? []) {
      if (!out.some((f) => f.file === o.path)) out.push({ file: o.path, digest: o.exterior, codeless: "past the snapshot cap" });
    }
  }
  return out;
}

/**
 * Compare each approved fenced file's exterior with its live exterior.
 * `approvedVisuals` is a plan's visuals (only `skelcode:` annotated_code
 * snapshots are used); `live` maps each approved file's path to what it reads
 * now. A file without approved code is compared by digest (no line numbers);
 * one with neither, or unreadable now, is `notChecked` — never drift.
 */
export function skeletonExteriorDrift(
  approvedVisuals: readonly PlanVisual[] | undefined,
  live: Readonly<Record<string, LiveSkeletonFile | undefined>>,
): SkeletonExteriorDrift {
  const result: SkeletonExteriorDrift = { changed: [], deleted: [], notChecked: [] };
  for (const a of approvedSkeletonFiles(approvedVisuals)) {
    const { file } = a;
    if (a.code === undefined && !a.digest) {
      result.notChecked.push({ file, reason: a.codeless ?? "no approved record" });
      continue;
    }
    const now = live[file];
    if (!now) {
      result.notChecked.push({ file, reason: "not read" });
      continue;
    }
    if ("missing" in now) {
      result.deleted.push(file);
      continue;
    }
    if ("unchecked" in now) {
      result.notChecked.push({ file, reason: now.unchecked });
      continue;
    }
    if (a.code !== undefined) {
      const c = compareCode(file, a.code, now.text);
      if (c === "unparsable-approved") result.notChecked.push({ file, reason: "the approved snapshot's markers don't parse" });
      else if (c) result.changed.push(c);
      continue;
    }
    // Digest only: changed or not, no lines (the content was never stored).
    let liveDigest: SkeletonExteriorDigest | null = null;
    try {
      liveDigest = skeletonExteriorDigest(now.text, file);
    } catch {
      result.changed.push({ file, lines: [], more: 0, note: "SKEL markers no longer parse" });
      continue;
    }
    if (liveDigest.sha256 !== a.digest!.sha256) {
      result.changed.push({ file, lines: [], more: 0, note: `changed — ${a.codeless}, so no line numbers` });
    }
  }
  return result;
}

/** One reply line ("" when nothing drifted). Not-checked files are named only
 *  alongside real drift, so an unreadable file doesn't nag on every call. */
export function formatExteriorDrift(drift: SkeletonExteriorDrift): string {
  if (drift.changed.length === 0 && drift.deleted.length === 0) return "";
  const renamedTo = new Map((drift.renamed ?? []).map((r) => [r.from, r.to]));
  const parts = [
    ...drift.changed.map((c) => {
      if (c.lines.length === 0) return `${c.file} (${c.note ?? "changed"})`;
      if (c.note) return `${c.file} (${c.note})`;
      const plural = c.lines.length + c.more === 1 ? "" : "s";
      const more = c.more > 0 ? ` (+${c.more}${c.approximate && c.more >= MAX_APPROX_MORE ? "+" : ""} more)` : "";
      return `${c.file} line${plural} ${c.lines.join(", ")}${more}${c.approximate ? " (approximate: file too large for an exact diff)" : ""}`;
    }),
    ...drift.deleted.map((f) => (renamedTo.has(f) ? `${f} (deleted; its fences are now in ${renamedTo.get(f)} — renamed?)` : `${f} (deleted)`)),
  ];
  const unchecked = drift.notChecked.length > 0 ? ` Not checked: ${drift.notChecked.map((n) => `${n.file} (${n.reason})`).join(", ")}.` : "";
  return (
    `\n⚠ Exterior drift since approval: ${parts.join("; ")}. ` +
    `Changes outside the SKEL fences are skeleton changes: propose them and revise_artifact the plan (reason "Skeleton change: …"), or restore the approved structure.${unchecked}`
  );
}

type PlanLike = { id: string; type: string; status: string; parentId?: string | null; statusHistory?: Array<{ status?: string }> };

/**
 * Is this plan version the approved baseline to check for drift? Either it is
 * the live, approved version, or (#611) it was approved, then superseded, and
 * every newer version in its lineage was rejected or retracted — its fences
 * are restored, so it is still the skeleton being filled.
 */
export function isSkeletonDriftBaseline(art: PlanLike, artifacts: ReadonlyArray<PlanLike>): boolean {
  if (art.type !== "plan") return false;
  if (art.status === "approved") return isLivePlanVersion(art, artifacts);
  if (art.status !== "superseded") return false;
  const history = (art.statusHistory ?? []).map((h) => h?.status);
  const beforeSupersede = history.slice(0, history.lastIndexOf("superseded")).filter((s) => s !== "superseded").at(-1);
  if (beforeSupersede !== "approved") return false;
  const descendants: PlanLike[] = [];
  const queue = [art.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const a of artifacts) {
      if (a.parentId === id && !descendants.includes(a)) {
        descendants.push(a);
        queue.push(a.id);
      }
    }
  }
  return descendants.length > 0 && descendants.every((d) => d.status === "rejected" || d.status === "retracted");
}
