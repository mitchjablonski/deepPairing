import type { PageDiffSummary } from "../../lib/pageVersionDiff";
import { formatPageDiffSummary, sectionLabel } from "../../lib/pageVersionDiff";

/**
 * #714 gap 2 — the sections a page revision touched, and what it removed.
 * Everything here is page TEXT read out of a parsed (never executed) document
 * and rendered as React text nodes, never as markup.
 */
export function PageChangeSummary({
  summary,
  truncated,
  variant = "full",
  title = "Page",
}: {
  summary: PageDiffSummary;
  truncated?: boolean;
  variant?: "full" | "line";
  title?: string | null;
}) {
  const line = formatPageDiffSummary(summary);
  const nothing = !line;
  if (variant === "line") {
    return (
      <span className="text-2xs text-text-secondary" data-testid="page-change-summary-line">
        {nothing ? "No visible text changed (markup or styling only)." : line}
        {truncated ? " (Very large page: only the first part was compared.)" : ""}
      </span>
    );
  }
  return (
    <div className="space-y-1" data-testid="page-change-summary">
      {title && <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide">{title}</div>}
      {nothing ? (
        <div className="text-2xs text-text-muted italic">No visible text changed (markup or styling only).</div>
      ) : (
        <ul className="text-2xs space-y-0.5">
          {summary.changedSections.length > 0 && (
            <li className="flex items-baseline gap-1.5" data-testid="page-change-changed">
              <span className="text-accent-violet font-bold w-3 shrink-0">~</span>
              <span className="text-text-primary">Changed: {summary.changedSections.map(sectionLabel).join(", ")}</span>
            </li>
          )}
          {summary.addedSections.length > 0 && (
            <li className="flex items-baseline gap-1.5" data-testid="page-change-added">
              <span className="text-accent-green font-bold w-3 shrink-0">＋</span>
              <span className="text-text-primary">Added: {summary.addedSections.map(sectionLabel).join(", ")}</span>
            </li>
          )}
          {summary.removedSections.length > 0 && (
            <li className="flex items-baseline gap-1.5" data-testid="page-change-removed-sections">
              <span className="text-accent-red font-bold w-3 shrink-0">−</span>
              <span className="text-text-secondary">Removed sections: {summary.removedSections.map(sectionLabel).join(", ")}</span>
            </li>
          )}
          {summary.removed.map((g) => (
            <li key={`r-${g.section}`} className="flex items-baseline gap-1.5" data-testid="page-change-removed">
              <span className="text-accent-red font-bold w-3 shrink-0">−</span>
              <span className="min-w-0">
                <span className="text-text-secondary">
                  Removed {g.count} {g.noun} {g.section ? `under ${g.section}` : "at the top of the page"}
                </span>
                <span className="block text-text-muted line-through opacity-80 break-words">
                  {g.texts.slice(0, 3).map((t) => (t.length > 140 ? `${t.slice(0, 139)}…` : t)).join(" · ")}
                  {g.texts.length > 3 ? ` · and ${g.texts.length - 3} more` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {truncated && <div className="text-2xs text-text-muted">Very large page: only the first part was compared.</div>}
    </div>
  );
}
