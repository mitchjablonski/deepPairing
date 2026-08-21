/**
 * Q6 (#232) B3 — WHICH of a concept's instances grounds its stance, and how to
 * quote it truthfully.
 *
 * A philosophy entry is a bag of instances, each `{ verdict, reason, at }`. Three
 * separate surfaces quote one of those reasons back to the human as the grounds
 * for a stance:
 *   • recall mode='philosophy'  — the ledger listing
 *   • recall mode='any'         — the mode the PR-review ledger sweep calls
 *   • the first-call hint       — "Strong 'avoid' stances" / "Patterns the user prefers"
 *
 * All three independently did `instances.reverse().find(i => i.reason)` — the
 * LATEST reason of ANY verdict — and printed it under a stance label. On a
 * contested concept that is simply false: a pattern rejected twice and later
 * approved once rendered as
 *
 *     Strong 'avoid' stances:  - "in-process rate limiting" — "fine for the single-instance worker"
 *
 * quoting the human's APPROVAL as their reason for avoiding it. recall
 * compounded it by pairing that reason with `entry.lastSeenAt`, a timestamp that
 * advances on any touch, so the PR-review sweep would tell a colleague "you
 * rejected this on <the day you actually approved it>".
 *
 * That matters more here than it would elsewhere: these quotes get repeated to
 * OTHER PEOPLE, on their pull requests, as the reason their work is being
 * pushed back on. A citation has to be something the human would recognise as
 * theirs.
 *
 * So: one place decides which instance grounds a stance, and the date always
 * comes from that same instance. No new stored field — per-verdict timestamps
 * have always been on each instance; the old code just never read them.
 */
import type { PhilosophyEntry, PhilosophyInstance, PhilosophyStance } from "./global-store.js";

/**
 * The instance whose reason legitimately grounds this stance.
 *
 * 'avoid' rests on the human's REJECTIONS, 'prefer' on their approvals — take
 * the most recent of the grounding kind. If the grounding kind has no reason
 * recorded, fall back to the other side rather than going silent: a labelled
 * quote from the other verdict is still true, because every caller renders the
 * verdict alongside it.
 */
export function groundingInstance(
  entry: Pick<PhilosophyEntry, "instances">,
  stance: PhilosophyStance,
): PhilosophyInstance | undefined {
  const withReason = entry.instances.filter((i) => i.reason);
  const latestOf = (verdict: "rejected" | "approved") =>
    [...withReason].reverse().find((i) => i.verdict === verdict);
  if (stance === "avoid") return latestOf("rejected") ?? latestOf("approved");
  if (stance === "prefer") return latestOf("approved") ?? latestOf("rejected");
  // 'mixed' — no single grounding; callers that want both sides use
  // formatStanceCitation, which shows them.
  return [...withReason].reverse()[0];
}

/**
 * One instance as `rejected on 2026-05-01: "…"`.
 *
 * The verdict is IN the phrase, so a date can never be read as belonging to the
 * other verdict. Date only, never a clock time — the useful granularity for
 * "when did I decide this" is the day, and a review comment should not quote
 * milliseconds. A malformed or absent timestamp degrades to "recorded earlier"
 * rather than asserting a verdict date we cannot stand behind.
 */
export function formatInstance(i: PhilosophyInstance): string {
  const day = typeof i.at === "string" && /^\d{4}-\d{2}-\d{2}/.test(i.at) ? i.at.slice(0, 10) : "";
  const when = day ? `${i.verdict === "rejected" ? "rejected" : "approved"} on ${day}` : "recorded earlier";
  return `${when}: "${i.reason}"`;
}

/**
 * The full citation for a stance, as recall renders it.
 *
 * For 'avoid'/'prefer' that is the grounding instance. For 'mixed' — a genuinely
 * contested concept (deriveStance: neither side is 2× the other) — it is BOTH
 * sides in the order they happened. Showing only the latest word would be the
 * same bug in another costume (the human never learns they rejected it twice);
 * showing only the rejection would hide that they later came round. Both, in
 * order, is the only rendering that is true of a contested history — and it is
 * exactly what a reviewer needs: "you said no, then later said yes; you decide."
 */
export function formatStanceCitation(
  entry: Pick<PhilosophyEntry, "instances">,
  stance: PhilosophyStance,
): string {
  if (stance === "mixed") {
    const withReason = entry.instances.filter((i) => i.reason);
    const latestOf = (verdict: "rejected" | "approved") =>
      [...withReason].reverse().find((i) => i.verdict === verdict);
    const rejection = latestOf("rejected");
    const approval = latestOf("approved");
    if (rejection && approval) {
      const rejectedFirst = String(rejection.at ?? "") <= String(approval.at ?? "");
      const [first, second] = rejectedFirst ? [rejection, approval] : [approval, rejection];
      return `${formatInstance(first)} — later ${formatInstance(second)}`;
    }
  }
  const chosen = groundingInstance(entry, stance);
  return chosen?.reason ? formatInstance(chosen) : "";
}
