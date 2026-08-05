import type { Comment } from "@deeppairing/shared";

/**
 * H1 (#202) — the "open negotiation" summary that the approve gate reads.
 *
 * A suggested edit the human posted is "open" while it is `pending` (the agent
 * owes a response) or `countered` (the agent proposed an alternative and it is
 * the human's turn). Approving the artifact while either sits unresolved
 * silently abandons the human's own proposal — the asymmetry with
 * `withdraw_artifact` (which refuses to dodge human comments) the round-4 UX
 * lens flagged. This module is the ONE place that decides what "open" means, so
 * the changeset gate, the code_change gate, and the per-file confirm all agree.
 */

/** The open (`pending`/`countered`) suggestion states — anything else is settled. */
const OPEN_STATES = new Set(["pending", "countered"]);

export interface OpenSuggestionFileCount {
  pending: number;
  countered: number;
  total: number;
}

export interface OpenSuggestionsSummary {
  /** pending + countered across every file. */
  total: number;
  pending: number;
  countered: number;
  /** Distinct file paths carrying an open suggestion, in first-seen order. */
  files: string[];
  /** Per-file open-suggestion counts keyed by `target.filePath`. */
  byFile: Record<string, OpenSuggestionFileCount>;
}

export function summarizeOpenSuggestions(comments: Comment[]): OpenSuggestionsSummary {
  let pending = 0;
  let countered = 0;
  const files: string[] = [];
  const byFile: Record<string, OpenSuggestionFileCount> = {};
  for (const c of comments) {
    const s = c.suggestion;
    if (!s || !OPEN_STATES.has(s.state)) continue;
    if (s.state === "pending") pending++;
    else countered++;
    const fp = c.target?.filePath;
    if (fp) {
      if (!byFile[fp]) {
        byFile[fp] = { pending: 0, countered: 0, total: 0 };
        files.push(fp);
      }
      if (s.state === "pending") byFile[fp].pending++;
      else byFile[fp].countered++;
      byFile[fp].total++;
    }
  }
  return { total: pending + countered, pending, countered, files, byFile };
}

/** "1 pending, 1 countered" — names the open states for the confirm copy. */
export function describeOpenStates(s: { pending: number; countered: number }): string {
  const parts: string[] = [];
  if (s.pending > 0) parts.push(`${s.pending} pending`);
  if (s.countered > 0) parts.push(`${s.countered} countered`);
  return parts.join(", ");
}

/**
 * The one-line inline confirm copy: names the count AND the states so the human
 * knows exactly what approving abandons. Callers list the affected files
 * separately (so file-by-file mode can't hide them — UX M1).
 */
export function openSuggestionsConfirmLabel(s: OpenSuggestionsSummary): string {
  const verb = s.total === 1 ? "is" : "are";
  return `${s.total} of your suggestions ${verb} still open (${describeOpenStates(s)}) — approve anyway?`;
}
