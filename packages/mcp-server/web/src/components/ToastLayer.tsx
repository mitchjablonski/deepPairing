import { useToastStore, type Toast } from "../stores/toast";

const kindStyles: Record<Toast["kind"], { bg: string; border: string; accent: string; icon: string }> = {
  info: {
    bg: "bg-accent-blue-dim/40",
    border: "border-accent-blue/30",
    accent: "text-accent-blue",
    icon: "ⓘ",
  },
  success: {
    bg: "bg-accent-green-dim/40",
    border: "border-accent-green/30",
    accent: "text-accent-green",
    icon: "✓",
  },
  block: {
    bg: "bg-accent-violet-dim/40",
    border: "border-accent-violet/30",
    accent: "text-accent-violet",
    // Memory symbol — the pre-flight moat in a glyph
    icon: "⛶",
  },
  error: {
    bg: "bg-accent-red-dim/40",
    border: "border-accent-red/30",
    accent: "text-accent-red",
    icon: "!",
  },
};

/**
 * Bottom-right toast stack. Renders above the MessageInput so ephemeral
 * notifications don't compete with the main artifact surface for attention.
 */
export function ToastLayer() {
  const { toasts, dismiss } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-[380px] w-[calc(100vw-2rem)]"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const style = kindStyles[t.kind];
        return (
          <div
            key={t.id}
            className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border shadow-lg backdrop-blur-sm animate-fade-in ${style.bg} ${style.border}`}
          >
            <span className={`text-sm font-semibold shrink-0 ${style.accent}`}>{style.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-text-primary">{t.title}</div>
              {t.body && (
                <div className="text-2xs text-text-secondary mt-0.5 whitespace-pre-wrap break-words">
                  {t.body}
                </div>
              )}
              {t.action && (
                <button
                  onClick={t.action.onClick}
                  className={`mt-1 text-2xs font-medium hover:underline ${style.accent}`}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="text-text-muted hover:text-text-primary text-xs px-1 shrink-0"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
