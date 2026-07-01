import { useModal } from "../hooks/useModal";

const shortcuts = [
  { keys: "⌘K", description: "Command palette" },
  { keys: "⌘,", description: "Settings sheet" },
  { keys: "j / k", description: "Navigate artifacts" },
  { keys: "a", description: "Arm approve (3s confirm countdown)" },
  { keys: "r", description: "Focus revision textarea" },
  { keys: "q", description: "Ask the agent about this artifact" },
  { keys: "⌘⏎", description: "Submit approve (from textarea)" },
  { keys: "Escape", description: "Cancel countdown / close overlay" },
  { keys: "?", description: "Toggle this help" },
];

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
      </div>
    </div>
  );
}
