import { useModal } from "../hooks/useModal";
import { useReloadConfirmStore, reloadNow } from "../lib/connectionGrace";

/**
 * #487 review (Fable) — the confirm before a Reload that would discard unsent
 * text. Keep is the FIRST focusable (useFocusTrap focuses it, so Enter keeps),
 * Esc keeps, and only an explicit "Reload anyway" discards.
 */
export function ReloadConfirmDialog() {
  const open = useReloadConfirmStore((s) => s.open);
  const close = () => useReloadConfirmStore.setState({ open: false });
  const { dialogProps } = useModal({ active: open, onClose: close });
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 pt-[15vh] px-4" onClick={close}>
      <div
        {...dialogProps}
        aria-label="Reload and discard unsent text?"
        data-testid="reload-confirm"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-primary rounded-lg shadow-xl w-full max-w-sm p-4 space-y-3"
      >
        <p className="text-xs text-text-primary">
          You have unsent text in this tab. Reloading discards it.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="px-3 py-1.5 bg-accent-blue-strong text-white text-xs font-medium rounded"
          >
            Keep my text
          </button>
          <button
            type="button"
            onClick={() => { close(); reloadNow(); }}
            className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary"
          >
            Reload anyway
          </button>
        </div>
      </div>
    </div>
  );
}
