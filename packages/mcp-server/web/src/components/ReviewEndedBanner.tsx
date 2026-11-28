import { useConnectionStore } from "../stores/connection";

/**
 * #711 gate 4 — this tab's standalone review has ended. The daemon already
 * refuses every write with a typed 409 (`session_ended` /
 * `session_marker_invalid`); the banner says so before the pair tries one.
 */
export function ReviewEndedBanner() {
  const reviewEnded = useConnectionStore((s) => s.reviewEnded);
  if (!reviewEnded) return null;
  const invalid = reviewEnded.code === "session_marker_invalid";
  let when = "";
  if (!invalid && reviewEnded.endedAt) {
    const at = new Date(reviewEnded.endedAt);
    if (!Number.isNaN(at.getTime())) when = ` at ${at.toLocaleString()}`;
  }
  return (
    <div
      className="px-3 py-1.5 bg-surface-elevated border-b border-border-subtle text-center"
      role="status"
      data-testid="review-ended-banner"
      data-code={reviewEnded.code}
    >
      <span className="text-2xs text-text-secondary">
        {invalid
          ? "This review's End marker can't be verified, so it is read-only. Review its session files before retrying."
          : `Review ended${when}. It is read-only now — comments, verdicts and choices are no longer accepted.`}
      </span>
    </div>
  );
}
