import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@deeppairing/shared";
import { coercePageContent, readFileWatch } from "@deeppairing/shared";
import { useArtifactStore } from "../stores/artifact";
import {
  computePageVersionDiff,
  peekPageVersionDiff,
  summarizePageDiff,
  type PageDiffSummary,
  type PageVersionDiff,
} from "../lib/pageVersionDiff";

export interface PageLineageEntry {
  artifact: Artifact;
  /** Recorded by the page file watch (an auto-save), not a deliberate revise. */
  autoSave: boolean;
}

/**
 * #714 gap 2 — the earlier versions of this page that are loaded, newest
 * first (the immediate predecessor first). The file watch can land several
 * auto-saves between two reviews, so the reviewer may compare against any of
 * them, not only the last.
 */
export function usePageLineage(artifact: Artifact): PageLineageEntry[] {
  const artifacts = useArtifactStore((s) => s.artifacts);
  return useMemo(() => {
    const out: PageLineageEntry[] = [];
    if (artifact.type !== "page") return out;
    const seen = new Set<string>([artifact.id]);
    let parentId = artifact.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const p = artifacts.find((a) => a.id === parentId);
      if (!p || p.type !== "page") break;
      out.push({ artifact: p, autoSave: !!readFileWatch(p.fileWatch).recorded });
      parentId = p.parentId;
    }
    return out;
  }, [artifacts, artifact.id, artifact.parentId, artifact.type]);
}

export interface PageVersionChanges {
  base: Artifact;
  diff: PageVersionDiff;
  summary: PageDiffSummary;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/**
 * #714 gap 2 — what changed in this `page` version since `base` (an earlier
 * version in its lineage): null when there is no base. Both versions are
 * parsed with DOMParser (inert; nothing runs) and diffed in the companion,
 * OFF the render path: a cached pair is returned at once, otherwise the diff
 * runs in an idle callback and lands in state, so a 2 MiB page never blocks
 * the first paint. `pending` is true until it lands.
 */
export function usePageVersionDiff(
  artifact: Artifact,
  base: Artifact | undefined,
): { changes: PageVersionChanges | null; pending: boolean } {
  const oldHtml = base?.type === "page" ? coercePageContent(base.content).html : null;
  const newHtml = artifact.type === "page" ? coercePageContent(artifact.content).html : null;
  const key = base && oldHtml !== null && newHtml !== null ? `${base.id}\u0000${artifact.id}` : null;
  const [done, setDone] = useState<{ key: string; diff: PageVersionDiff | null } | null>(null);

  const cached = key && oldHtml !== null && newHtml !== null ? peekPageVersionDiff(oldHtml, newHtml) : undefined;
  useEffect(() => {
    if (!key || oldHtml === null || newHtml === null) return;
    if (peekPageVersionDiff(oldHtml, newHtml) !== undefined) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const diff = computePageVersionDiff(oldHtml, newHtml);
      if (!cancelled) setDone({ key, diff });
    };
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === "function") {
      const h = w.requestIdleCallback(run, { timeout: 400 });
      return () => {
        cancelled = true;
        w.cancelIdleCallback?.(h);
      };
    }
    const t = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, oldHtml, newHtml]);

  const diff = cached !== undefined ? cached : done && done.key === key ? done.diff : undefined;
  const changes = useMemo(
    () => (base && diff ? { base, diff, summary: summarizePageDiff(diff) } : null),
    [base, diff],
  );
  return { changes, pending: !!key && diff === undefined };
}
