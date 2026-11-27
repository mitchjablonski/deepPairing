import type { PageAsk } from "../../lib/pageAnchorMessages";

/**
 * #714 gap 5 — "Wants from you": the decisions and questions the page marks
 * (data-dp-decision / data-dp-question), collected above the frame so a
 * skimming reviewer sees what's being asked before reading the page.
 *
 * Each ask is frame-reported text (a display-only hint), rendered as React
 * text nodes. Jump scrolls the frame to it; Reply only OPENS the composer
 * anchored to it — a comment exists only when the reviewer submits one. An
 * ask counts as answered once a human comment is anchored to it.
 */

export interface PageAsksStripProps {
  asks: PageAsk[];
  answered: boolean[];
  /** #727 — the frame or a parse hasn't reported yet: an unanswered ask
   *  shows a neutral "Checking…" instead of a definitive "Open". */
  checking?: boolean;
  readOnly: boolean;
  onJump: (index: number) => void;
  onReply: (index: number) => void;
}

const KIND_LABEL: Record<PageAsk["kind"], string> = { decision: "Decide", question: "Question" };

export function PageAsksStrip({ asks, answered, checking = false, readOnly, onJump, onReply }: PageAsksStripProps) {
  if (asks.length === 0) return null;
  const done = answered.filter(Boolean).length;
  const open = asks.length - done;
  const openLabel = checking && open > 0 ? `${open} checking` : `${open} open`;
  return (
    <section
      aria-label={`Wants from you: ${asks.length} ${asks.length === 1 ? "ask" : "asks"}, ${openLabel}`}
      className="rounded-lg border border-accent-amber/40 bg-accent-amber/5 px-3 py-2 space-y-1.5"
      data-testid="page-asks"
    >
      <h3 className="flex flex-wrap items-baseline gap-2 text-xs font-semibold text-text-primary">
        <span>Wants from you ({asks.length})</span>
        <span className="text-2xs font-normal text-text-muted" data-testid="page-asks-tally">
          {openLabel} · {done} answered
        </span>
      </h3>
      <ul className="space-y-1 max-h-60 overflow-y-auto">
        {asks.map((ask, i) => {
          const isAnswered = answered[i] === true;
          const state = isAnswered ? "answered" : checking ? "checking" : "open";
          const text = ask.text.trim() || (ask.id ? `#${ask.id}` : "(no text)");
          return (
            <li
              key={`${i}-${ask.locator}`}
              className={`flex flex-wrap items-start gap-2 text-2xs ${isAnswered ? "opacity-70" : ""}`}
              data-testid="page-ask"
              data-answered={isAnswered ? "true" : "false"}
              data-state={state}
            >
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded font-semibold ${
                  ask.kind === "decision" ? "bg-accent-violet/15 text-accent-violet" : "bg-accent-blue-dim/40 text-accent-blue"
                }`}
              >
                {KIND_LABEL[ask.kind]}
              </span>
              <span className="flex-1 min-w-0 text-xs text-text-primary break-words line-clamp-2">{text}</span>
              <span
                className={`shrink-0 ${isAnswered ? "text-accent-green" : checking ? "text-text-muted" : "text-accent-amber"}`}
                data-testid="page-ask-state"
              >
                {isAnswered ? "Answered" : checking ? "Checking\u2026" : "Open"}
              </span>
              <span className="shrink-0 inline-flex gap-1">
                <button
                  type="button"
                  onClick={() => onJump(i)}
                  aria-label={`Show on the page: ${text}`}
                  className="px-1.5 py-0.5 rounded border border-border-default hover:bg-surface-elevated text-text-secondary"
                >
                  Jump
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onReply(i)}
                    aria-label={`Reply to: ${text}`}
                    className="px-1.5 py-0.5 rounded border border-accent-blue/40 hover:bg-accent-blue-dim/30 text-accent-blue"
                  >
                    Reply
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
