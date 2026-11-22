import fs from "node:fs";
import path from "node:path";
import type { PlanVisual } from "@deeppairing/shared";
import { scanSkeletonText, type SkeletonFence } from "../skeleton-scope.js";
import { ruleForRelPath } from "../guardrail-rules.js";
import { resolveProjectRoot } from "../project-root.js";
import { SKELETON_VISUAL_PREFIX, approvedSkeletonFiles, isSkeletonApprovedVisualId, skeletonExteriorDrift, type LiveSkeletonFile, type SkeletonExteriorDrift } from "./skeleton-drift.js";

/**
 * #686 P2c — the confined skeleton-file reader and the exterior-drift check,
 * split out of skeleton-snapshot.ts so the bundled Stop hook can run them.
 * NODE BUILT-INS ONLY (plus type-only imports): everything this module
 * reaches is inlined by esbuild into claude-plugin/server/stop.mjs and the
 * init-lane `.deeppairing/hooks/stop.mjs`, which run with no node_modules.
 * hook-scripts-drift.test.ts fails on any non-`node:` import.
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

/** #686 P1b — rename hint: per-file and per-call read caps. */
const MAX_RENAME_FILE_BYTES = 256 * 1024;
const MAX_RENAME_TOTAL_BYTES = 2 * 1024 * 1024;

/** #686 P1b — directory entries looked at for a deleted file's rename. */
const MAX_RENAME_ENTRIES = 200;

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
const O_NONBLOCK = (fs.constants as Record<string, number | undefined>).O_NONBLOCK ?? 0;

/** Read one fenced file for the snapshot — confined, denylisted, size- and
 *  type-checked on the opened handle, text only. */
export function readConfined(root: string, rel: string, limits: SkeletonSnapshotLimits): ReadOutcome {
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
    // Opening a FIFO must not wait for a writer before fstat can reject it.
    fd = fs.openSync(realAbs, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
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

/**
 * #686 P1b (warn mode) — exterior drift for an approved skeleton plan: read
 * each file the APPROVED `skelcode:` snapshot holds (same confinement and
 * denylist as the snapshot itself; content never leaves this function, only
 * line numbers do) and compare its exterior with the approved one. "Not on
 * disk" is a deleted file; any other read failure is "not checked". Never
 * throws — a fault reports no drift.
 */
export function checkSkeletonExteriorDrift(
  content: unknown,
  opts: { root?: string; limits?: SkeletonSnapshotLimits } = {},
): SkeletonExteriorDrift {
  const empty: SkeletonExteriorDrift = { changed: [], deleted: [], notChecked: [] };
  try {
    const visuals = (Array.isArray((content as { visuals?: unknown } | null)?.visuals)
      ? ((content as { visuals: PlanVisual[] }).visuals)
      : []).filter((v) => v && typeof v === "object" && v.kind === "annotated_code" && isSkeletonApprovedVisualId(v.id) && v.skeleton);
    if (visuals.length === 0) return empty;
    const root = path.resolve(opts.root ?? (() => {
      const r = resolveProjectRoot();
      return r.worktree?.workspaceRoot ?? r.projectRoot;
    })());
    const limits = opts.limits ?? SKELETON_SNAPSHOT_LIMITS;
    const live: Record<string, LiveSkeletonFile> = {};
    const approved = approvedSkeletonFiles(visuals);
    for (const a of approved) {
      if (a.code === undefined && !a.digest) continue; // nothing to compare against: not read
      const rel = normalizeSkeletonPath(root, a.file);
      if (!rel) {
        live[a.file] = { unchecked: "outside the project" };
        continue;
      }
      const read = readConfined(root, rel, limits);
      live[a.file] = read.ok ? { text: read.text } : read.reason === "not on disk" ? { missing: true } : { unchecked: read.reason };
    }
    const drift = skeletonExteriorDrift(visuals, live);
    // Rename hint: a deleted file's FULL fence-id set (and its titles, where
    // the snapshot kept them) now in one file of the same directory that the
    // approved set doesn't name. Sizes are stat'ed first; reads are capped
    // per file and per call.
    if (drift.deleted.length > 0) {
      const known = new Set(approved.map((a) => a.file));
      const renamed: Array<{ from: string; to: string }> = [];
      let budget = MAX_RENAME_TOTAL_BYTES;
      for (const from of drift.deleted) {
        const fences0 = visuals.find((v) => (v.filePath ?? v.id.slice(SKELETON_VISUAL_PREFIX.length)) === from)?.skeleton?.fences ?? [];
        if (fences0.length === 0) continue;
        const want = new Map(fences0.map((f) => [f.id, f.title]));
        const dir = path.posix.dirname(from);
        let names: string[];
        try {
          names = fs.readdirSync(path.resolve(root, dir)).slice(0, MAX_RENAME_ENTRIES);
        } catch {
          continue;
        }
        for (const name of names) {
          if (budget <= 0) break;
          const rel = dir === "." ? name : `${dir}/${name}`;
          if (known.has(rel)) continue;
          let size: number;
          try {
            const st = fs.statSync(path.resolve(root, rel));
            if (!st.isFile()) continue;
            size = st.size;
          } catch {
            continue;
          }
          if (size > MAX_RENAME_FILE_BYTES || size > budget) continue;
          budget -= size;
          const read = readConfined(root, rel, limits);
          if (!read.ok || !read.text.includes("SKEL[")) continue;
          let fences: SkeletonFence[];
          try {
            fences = scanSkeletonText(read.text, rel);
          } catch {
            continue;
          }
          const ids = new Set(fences.map((f) => f.id));
          const sameIds = ids.size === want.size && [...want.keys()].every((id) => ids.has(id));
          const sameTitles = fences.every((f) => {
            const t = want.get(f.id);
            return t === undefined || t === f.title;
          });
          if (sameIds && sameTitles) {
            renamed.push({ from, to: rel });
            break;
          }
        }
      }
      if (renamed.length > 0) drift.renamed = renamed;
    }
    return drift;
  } catch {
    return empty;
  }
}
