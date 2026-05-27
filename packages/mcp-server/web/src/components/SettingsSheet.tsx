import { useEffect, useRef } from "react";
import { usePreferencesStore } from "../stores/preferences";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { EditorPicker } from "./OpenInEditor";
import { ExportMenu } from "./ExportMenu";
import { SessionMetrics } from "./SessionMetrics";

/**
 * Settings sheet — slide-in panel that hosts all the low-frequency chrome
 * (theme, font size, content width, editor picker, export menu) that used
 * to clutter the always-visible header.
 *
 * Invoked with Cmd/Ctrl+, or the ⚙ button in the header.
 */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { theme, setTheme, fontSize, setFontSize, contentWidth, toggleContentWidth } = usePreferencesStore();
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, true);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className="fixed top-0 right-0 bottom-0 z-50 w-[380px] max-w-[90vw]
                   bg-surface-elevated border-l border-border-default shadow-2xl
                   overflow-y-auto focus:outline-none"
      >
        <div className="sticky top-0 flex items-center justify-between px-5 py-3 border-b border-border-default bg-surface-elevated">
          <h2 className="text-sm font-bold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-2xs"
            title="Close (Esc)"
          >
            Esc
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Theme */}
          <section>
            <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Theme
            </div>
            <div className="flex gap-1.5">
              {(["dark", "light", "system"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    theme === t
                      ? "bg-accent-blue-dim text-accent-blue border border-accent-blue/30"
                      : "bg-surface-secondary text-text-secondary border border-border-default hover:bg-surface-hover"
                  }`}
                >
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </section>

          {/* Font size */}
          <section>
            <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Font size
            </div>
            {/* Auto (fluid) — the default; the root size scales with the
                window/screen so large & high-DPI displays get bigger text. */}
            <button
              onClick={() => setFontSize("auto")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-xs mb-1.5 border transition-colors ${
                fontSize === "auto"
                  ? "bg-accent-blue-dim text-accent-blue border-accent-blue/30"
                  : "bg-surface-secondary text-text-secondary border-border-default hover:bg-surface-hover"
              }`}
            >
              <span className="font-medium">Auto</span>
              <span className="text-2xs opacity-70">scales with your screen</span>
            </button>
            {/* Fixed sizes — pin a root px, overriding Auto. Labels are the
                real root px so the choice is unambiguous on any display. */}
            <div className="flex flex-wrap items-end gap-1 bg-surface-secondary rounded p-1 border border-border-default">
              {([["compact", 11, "12"], ["default", 12, "14"], ["large", 13, "16"], ["xlarge", 15, "18"], ["xxlarge", 17, "20"], ["huge", 19, "24"]] as const).map(
                ([size, previewPx, label]) => (
                  <button
                    key={size}
                    onClick={() => setFontSize(size)}
                    title={`${label}px`}
                    className={`flex-1 min-w-[44px] flex flex-col items-center gap-0.5 px-1 py-1.5 rounded transition-colors ${
                      fontSize === size
                        ? "bg-surface-hover text-text-primary"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    <span style={{ fontSize: previewPx, lineHeight: 1 }}>A</span>
                    <span className="text-2xs opacity-70">{label}</span>
                  </button>
                ),
              )}
            </div>
          </section>

          {/* Content width */}
          <section>
            <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Content width
            </div>
            <button
              onClick={toggleContentWidth}
              className="w-full flex items-center justify-between px-3 py-2 rounded bg-surface-secondary border border-border-default hover:bg-surface-hover transition-colors text-xs text-text-secondary"
            >
              <span>{contentWidth === "full" ? "Full width" : "Constrained (max-w-4xl)"}</span>
              <span className="text-2xs text-text-muted">click to toggle</span>
            </button>
          </section>

          {/* Editor */}
          <section>
            <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              External editor
            </div>
            <div className="text-2xs text-text-muted mb-2">
              Clicking evidence line numbers opens your editor at the file:line.
            </div>
            <EditorPicker />
          </section>

          {/* Export */}
          <section>
            <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Export session
            </div>
            <div className="text-2xs text-text-muted mb-2">
              Download the current session as markdown (full, PR description, or ADR).
            </div>
            <ExportMenu />
          </section>

          {/* O3: session metrics — moved out of the always-on footer so the
              chrome reads as "pair surface" not "audit dashboard." Here on
              demand for anyone who wants to see the numbers. */}
          <section>
            <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Session metrics
            </div>
            <SessionMetrics />
          </section>
        </div>
      </div>
    </>
  );
}
