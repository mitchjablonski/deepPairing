import type { Artifact, PageFileWatchRecorded, PageFileWatchRefused } from "@deeppairing/shared";
import { undeliveredFileWatch } from "@deeppairing/shared";

/**
 * #680 slice 3 — check_feedback's report of what the page file watch did since
 * the last poll: a version recorded automatically from a file (with the page
 * comments it could no longer locate), or a save it refused (rejection memory,
 * or an unreadable file). Each notice is reported once, then acknowledged.
 */

export interface PageWatchNotices {
  /** Artifacts carrying an undelivered notice (to acknowledge). */
  ids: string[];
  prose: string;
  structured: Array<Record<string, unknown>>;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function recordedLine(a: Artifact, r: PageFileWatchRecorded): string {
  const orphanCount = r.orphaned.length + (r.orphanedOverflow ?? 0);
  let line = `- ${a.id} (v${a.version}) "${a.title}" was recorded automatically from ${r.sourcePath} after your save; it supersedes ${r.fromArtifactId} (v${r.fromVersion}) and is the draft under review now.`;
  if (orphanCount === 0) {
    line += r.carriedCount > 0 ? ` All ${r.carriedCount} page comment(s) still point at text on the page.` : "";
    return line;
  }
  line += ` ${orphanCount} page comment(s) are ORPHANED — the text they point at is gone from the new version (they stay visible to your pair, marked "not found in this version"):`;
  for (const o of r.orphaned) {
    const quote = o.quote.trim() ? `"${clip(o.quote, 100)}"` : `\`${clip(o.locator, 100)}\``;
    line += `\n    • ${o.commentId}: ${o.kind} ${quote}${o.version ? ` (made on v${o.version})` : ""}`;
  }
  if (r.orphanedOverflow) line += `\n    • …and ${r.orphanedOverflow} more`;
  if (r.carriedCount > 0) line += `\n  ${r.carriedCount} other page comment(s) still point at text on the page.`;
  return line;
}

function refusedLine(a: Artifact, r: PageFileWatchRefused): string {
  if (r.cause === "gate") {
    return `- ⛔ A save to ${r.sourcePath} was NOT recorded as a new version of ${a.id} "${a.title}": ${r.message}. ` +
      `Your pair still sees v${a.version}. Change the page so it no longer proposes that approach (the next save is checked again), or ask your pair.`;
  }
  return `- ⚠ A save to ${r.sourcePath} could not be recorded for ${a.id} "${a.title}": ${r.message}. Your pair still sees v${a.version}.`;
}

export function collectPageWatchNotices(artifacts: readonly Artifact[]): PageWatchNotices {
  const ids: string[] = [];
  const lines: string[] = [];
  const structured: Array<Record<string, unknown>> = [];
  for (const a of artifacts) {
    if (a.type !== "page" || a.fileWatch === undefined) continue;
    const { recorded, refused } = undeliveredFileWatch(a.fileWatch);
    if (!recorded && !refused) continue;
    ids.push(a.id);
    if (recorded) {
      lines.push(recordedLine(a, recorded));
      structured.push({
        kind: "recorded",
        artifactId: a.id,
        version: a.version,
        sourcePath: recorded.sourcePath,
        fromArtifactId: recorded.fromArtifactId,
        fromVersion: recorded.fromVersion,
        carriedCount: recorded.carriedCount,
        orphaned: recorded.orphaned,
        ...(recorded.orphanedOverflow ? { orphanedOverflow: recorded.orphanedOverflow } : {}),
      });
    }
    if (refused) {
      lines.push(refusedLine(a, refused));
      structured.push({
        kind: "refused",
        artifactId: a.id,
        version: a.version,
        sourcePath: refused.sourcePath,
        cause: refused.cause,
        message: refused.message,
        ...(refused.concept ? { concept: refused.concept } : {}),
      });
    }
  }
  const prose = lines.length > 0 ? `📄 Page file watch (${lines.length}):\n${lines.join("\n")}` : "";
  return { ids, prose, structured };
}
