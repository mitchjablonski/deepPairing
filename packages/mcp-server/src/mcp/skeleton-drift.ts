import { SKELETON_VISUAL_PREFIX, isSkeletonApprovedVisualId, type PlanVisual } from "@deeppairing/shared";
import { scanSkeletonText } from "../skeleton-scope.js";

/**
 * #686 P1b (warn mode) — exterior drift for approved skeleton plans. The
 * EXTERIOR of a fenced file is the file with every SKEL[id] fence body
 * removed: the marker lines and everything outside the fences stay. Fills
 * belong inside the fences; any change to the exterior after approval is a
 * skeleton change the human has not reviewed.
 *
 * The approved exterior comes from the `skelcode:<path>` snapshot visuals
 * (never rewritten after the plan is presented); the live side is the file
 * as it reads now. PURE — no node:fs; the reader lives in skeleton-snapshot.ts.
 * Warn only: nothing here refuses anything.
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
  /** Changed lines beyond those listed. */
  more: number;
  /** Set when line numbers can't be given (e.g. markers no longer parse). */
  note?: string;
}

export interface SkeletonExteriorDrift {
  changed: ExteriorDriftChange[];
  /** Present in the approved snapshot, missing on disk now. */
  deleted: string[];
  /** Withheld, truncated or unreadable: never reported as drift. */
  notChecked: Array<{ file: string; reason: string }>;
}

const MAX_LINES_LISTED = 5;
/** LCS table cap (cells); beyond it a cheaper positional diff is used. */
const MAX_LCS_CELLS = 4_000_000;

interface ExteriorLine {
  text: string;
  /** 1-based line number in the source file. */
  line: number;
}

const normalize = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\n$/, "");

/** The exterior of one file's text: marker lines and every line outside a
 *  fence, with line numbers. Throws when the markers don't parse. */
export function skeletonExterior(text: string, file: string): ExteriorLine[] {
  const norm = normalize(text);
  const lines = norm.split("\n");
  const fences = scanSkeletonText(norm, file);
  const inBody = new Uint8Array(lines.length + 2);
  for (const f of fences) for (let n = f.openLine + 1; n < f.closeLine; n++) inBody[n] = 1;
  const out: ExteriorLine[] = [];
  lines.forEach((t, i) => {
    if (!inBody[i + 1]) out.push({ text: t, line: i + 1 });
  });
  return out;
}

/** The approved exterior split at the fences, marker lines dropped: chunk 0
 *  precedes the first fence, the last follows the last fence. */
function exteriorChunks(text: string, file: string): ExteriorLine[][] {
  const lines = normalize(text).split("\n");
  const fences = scanSkeletonText(normalize(text), file);
  const chunks: ExteriorLine[][] = [];
  let start = 1;
  for (const f of fences) {
    chunks.push(lines.slice(start - 1, f.openLine - 1).map((t, i) => ({ text: t, line: start + i })));
    start = f.closeLine + 1;
  }
  chunks.push(lines.slice(start - 1).map((t, i) => ({ text: t, line: start + i })));
  return chunks;
}

/**
 * Finalize: the markers are stripped, so the fills can't be told from the
 * exterior by marker. Each approved exterior chunk must still appear, in
 * order and contiguous: the first at the top, the last at the bottom, with
 * anything (a fill) between them. Returns the live line of the first misfit,
 * or [] when every chunk is found. A line added right next to a former fence
 * reads as part of that fill — the known blind spot of this mode.
 */
function strippedChangedLines(chunks: ExteriorLine[][], live: string[]): number[] {
  const matchesAt = (chunk: ExteriorLine[], at: number): number => {
    let k = 0;
    while (k < chunk.length && at + k < live.length && live[at + k] === chunk[k]!.text) k++;
    return k;
  };
  const lineAt = (i: number): number => Math.min(Math.max(i, 0), Math.max(live.length - 1, 0)) + 1;
  const last = chunks.length - 1;
  // Top and bottom are anchored.
  const top = chunks[0]!;
  const topLen = matchesAt(top, 0);
  if (topLen < top.length) return [lineAt(topLen)];
  const bottom = chunks[last]!;
  const bottomStart = live.length - bottom.length;
  let pos = top.length;
  if (last > 0) {
    if (bottomStart < pos) return [lineAt(live.length - 1)];
    for (let k = bottom.length - 1; k >= 0; k--) {
      if (live[bottomStart + k] !== bottom[k]!.text) return [lineAt(bottomStart + k)];
    }
  }
  // Middle chunks: the first contiguous occurrence at or after the last one.
  const end = last > 0 ? bottomStart : live.length;
  for (let c = 1; c < last; c++) {
    const chunk = chunks[c]!;
    if (chunk.length === 0) continue;
    let found = -1;
    let best = { at: pos, len: -1 };
    for (let at = pos; at + chunk.length <= end; at++) {
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
function changedLines(a: ExteriorLine[], b: ExteriorLine[]): number[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre]!.text === b[pre]!.text) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf]!.text === b[b.length - 1 - suf]!.text) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return [];
  const removalAt = (bi: number): number => b[bi]?.line ?? b[b.length - 1]?.line ?? 1;
  if (bm.length === 0) return [removalAt(pre)];
  if (am.length === 0) return bm.map((l) => l.line);
  const out = new Set<number>();
  if (am.length * bm.length > MAX_LCS_CELLS) {
    for (let i = 0; i < bm.length; i++) if (am[i]?.text !== bm[i]!.text) out.add(bm[i]!.line);
    if (out.size === 0) out.add(removalAt(pre + bm.length));
    return [...out].sort((x, y) => x - y);
  }
  // LCS over the middle; live lines outside it changed, and an approved line
  // outside it marks a removal at the current live position.
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
  return [...out].sort((x, y) => x - y);
}

