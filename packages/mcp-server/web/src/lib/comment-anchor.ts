/**
 * X10 — comment-anchor key + scroll dispatch.
 *
 * The Conversation rail used to navigate via `dp:focus-artifact`, which
 * only selected the artifact card. The user still had to hunt for the
 * commented line / step / finding inside it. X10 carries the anchor
 * through the same dispatch so the rail row → artifact spot is one click.
 *
 * The anchor is encoded as a stable string ("anchor key") so the receiver
 * can look the row up with a single querySelector. The artifact components
 * stamp `data-comment-anchor={key}` on the corresponding row.
 *
 * Why a string and not a structured object: querySelector is the cheapest
 * scan we can do, and CSS attribute selectors are the natural fit. A
 * string also survives serialization through CustomEvent.detail without
 * any object-identity surprises.
 */
export type CommentAnchorTarget = {
  filePath?: string;
  lineStart?: number;
  stepIndex?: number;
  findingIndex?: number;
  evidenceIndex?: number;
};

/** Derive the anchor key from a comment's target. Returns null when the
 *  comment doesn't anchor to anything specific (e.g. an artifact-root or
 *  session-level message — the artifact card is the right landing zone). */
export function commentAnchorKey(target: CommentAnchorTarget | undefined): string | null {
  if (!target) return null;
  if (typeof target.lineStart === "number") {
    // filePath qualifies the anchor when the artifact has multiple files
    // (code_change), so two comments on `L23` of different files don't
    // collide. Empty string for the file segment when undefined keeps the
    // shape stable.
    return `line:${target.filePath ?? ""}:${target.lineStart}`;
  }
  if (typeof target.findingIndex === "number") {
    if (typeof target.evidenceIndex === "number") {
      return `finding:${target.findingIndex}:${target.evidenceIndex}`;
    }
    return `finding:${target.findingIndex}`;
  }
  if (typeof target.stepIndex === "number") return `step:${target.stepIndex}`;
  return null;
}

const HIGHLIGHT_CLASS = "dp-anchor-highlight";
const HIGHLIGHT_DURATION_MS = 1500;

/** Dispatched after the artifact has been selected. The artifact panel
 *  owns the scroll: we only fire the event; receivers query the DOM for
 *  `[data-comment-anchor="{key}"]`. */
export const ANCHOR_SCROLL_EVENT = "dp:scroll-to-anchor";

export function dispatchScrollToAnchor(artifactId: string, anchorKey: string): void {
  window.dispatchEvent(
    new CustomEvent(ANCHOR_SCROLL_EVENT, {
      detail: { artifactId, anchorKey },
    }),
  );
}

/** Resolve the anchor on the page and scroll it into view + flash a
 *  brief highlight. Idempotent — safe to call after the artifact has
 *  already mounted, or to retry if the first call lost the race. */
export function scrollToAnchor(artifactId: string, anchorKey: string): boolean {
  // Scope by both artifactId AND anchorKey so multi-artifact pages
  // (the artifact panel can render two stacked artifacts during transitions)
  // don't grab the wrong one.
  const selector = `[data-artifact-id="${cssEscape(artifactId)}"] [data-comment-anchor="${cssEscape(anchorKey)}"]`;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
  el.classList.add(HIGHLIGHT_CLASS);
  window.setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_DURATION_MS);
  return true;
}

/** CSS.escape polyfill for jsdom (which still doesn't expose it) and for
 *  safety against arbitrary characters in filePath segments. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
