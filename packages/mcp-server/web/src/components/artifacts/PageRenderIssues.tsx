import { useState } from "react";
import type { PageDiagnostics } from "../../lib/pageAnchorMessages";
import { diagnosticsDetails, diagnosticsHeadline, hasDiagnostics } from "../../lib/pageDiagnostics";

/**
 * #714 gap 12 — a small, dismissible banner: "This page has 2 script errors and
 * 3 images that didn't load." with the details (kinds, counts and redacted
 * samples) behind a disclosure. PASSIVE: it renders text only and has no
 * action beyond showing details and hiding itself. The report comes from the
 * page's frame (after Run the page's own script could forge one), so nothing
 * here may ever do more than display it.
 *
 * Dismissal is per report: a later report that differs (a new error after Run)
 * shows the banner again.
 */
export function PageRenderIssues({ diagnostics }: { diagnostics: PageDiagnostics | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!hasDiagnostics(diagnostics)) return null;
  const headline = diagnosticsHeadline(diagnostics);
  if (!headline) return null;
  const key = JSON.stringify(diagnostics);
  if (dismissed === key) return null;
  const details = diagnosticsDetails(diagnostics);
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-lg border border-accent-amber/40 bg-accent-amber/10 text-xs text-text-primary"
      role="status"
      data-testid="page-render-issues"
    >
      <div className="min-w-0 flex-1">
        <span data-testid="page-render-issues-headline">This page has {headline}.</span>
        {details.length > 0 && (
          <details className="mt-1 text-2xs text-text-secondary">
            <summary className="cursor-pointer text-text-muted">Details</summary>
            <ul className="mt-1 space-y-0.5 list-disc pl-4 break-words" data-testid="page-render-issues-details">
              {details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(key)}
        aria-label="Dismiss render issues"
        className="shrink-0 px-1 rounded text-text-muted hover:bg-surface-elevated"
        data-testid="page-render-issues-dismiss"
      >
        ×
      </button>
    </div>
  );
}
