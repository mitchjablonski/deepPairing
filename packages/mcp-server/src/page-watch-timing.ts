/**
 * #714 gap 6 — the page file watch's timing, single-sourced. The daemon's
 * watch (daemon/page-watch.ts) uses these, and the standalone guide quotes
 * them, without the guide importing any daemon or file-watch module.
 */

/** A save waits for this much quiet before it is recorded. */
export const PAGE_WATCH_QUIET_MS = 2_000;
/** At most one recorded version per this interval. */
export const PAGE_WATCH_MIN_INTERVAL_MS = 10_000;
