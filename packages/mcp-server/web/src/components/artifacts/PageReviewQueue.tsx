import { useEffect, useId, useRef } from "react";
import type { Comment, HtmlAnchor } from "@deeppairing/shared";
import { htmlAnchorKindLabel } from "../../lib/htmlAnchorDisplay";
import {
  QUEUE_FILTERS,
  QUEUE_FILTER_LABEL,
  resolveAction,
  stateFilter,
  stateLabel,
  type PageCommentState,
  type QueueEntry,
  type QueueFilter,
} from "../../lib/pageReviewQueue";

/**
 * #714 gap 7 — the page's anchored comments as a review queue: Open /
 * Addressed / Orphaned filters with counts, each row with its pin number
 * (coloured like its pin in the frame), an honest state chip, its reply count
 * and the version it was made on. Clicking a row focuses its pin in the frame
 * and opens its thread in the composer. A pin clicked in the frame highlights
 * and scrolls to its row (`highlightId`).
 *
 * Everything here is React text: comment text comes from the store, anchor
 * text from the comment's saved anchor; nothing from the frame is rendered.
 */

export function AnchorContext({ anchor }: { anchor: HtmlAnchor }) {
  const quote = anchor.quote.trim();
  // #714 gap 10 — which part of the page the spot is in.
  const heading = typeof anchor.section?.heading === "string" ? anchor.section.heading.trim() : "";
  const sectionId = typeof anchor.section?.id === "string" ? anchor.section.id : "";
  return (
    <div className="space-y-0.5 text-2xs text-text-muted" data-testid="page-anchor-context">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded bg-surface-elevated text-text-secondary">{htmlAnchorKindLabel(anchor.kind)}</span>
        {quote ? (
          <span className="text-text-primary italic break-words">“{quote}”</span>
        ) : (
          <code className="font-mono break-all">{anchor.locator}</code>
        )}
      </div>
      {anchor.table && (anchor.table.row || anchor.table.col) && (
        <div>
          {anchor.table.row && <>Row <span className="text-text-secondary">{anchor.table.row}</span></>}
          {anchor.table.row && anchor.table.col && " · "}
          {anchor.table.col && <>Column <span className="text-text-secondary">{anchor.table.col}</span></>}
        </div>
      )}
      {(heading || sectionId) && (
        <div className="break-words" data-testid="page-anchor-section">
          In {heading && <span className="text-text-secondary">{heading}</span>}
          {heading && sectionId && " "}
          {sectionId && <code className="font-mono">#{sectionId}</code>}
        </div>
      )}
      {anchor.nodeId && <div>Node <code className="font-mono">{anchor.nodeId}</code></div>}
      {anchor.href && <div className="break-all">Link to <code className="font-mono">{anchor.href}</code></div>}
      {quote && <div className="break-all">at <code className="font-mono">{anchor.locator}</code></div>}
    </div>
  );
}

/** The pin-number dot, styled like the frame's pin for the same state. */
export function PinDot({ n, state }: { n: number; state: PageCommentState }) {
  const tone =
    state.kind === "addressed"
      ? "bg-text-muted text-black"
      : state.kind === "orphaned"
        ? "border border-dashed border-accent-amber text-accent-amber bg-transparent"
        : "bg-accent-amber text-black";
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center ${tone}`}
      data-testid="page-annotation-pin"
      data-state={state.kind}
    >
      {n}
    </span>
  );
}

const CHIP_TONE: Record<QueueFilter, string> = {
  open: "text-accent-blue",
  addressed: "text-text-muted",
  orphaned: "text-accent-amber",
};

export type QueueFilterChoice = QueueFilter | "all";

export interface PageReviewQueueProps {
  entries: QueueEntry[];
  counts: Record<QueueFilter, number>;
  filter: QueueFilterChoice;
  onFilter: (f: QueueFilterChoice) => void;
  highlightId: string | null;
  /** Bumped on each pin click: scroll the highlighted row into view (and, when
   *  `focusRow` is set, move focus to it). */
  revealNonce: number;
  focusRow: boolean;
  onSelect: (index: number) => void;
  /** The version a comment was made on, when not this one. */
  fromVersion: (c: Comment) => number | undefined;
  liveStances: Set<string>;
  /** "rail" = in the side review rail; "below" = under the frame. */
  variant: "rail" | "below";
  /** #714 gap 9 — step to the next / previous comment in the visible list
   *  (also the ] and [ keys). Omitted → no step buttons. */
  onStep?: (dir: 1 | -1) => void;
  /** #714 — the reviewer's own Resolve / Reopen on a plain comment (omitted
   *  on a read-only page → no buttons). */
  onResolve?: (commentId: string, resolve: boolean) => void;
  /** #725 — comments that answer one of the page's asks: no Resolve/Reopen. */
  askAnswerIds?: ReadonlySet<string>;
}

export function PageReviewQueue({
  entries,
  counts,
  filter,
  onFilter,
  highlightId,
  revealNonce,
  focusRow,
  onSelect,
  fromVersion,
  liveStances,
  variant,
  onStep,
  onResolve,
  askAnswerIds,
}: PageReviewQueueProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const idBase = useId();
  useEffect(() => {
    if (!revealNonce || !highlightId) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-comment-id]") ?? []).find(
      (el) => el.getAttribute("data-comment-id") === highlightId,
    );
    row?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    if (focusRow) row?.focus?.({ preventScroll: true });
    // Only on a fresh reveal: re-renders must not re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce]);

  if (entries.length === 0) return null;
  const visible = filter === "all" ? entries : entries.filter((e) => stateFilter(e.state) === filter);
  const choices: QueueFilterChoice[] = [...QUEUE_FILTERS, "all"];
  return (
    <section className="space-y-1.5" data-testid="page-annotations" data-variant={variant} aria-label="Comments on the page">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide">On the page</h3>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter comments" data-testid="page-queue-filters">
          {choices.map((f) => {
            const n = f === "all" ? entries.length : counts[f];
            const label = f === "all" ? "All" : QUEUE_FILTER_LABEL[f];
            return (
              <button
                key={f}
                type="button"
                onClick={() => onFilter(f)}
                aria-pressed={filter === f}
                className={`px-1.5 py-0.5 rounded border text-2xs pointer-coarse:min-h-11 ${
                  filter === f
                    ? "border-accent-blue bg-accent-blue-dim/40 text-text-primary"
                    : "border-border-default text-text-secondary hover:bg-surface-elevated"
                }`}
                data-testid={`page-queue-filter-${f}`}
              >
                {label} <span className="tabular-nums">{n}</span>
              </button>
            );
          })}
        </div>
        {onStep && visible.length > 0 && (
          <div className="flex gap-1 ml-auto" role="group" aria-label="Step through comments">
            <button
              type="button"
              onClick={() => onStep(-1)}
              aria-label="Previous comment"
              aria-keyshortcuts="["
              title="Previous comment ( [ )"
              className="px-1.5 py-0.5 rounded border border-border-default text-2xs text-text-secondary hover:bg-surface-elevated pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              data-testid="page-queue-prev"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => onStep(1)}
              aria-label="Next comment"
              aria-keyshortcuts="]"
              title="Next comment ( ] )"
              className="px-1.5 py-0.5 rounded border border-border-default text-2xs text-text-secondary hover:bg-surface-elevated pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              data-testid="page-queue-next"
            >
              ›
            </button>
          </div>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-2xs text-text-muted italic" data-testid="page-queue-empty">
          {filter === "open"
            ? "Nothing open: every comment has been addressed or is no longer on the page."
            : filter === "addressed"
              ? "Nothing addressed yet."
              : "Every comment's spot is on this version."}
        </p>
      ) : (
        <ol className="space-y-1.5" ref={listRef}>
          {visible.map((entry) => {
            const { comment: c, index: i, state, replies, missing } = entry;
            const anchor = c.target.htmlAnchor as HtmlAnchor;
            const chip = stateLabel(state);
            const highlighted = c.id === highlightId;
            const from = fromVersion(c);
            const action = onResolve ? resolveAction(entry, { answersAsk: askAnswerIds?.has(c.id) === true }) : null;
            return (
              <li key={c.id} className="flex gap-1 items-stretch">
                <span className="sr-only" id={`${idBase}-state-${i}`}>
                  {chip.title}
                </span>
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  aria-current={highlighted ? "true" : undefined}
                  // The visible content is the accessible name (number, state,
                  // replies, spot, comment); the state's meaning is a description.
                  aria-describedby={`${idBase}-state-${i}`}
                  className={`flex-1 min-w-0 text-left flex gap-2 p-2 rounded border hover:bg-surface-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue ${
                    highlighted ? "border-accent-blue ring-1 ring-accent-blue bg-accent-blue-dim/20" : "border-border-default"
                  } ${state.kind === "addressed" ? "opacity-75" : ""}`}
                  data-testid="page-annotation"
                  data-comment-id={c.id}
                  data-state={state.kind}
                >
                  <PinDot n={i + 1} state={state} />
                  <span className="flex-1 min-w-0 space-y-1">
                    <span className="sr-only">Comment {i + 1}.</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs">
                      <span
                        className={`font-semibold ${CHIP_TONE[stateFilter(state)]}`}
                        title={chip.title}
                        data-testid={state.kind === "orphaned" ? "page-anchor-missing" : "page-annotation-state"}
                      >
                        {chip.text}
                      </span>
                      {replies > 0 && (
                        <span className="text-text-muted" data-testid="page-annotation-replies">
                          {replies} {replies === 1 ? "reply" : "replies"}
                        </span>
                      )}
                      {from != null && <span className="text-text-muted italic">from v{from}</span>}
                    </span>
                    <AnchorContext anchor={anchor} />
                    {c.ruleOut && liveStances.has(c.ruleOut.description) && (
                      <span className="block text-2xs text-accent-red" data-testid="page-annotation-ruled-out">
                        Ruled out: Claude won't present a page that still contains “{c.ruleOut.description}”
                      </span>
                    )}
                    {c.ruleOut && !liveStances.has(c.ruleOut.description) && (
                      <span className="block text-2xs text-text-muted" data-testid="page-annotation-ruled-out-retired">
                        Was ruled out; that stance has since been retired
                      </span>
                    )}
                    {missing && state.kind !== "orphaned" && (
                      <span className="block text-2xs text-text-muted" data-testid="page-anchor-gone">
                        Its spot is no longer on this version of the page.
                      </span>
                    )}
                    <span className="block text-xs text-text-primary line-clamp-3 break-words">{c.content}</span>
                  </span>
                </button>
                {action && (
                  <button
                    type="button"
                    onClick={() => onResolve!(c.id, action.kind === "resolve")}
                    title={action.title}
                    aria-label={`${action.label} comment ${i + 1}`}
                    className="shrink-0 self-start px-2 py-1 rounded border border-border-default text-2xs text-text-secondary hover:bg-surface-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    data-testid={action.kind === "resolve" ? "page-annotation-resolve" : "page-annotation-reopen"}
                  >
                    {action.label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
