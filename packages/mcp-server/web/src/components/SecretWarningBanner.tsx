import type { Artifact } from "@deeppairing/shared";

/**
 * #158 — the secret-warning CONSUMER. The server has scanned code changes and
 * findings for secret shapes since V4 (secret-scan.ts) but the resulting
 * `secret_warning` WS broadcast had NO consumer — and in daemon mode (the only
 * production wiring) the MCP-side broadcast is a no-op, so the promised
 * warning never rendered anywhere. The scan result is now persisted on the
 * artifact itself (`artifact.secretWarnings`), which this banner renders:
 * persisted ⇒ it survives reloads (hydration replays stored artifacts), and
 * the live `artifact_created` broadcast carries it for first paint.
 *
 * Design constraints:
 *  - role="alert": security-relevant, announce immediately (the decisions-view
 *    partial banner precedent uses role="status"; this warrants the stronger
 *    role).
 *  - Text + icon + color, never color-only (a11y).
 *  - Shows the secret KIND and pattern PREFIX only — the scanner deliberately
 *    never captures the matched value, so the banner cannot re-echo a secret
 *    into the DOM.
 *  - Not dismissable: the artifact card is where approve/reject happens, and
 *    an accidental dismiss would defeat the whole warning. It disappears only
 *    with the artifact (or a revision whose re-scan comes back clean).
 */
export function SecretWarningBanner({ artifact }: { artifact: Artifact }) {
  const warnings = artifact.secretWarnings;
  if (!warnings || warnings.length === 0) return null;

  // #160 — the scanner now records WHERE it matched (field path + 1-based
  // line, derived from the match index — never the value). Render it so the
  // human doesn't have to hunt: "in `after` (line 4)". Both parts optional:
  // warnings persisted before #160 have neither and still render as before.
  const kinds = warnings
    .map((w) => {
      const where =
        w.field && w.line ? ` in \`${w.field}\` (line ${w.line})`
        : w.field ? ` in \`${w.field}\``
        : w.line ? ` (line ${w.line})`
        : "";
      return `${w.label} (pattern “${w.pattern}…”)${where}`;
    })
    .join(", ");

  return (
    <div
      role="alert"
      data-testid="secret-warning-banner"
      className="flex items-start gap-2 px-3 py-2 rounded border border-accent-amber/40 bg-accent-amber-dim/50"
    >
      <span aria-hidden="true" className="text-accent-amber shrink-0 leading-5">
        ⚠
      </span>
      <div className="text-xs leading-5 min-w-0">
        <span className="font-semibold text-accent-amber">
          Possible secret detected in this artifact:
        </span>{" "}
        <span className="text-text-primary">{kinds}.</span>{" "}
        <span className="text-text-secondary">
          The flagged text is stored in <code className="text-2xs">.deeppairing/</code> session
          files and will appear in exports. Review it carefully before approving — if it is a
          real credential, rotate it.
        </span>
      </div>
    </div>
  );
}
