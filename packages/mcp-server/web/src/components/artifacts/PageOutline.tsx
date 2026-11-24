import type { PageOutlineHeading } from "../../lib/pageAnchorMessages";

/**
 * #714 gap 4 — the page's skim map: its h1–h3 headings as a clickable outline,
 * each with the open comments and changed blocks in that section, and the
 * section the reader is in highlighted (reading progress).
 *
 * Everything shown is frame-reported text, a display-only hint, rendered as
 * React text nodes only. Clicking an entry only scrolls the frame.
 */

export interface PageOutlineProps {
  headings: PageOutlineHeading[];
  /** Open anchored comments per heading index. */
  commentCounts: number[];
  /** Changed blocks per heading index (from the version diff). */
  changeCounts: number[];
  /** The section the reader is in (-1 = above the first heading). */
  active: number;
  onJump: (index: number) => void;
  /** "rail" = the sticky side rail; "disclosure" = the collapsible narrow form. */
  variant: "rail" | "disclosure";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function OutlineList({ headings, commentCounts, changeCounts, active, onJump, variant }: PageOutlineProps) {
  const minLevel = Math.min(...headings.map((h) => h.level));
  return (
    <ol className="space-y-0.5" data-testid={`page-outline-list-${variant}`}>
      {headings.map((h, i) => {
        const comments = commentCounts[i] ?? 0;
        const changes = changeCounts[i] ?? 0;
        const current = i === active;
        const label = [
          h.text,
          comments > 0 ? plural(comments, "open comment", "open comments") : "",
          changes > 0 ? plural(changes, "changed block", "changed blocks") : "",
          current ? "you are here" : "",
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <li key={i} style={{ paddingLeft: `${(h.level - minLevel) * 0.75}rem` }}>
            <button
              type="button"
              onClick={() => onJump(i)}
              aria-current={current ? "location" : undefined}
              aria-label={`Go to ${label}`}
              title={h.text}
              className={`w-full flex items-center gap-1.5 text-left px-1.5 py-0.5 rounded text-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${
                current
                  ? "bg-accent-blue-dim/40 text-text-primary font-semibold border-l-2 border-accent-blue"
                  : "text-text-secondary hover:bg-surface-elevated border-l-2 border-transparent"
              }`}
              data-testid="page-outline-entry"
              data-level={h.level}
            >
              <span className="flex-1 min-w-0 truncate">{h.text}</span>
              {comments > 0 && (
                <span
                  aria-hidden="true"
                  className="shrink-0 px-1 rounded-full bg-accent-amber text-[10px] font-semibold text-black"
                  data-testid="page-outline-comments"
                >
                  {comments}
                </span>
              )}
              {changes > 0 && (
                <span
                  aria-hidden="true"
                  className="shrink-0 px-1 rounded-full border border-accent-violet/60 text-[10px] font-semibold text-accent-violet"
                  data-testid="page-outline-changes"
                >
                  ~{changes}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function progressLabel(active: number, total: number, headings: PageOutlineHeading[]): string {
  // The frame may report the active index for an outline that has since
  // changed: anything out of range reads as the top until it re-reports.
  const h = active >= 0 ? headings[active] : undefined;
  return h ? `Section ${active + 1} of ${total}: ${h.text}` : `Top of the page (${plural(total, "section", "sections")})`;
}

export function PageOutline(props: PageOutlineProps) {
  const { headings, active, variant } = props;
  if (headings.length === 0) return null;
  const progress = progressLabel(active, headings.length, headings);
  if (variant === "disclosure") {
    return (
      <details className="rounded-lg border border-border-default text-2xs" data-testid="page-outline-disclosure">
        <summary className="cursor-pointer px-2 py-1 text-text-secondary">
          Outline <span className="text-text-muted">· {progress}</span>
        </summary>
        <nav aria-label="Page outline" className="px-1 pb-1.5 max-h-64 overflow-y-auto">
          <OutlineList {...props} />
        </nav>
      </details>
    );
  }
  return (
    <nav
      aria-label="Page outline"
      className="sticky top-2 max-h-[70vh] overflow-y-auto rounded-lg border border-border-default p-1.5 space-y-1"
      data-testid="page-outline-rail"
    >
      <div className="px-1.5 text-2xs font-semibold text-text-muted uppercase tracking-wide">Outline</div>
      <div className="px-1.5 text-[10px] text-text-muted" data-testid="page-outline-progress">
        {progress}
      </div>
      <OutlineList {...props} />
    </nav>
  );
}
