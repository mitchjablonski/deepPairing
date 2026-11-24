import type { PageDiffSummary } from "../../lib/pageVersionDiff";
import { formatPageDiffSummary, sectionLabel } from "../../lib/pageVersionDiff";

/**
 * #714 gap 2 — what a page revision changed, as text. Everything here is page
 * TEXT read out of a parsed (never executed) document and rendered as React
 * text nodes, never as markup.
 */

const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** One line: "Changed: Storage; Added: Risks; Removed: …", or the honest
 *  no-change state (unchanged / markup only / text outside blocks). */
export function PageChangeLine({ summary, truncated }: { summary: PageDiffSummary; truncated?: boolean }) {
  return (
    <span className="text-2xs text-text-secondary" data-testid="page-change-summary-line" data-state={summary.state}>
      {formatPageDiffSummary(summary)}
      {truncated ? " (Very large page: only the first part was compared.)" : ""}
    </span>
  );
}

/** The text that is gone: whole removed sections with their body, then
 *  removed blocks grouped by the (old) section they sat in. */
export function PageRemovedList({ summary }: { summary: PageDiffSummary }) {
  return (
    <ul className="space-y-1" data-testid="page-removed-list">
      {summary.removedSections.map((r) => (
        <li key={`s-${r.sectionId}`} data-testid="page-removed-section">
          <span className="text-text-secondary">
            Section <span className="font-medium">{sectionLabel(r.section)}</span>
            {r.texts.length > 0 ? ` (${r.texts.length} ${r.noun})` : ""}
          </span>
          {r.texts.length > 0 && <RemovedTexts texts={r.texts} />}
        </li>
      ))}
      {summary.removed.map((g) => (
        <li key={`g-${g.sectionId}`} data-testid="page-removed-group">
          <span className="text-text-secondary">
            {g.count} {g.noun} {g.section ? `under ${g.section}` : "at the top of the page"}
          </span>
          <RemovedTexts texts={g.texts} />
        </li>
      ))}
    </ul>
  );
}

function RemovedTexts({ texts }: { texts: string[] }) {
  const shown = texts.slice(0, 8);
  return (
    <ul className="pl-3 text-text-muted">
      {shown.map((t, i) => (
        <li key={i} className="line-through opacity-80 break-words">
          {clip(t)}
        </li>
      ))}
      {texts.length > shown.length && <li>and {texts.length - shown.length} more</li>}
    </ul>
  );
}
