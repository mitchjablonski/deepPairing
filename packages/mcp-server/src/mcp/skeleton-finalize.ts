import fs from "node:fs";
import path from "node:path";
import { isLivePlanVersion, type Artifact } from "@deeppairing/shared";
import { planDeclaredFiles, scanSkeletonFences } from "../skeleton-scope.js";
import { resolveProjectRoot } from "../project-root.js";

/**
 * Skeleton plans, parity PR 4 — the finalize check. When every step of a
 * skeleton plan is done, the markers must go before the change is reviewed:
 * `present_changeset` (and `present_debrief`, and the progress reply that
 * marks the last step done) check the plan's declared files for any `SKEL[`
 * or `/SKEL[` marker or `SKEL_TODO` left behind and name the locations.
 *
 * Markers come from #606's scanner (`scanSkeletonFences`, which also reports
 * malformed ones); a stray `SKEL_TODO` outside any fence is caught by a line
 * pass over the same declared files (confined to the root, size-capped, never
 * returned — locations only). Never throws.
 */

export interface SkeletonLeftover {
  file: string;
  line: number;
  what: string;
}

const MAX_BYTES = 1_000_000;
const MAX_LISTED = 20;

function within(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function skeletonLeftovers(root: string, content: unknown): { leftovers: SkeletonLeftover[]; errors: string[] } {
  const c = (content ?? {}) as { steps?: Array<{ files?: unknown }>; visuals?: Array<{ kind?: unknown; files?: unknown }> };
  const declared = planDeclaredFiles(c);
  const { fences, errors } = scanSkeletonFences(root, { files: declared });
  const out: SkeletonLeftover[] = [];
  for (const f of fences) {
    out.push({ file: f.file, line: f.openLine, what: `SKEL[${f.id}]` });
    out.push({ file: f.file, line: f.closeLine, what: `/SKEL[${f.id}]` });
  }
  // SKEL_TODO anywhere in the declared files (inside a fence or stray).
  const files = new Set([...declared, ...fences.map((f) => f.file)]);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  for (const rel of files) {
    try {
      const abs = fs.realpathSync(path.resolve(root, rel));
      if (!within(realRoot, abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const lines = fs.readFileSync(abs, "utf-8").split("\n");
      const shown = path.relative(realRoot, abs).split(path.sep).join("/");
      lines.forEach((l, i) => {
        if (l.includes("SKEL_TODO")) out.push({ file: shown, line: i + 1, what: "SKEL_TODO" });
      });
    } catch {
      /* missing or unreadable: nothing to report */
    }
  }
  out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { leftovers: out, errors };
}

/** True when every skelId step is done or skipped (and there is at least one). */
export function allSkeletonStepsDone(content: unknown): boolean {
  const steps = ((content ?? {}) as { steps?: Array<{ skelId?: unknown; status?: unknown }> }).steps ?? [];
  const skel = steps.filter((s) => typeof s?.skelId === "string" && s.skelId);
  return skel.length > 0 && skel.every((s) => s.status === "done" || s.status === "skipped");
}

export function formatLeftovers(title: string, found: { leftovers: SkeletonLeftover[]; errors: string[] }): string {
  const { leftovers, errors } = found;
  if (leftovers.length === 0 && errors.length === 0) return "";
  const listed = leftovers.slice(0, MAX_LISTED).map((l) => `${l.file}:${l.line} ${l.what}`);
  const more = leftovers.length > MAX_LISTED ? ` (+${leftovers.length - MAX_LISTED} more)` : "";
  const bad = errors.length > 0 ? `; malformed markers: ${errors.slice(0, 5).join("; ")}` : "";
  return `\n⚠ Skeleton markers remain in "${title}"'s files — strip them before the change is reviewed: ${listed.join(", ")}${more}${bad}.`;
}

/**
 * The finalize warning for every finished skeleton plan in the store: live,
 * approved, all skelId steps done. "" when there's nothing to say.
 */
export function finalizeCheckNote(artifacts: Artifact[], root?: string): string {
  try {
    const plans = artifacts.filter(
      (a) => a.type === "plan" && a.status === "approved" && isLivePlanVersion(a, artifacts) && allSkeletonStepsDone(a.content),
    );
    if (plans.length === 0) return "";
    const r = root ?? (() => {
      const pr = resolveProjectRoot();
      return pr.worktree?.workspaceRoot ?? pr.projectRoot;
    })();
    return plans.map((p) => formatLeftovers(p.title, skeletonLeftovers(r, p.content))).join("");
  } catch {
    return "";
  }
}
