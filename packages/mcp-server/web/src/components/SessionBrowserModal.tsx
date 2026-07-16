import { useModal } from "../hooks/useModal";
import { SessionBrowser } from "./SessionBrowser";

/**
 * H1 — replay's front door for CONNECTED tabs. SessionBrowser only mounted
 * inside IdleHome (rendered when !connected — where its own /api/sessions
 * fetch fails too), so the whole F9/F12 replay surface was reachable only
 * in edge windows. The palette opens this modal; useModal gives Escape,
 * focus trap, and overlay-store registration (shortcut suppression).
 */
export function SessionBrowserModal({ onClose }: { onClose: () => void }) {
  const { dialogProps } = useModal({ onClose });
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-16"
      onClick={onClose}
    >
      <div
        {...dialogProps}
        aria-label="Past sessions"
        className="w-full max-w-2xl max-h-[75vh] overflow-y-auto bg-surface-elevated border border-border-default rounded-lg p-4 focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-text-primary">Past sessions</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xs">
            Esc
          </button>
        </div>
        <SessionBrowser onPicked={onClose} />
      </div>
    </div>
  );
}