/**
 * Compare each approved fenced file's exterior with its live exterior.
 * `approvedVisuals` is a plan's visuals (only `skelcode:` annotated_code
 * snapshots are used); `live` maps each such file's path to what it reads now.
 * A withheld or truncated snapshot, or a live file that can't be read, is
 * `notChecked` — never drift. Line endings alone never count.
 */
export function skeletonExteriorDrift(
  approvedVisuals: readonly PlanVisual[] | undefined,
  live: Readonly<Record<string, LiveSkeletonFile | undefined>>,
): SkeletonExteriorDrift {
  const result: SkeletonExteriorDrift = { changed: [], deleted: [], notChecked: [] };
  for (const v of approvedVisuals ?? []) {
    if (!v || v.kind !== "annotated_code" || !isSkeletonApprovedVisualId(v.id) || !v.skeleton) continue;
    const file = typeof v.filePath === "string" && v.filePath ? v.filePath : v.id.slice(SKELETON_VISUAL_PREFIX.length);
    if (v.skeleton.withheld || typeof v.code !== "string") {
      result.notChecked.push({ file, reason: "withheld from the approved snapshot" });
      continue;
    }
    if (v.skeleton.truncated) {
      result.notChecked.push({ file, reason: "the approved snapshot is truncated" });
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
    let approvedExt: ExteriorLine[];
    try {
      approvedExt = skeletonExterior(v.code, file);
    } catch {
      result.notChecked.push({ file, reason: "the approved snapshot's markers don't parse" });
      continue;
    }
    let liveExt: ExteriorLine[];
    try {
      if (scanSkeletonText(normalize(now.text), file).length === 0) {
        // Every marker stripped (the finalize state): chunk matching.
        const lines = strippedChangedLines(exteriorChunks(v.code, file), normalize(now.text).split("\n"));
        if (lines.length > 0) result.changed.push({ file, lines, more: 0, note: `markers stripped; the approved structure no longer matches near line ${lines[0]}` });
        continue;
      }
      liveExt = skeletonExterior(now.text, file);
    } catch (err) {
      const why = err instanceof Error ? err.message.replace(`${file}:`, "line ") : String(err);
      result.changed.push({ file, lines: [], more: 0, note: `SKEL markers no longer parse (${why})` });
      continue;
    }
    const lines = changedLines(approvedExt, liveExt);
    if (lines.length > 0) {
      result.changed.push({ file, lines: lines.slice(0, MAX_LINES_LISTED), more: Math.max(0, lines.length - MAX_LINES_LISTED) });
    }
  }
  return result;
}

/** One reply line ("" when nothing drifted). Not-checked files are named only
 *  alongside real drift, so a withheld file doesn't nag on every call. */
export function formatExteriorDrift(drift: SkeletonExteriorDrift): string {
  if (drift.changed.length === 0 && drift.deleted.length === 0) return "";
  const parts = [
    ...drift.changed.map((c) =>
      c.note
        ? `${c.file} (${c.note})`
        : `${c.file} line${c.lines.length + c.more === 1 ? "" : "s"} ${c.lines.join(", ")}${c.more > 0 ? ` (+${c.more} more)` : ""}`,
    ),
    ...drift.deleted.map((f) => `${f} (deleted)`),
  ];
  const unchecked = drift.notChecked.length > 0 ? ` Not checked: ${drift.notChecked.map((n) => `${n.file} (${n.reason})`).join(", ")}.` : "";
  return (
    `\n⚠ Exterior drift since approval: ${parts.join("; ")}. ` +
    `Changes outside the SKEL fences are skeleton changes: propose them and revise_artifact the plan (reason "Skeleton change: …"), or restore the approved structure.${unchecked}`
  );
}
