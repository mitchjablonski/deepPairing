import type { ReactElement } from "react";

/**
 * IV9 / L2 (#196) — the demo session's "next step" CTA, extracted (#430 PR 5) so
 * the same card renders as today's row (bar OFF) or inside the Next-up bar (ON,
 * dismissible there — the bar keeps it in its ⌄ view after a dismiss).
 */
export function DemoNextStep({ inBar = false, onDismiss }: {
  /** Unused since #471 (the demo's project is a throwaway sandbox, so a
   *  "--plugin-dir <projectRoot>/claude-plugin" hint pointed nowhere). */
  projectRoot?: string | null | undefined;
  inBar?: boolean;
  onDismiss?: () => void;
}): ReactElement {
  return (
    <div
      data-testid="demo-next-step"
      className={`px-3 py-2 bg-accent-blue-dim/30 ${inBar ? "rounded border border-accent-blue/20" : "border-b border-accent-blue/20"} text-2xs flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0`}
    >
      <span className="text-accent-blue font-medium">✓ Demo fired.</span>
      {/* #471 — say plainly that nothing here was a real agent. */}
      <span className="text-text-secondary">This was a scripted sample — no AI agent or model ran.</span>
      <span className="text-text-secondary">Next, a real review: install in Claude Code —</span>
      <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-primary font-mono">
        /plugin marketplace add https://github.com/mitchjablonski/deepPairing
      </code>
      <span className="text-text-muted">then</span>
      <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-primary font-mono">
        /plugin install deeppairing@deeppairing
      </code>
      <span className="text-text-muted">
        then open Claude Code in your own project and ask for real work.
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-text-muted hover:text-text-primary px-2 py-0.5 rounded hover:bg-surface-hover"
          aria-label="Dismiss demo next step"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
