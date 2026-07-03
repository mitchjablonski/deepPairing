import { useState } from "react";
import { useModal } from "../hooks/useModal";

interface QuickAskModalProps {
  artifactTitle: string;
  onSubmit: (question: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * U3 — themed "ask the agent about this artifact" composer for the global `q`
 * shortcut. Replaces window.prompt, which is a no-op inside the VS Code webview
 * that embeds this UI (and a jarring native dialog everywhere else). Keyboard-
 * first: autofocused textarea, ⌘/Ctrl+Enter or the button submits, Esc cancels.
 */
export function QuickAskModal({ artifactTitle, onSubmit, onClose }: QuickAskModalProps) {
  const [text, setText] = useState("");
  const { dialogProps } = useModal({ onClose });

  const submit = async () => {
    const q = text.trim();
    if (!q) return;
    try {
      // only close on success — on a failed send the store toasts + re-throws,
      // so we keep the composer open with the typed question for retry.
      await onSubmit(q);
      onClose();
    } catch {
      /* store surfaced the error toast; leave the question intact */
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 pt-[15vh] px-4"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label={`Ask the agent about ${artifactTitle}`}
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-primary rounded-lg shadow-xl w-full max-w-lg p-4"
      >
        <div className="text-xs text-text-muted mb-2">
          Ask the agent about <span className="font-medium text-text-primary">{artifactTitle}</span>
        </div>
        <textarea
          // no autoFocus — useFocusTrap focuses this (first focusable) AND
          // captures the trigger first, so focus returns to the artifact card on
          // close. autoFocus commits before the trap's passive effect, stealing
          // that capture (focus would drop to <body> on close).
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Your question… (⌘⏎ to send, Esc to cancel)"
          className="w-full px-2.5 py-2 bg-surface-secondary border border-border-default rounded text-sm text-text-primary
                     placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent-violet resize-none"
        />
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="px-3 py-1.5 bg-accent-violet-strong text-white text-xs font-medium rounded
                       hover:bg-accent-violet-strong/80 disabled:bg-surface-elevated disabled:text-text-muted transition-colors"
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
