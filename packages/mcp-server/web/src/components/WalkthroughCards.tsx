import { ArtifactIcon } from "./icons/ArtifactIcons";

/**
 * Q2 — the three primitives a new deepPairing user needs to recognize. Used
 * by:
 *   - `FirstRunWalkthrough` in ArtifactPanel (edge case: filter emptied the
 *     panel during a live session)
 *   - `WaitingForClaude`'s optional "What is this?" expand section — the
 *     recovery path for users who declined the post-init demo.
 *
 * Kept intentionally content-only: no dismiss, no state. The container
 * decides whether and how to show it.
 */
export function WalkthroughCards({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`grid grid-cols-1 ${compact ? "" : "min-[900px]:grid-cols-3"} gap-2.5`}>
      <div className="p-3 bg-accent-violet-dim/20 border border-accent-violet/20 rounded-lg">
        <div className="text-2xs font-semibold text-accent-violet mb-1">① Watch it think</div>
        <p className="text-2xs text-text-secondary leading-relaxed">
          Every reasoning step names the pattern at play — "dependency inversion", "optimistic UI". You learn the vocabulary, not just the fix.
        </p>
      </div>
      <div className="p-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg">
        <div className="text-2xs font-semibold text-accent-blue mb-1">② Ask why, anywhere</div>
        <p className="text-2xs text-text-secondary leading-relaxed">
          The violet <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded bg-accent-violet-dim text-accent-violet text-[9px] font-bold">?</span> on any finding, step, or line opens a scoped question. The agent answers inline.
        </p>
      </div>
      <div className="p-3 bg-accent-green-dim/20 border border-accent-green/20 rounded-lg">
        <div className="text-2xs font-semibold text-accent-green mb-1">③ Memory that works for you</div>
        <p className="text-2xs text-text-secondary leading-relaxed">
          Reject something once (with a reason). Next session, the agent can't re-propose it — by name or by the underlying pattern.
        </p>
      </div>
    </div>
  );
}

export function FirstRunWalkthrough() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 gap-4 overflow-y-auto">
      <div className="w-12 h-12 rounded-full bg-accent-violet-dim flex items-center justify-center shrink-0">
        <ArtifactIcon type="reasoning" className="w-6 h-6 text-accent-violet" />
      </div>
      <div className="text-center max-w-md">
        <p className="text-sm font-semibold text-text-primary">Waiting for your agent's first move</p>
        <p className="text-2xs text-text-muted mt-1">Ask Claude Code anything in your terminal. Artifacts land here as it works.</p>
      </div>

      <div className="w-full max-w-2xl mt-2">
        <WalkthroughCards />
      </div>

      <div className="text-2xs text-text-muted mt-2 flex items-center gap-1.5">
        <kbd className="font-mono bg-surface-elevated px-1.5 py-0.5 rounded text-[9px]">⌘K</kbd>
        command palette
        <span className="opacity-40">·</span>
        <kbd className="font-mono bg-surface-elevated px-1.5 py-0.5 rounded text-[9px]">?</kbd>
        shortcuts
      </div>
    </div>
  );
}
