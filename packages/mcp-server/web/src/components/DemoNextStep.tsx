import type { ReactElement } from "react";

/**
 * IV9 / L2 (#196) — the demo session's "next step" CTA, extracted (#430 PR 5) so
 * the same card renders as today's row (bar OFF) or inside the Next-up bar (ON,
 * dismissible there — the bar keeps it in its ⌄ view after a dismiss).
 */
export function DemoNextStep({ projectRoot, inBar = false, onDismiss }: {
  projectRoot: string | null | undefined;
  inBar?: boolean;
  onDismiss?: () => void;
}): ReactElement {
  return (
    <div
      data-testid="demo-next-step"
      className={`px-3 py-2 bg-accent-blue-dim/30 ${inBar ? "rounded border border-accent-blue/20" : "border-b border-accent-blue/20"} text-2xs flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0`}
    >
      <span className="text-accent-blue font-medium">✓ Demo fired.</span>
      <span className="text-text-secondary">Next: install in Claude Code —</span>
      <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-primary font-mono">
        /plugin marketplace add https://github.com/mitchjablonski/deepPairing
      </code>
      <span className="text-text-muted">then</span>
      <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-primary font-mono">
        /plugin install deeppairing@deeppairing
      </code>
      <span className="text-text-muted">
        or from a clone:{" "}
        <code className="bg-surface-elevated px-1.5 py-0.5 rounded text-text-secondary font-mono">
          claude --plugin-dir {(projectRoot ?? "/path/to/deeppairing")}/claude-plugin
        </code>
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
