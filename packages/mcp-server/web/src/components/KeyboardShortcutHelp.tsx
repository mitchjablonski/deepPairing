import { useModal } from "../hooks/useModal";
import { CHANGESET_KEYMAP } from "../lib/changesetKeymap";

const shortcuts = [
  { keys: "⌘K", description: "Command palette" },
  { keys: "⌘,", description: "Settings sheet" },
  { keys: "j / k", description: "Navigate artifacts" },
  { keys: "n", description: "Jump to the next artifact waiting on you" },
  { keys: "a", description: "Arm approve (3s confirm countdown)" },
  { keys: "r", description: "Focus revision textarea" },
  { keys: "q", description: "Ask the agent about this artifact" },
  { keys: "⌘⏎", description: "Respond with note · empty = approve (from review textarea)" },
  { keys: "Escape", description: "Cancel countdown / close overlay / exit replay" },
  { keys: "?", description: "Toggle this help" },
];

// #175 — the changeset review keys render straight from the ONE central keymap,
// so the cheat-sheet can never drift from the live bindings.
const changesetShortcuts = CHANGESET_KEYMAP.map((b) => ({ keys: b.glyph, description: b.description }));

export function KeyboardShortcutHelp({ onClose }: { onClose: () => void }) {
  const { dialogProps } = useModal({ onClose });
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="Keyboard shortcuts"
        className="bg-surface-elevated border border-border-default rounded-xl shadow-2xl p-6 max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-text-primary">Keyboard Shortcuts</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xs">Esc</button>
        </div>
        <div className="space-y-2">
          {shortcuts.map((s) => (
            <div key={s.keys} className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">{s.description}</span>
              <kbd className="px-2 py-0.5 bg-surface-primary border border-border-default rounded text-2xs font-mono text-text-muted">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>

        {/* #175 — changeset review keys (live only while a changeset is focused). */}
        <div className="mt-4 pt-3 border-t border-border-subtle">
          <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-muted mb-2">Changeset review</h3>
          <div className="space-y-2">
            {changesetShortcuts.map((s) => (
              <div key={s.keys} className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">{s.description}</span>
                <kbd className="px-2 py-0.5 bg-surface-primary border border-border-default rounded text-2xs font-mono text-text-muted">
                  {s.keys}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
