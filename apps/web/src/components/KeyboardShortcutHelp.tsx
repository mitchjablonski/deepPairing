interface ShortcutHelpProps {
  onClose: () => void;
}

const shortcuts = [
  { keys: "⌘ B", description: "Toggle sidebar" },
  { keys: "⌘ /", description: "Show this help" },
  { keys: "Escape", description: "Close panel / cancel" },
  { keys: "↑ ↓", description: "Navigate decision options" },
  { keys: "Enter", description: "Select / submit" },
  { keys: "+ on code", description: "Comment on a line" },
];

export function KeyboardShortcutHelp({ onClose }: ShortcutHelpProps) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated border border-border-default rounded-xl shadow-2xl p-6 max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-text-primary">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors text-xs"
          >
            Esc
          </button>
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

        <div className="mt-4 pt-3 border-t border-border-default">
          <p className="text-2xs text-text-muted">
            More shortcuts coming soon. Use ⌘ on Mac, Ctrl on Windows/Linux.
          </p>
        </div>
      </div>
    </div>
  );
}
