import { useState, useMemo, useRef, useEffect } from "react";
import { useArtifactStore } from "../stores/artifact";
import { usePreferencesStore } from "../stores/preferences";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { ArtifactIcon } from "./icons/ArtifactIcons";
import { fuzzyScore } from "../lib/fuzzy";

interface PaletteItem {
  id: string;
  label: string;
  description?: string;
  icon?: string; // artifact type or action icon
  type: "artifact" | "action";
  action: () => void;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);
  const { artifacts, selectArtifact, updateArtifactStatus } = useArtifactStore();
  const { theme, setTheme, toggleSidebar } = usePreferencesStore();

  // Build searchable items
  const allItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // Actions
    items.push({
      id: "action_approve_all",
      label: "Approve all draft artifacts",
      type: "action",
      action: () => {
        const drafts = artifacts.filter((a) => a.status === "draft");
        for (const a of drafts) updateArtifactStatus(a.id, "approved");
        onClose();
      },
    });
    items.push({
      id: "action_toggle_theme",
      label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
      type: "action",
      action: () => { setTheme(theme === "dark" ? "light" : "dark"); onClose(); },
    });
    items.push({
      id: "action_toggle_sidebar",
      label: "Toggle sidebar",
      type: "action",
      action: () => { toggleSidebar(); onClose(); },
    });

    // Artifacts
    for (const a of artifacts) {
      if (a.status === "superseded") continue;
      items.push({
        id: a.id,
        label: a.title,
        description: `${a.type} · ${a.status}`,
        icon: a.type,
        type: "artifact",
        action: () => { selectArtifact(a.id); onClose(); },
      });
    }

    return items;
  }, [artifacts, theme]);

  // Filter and sort by fuzzy score
  const results = useMemo(() => {
    if (!query.trim()) return allItems.slice(0, 10);

    return allItems
      .map((item) => ({
        item,
        score: Math.max(fuzzyScore(query, item.label), fuzzyScore(query, item.description ?? "")),
      }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.item);
  }, [query, allItems]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[selectedIndex]?.action();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Palette */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="fixed top-[20%] left-1/2 -translate-x-1/2 z-50 w-[500px] max-w-[90vw]
                      bg-surface-elevated border border-border-default rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Search input */}
        <div className="px-4 py-3 border-b border-border-default">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search artifacts, actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent text-sm text-text-primary placeholder-text-muted
                       focus:outline-none"
          />
        </div>

        {/* Results */}
        <div className="max-h-[300px] overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-xs text-text-muted">No results</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.id}
                onClick={item.action}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                  i === selectedIndex
                    ? "bg-accent-blue-dim/40 text-accent-blue"
                    : "text-text-secondary hover:bg-surface-hover"
                }`}
              >
                {item.type === "artifact" && item.icon ? (
                  <ArtifactIcon type={item.icon} className="w-4 h-4 shrink-0" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="shrink-0 opacity-50">
                    <path d="M6 3l5 5-5 5" />
                  </svg>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{item.label}</div>
                  {item.description && (
                    <div className="text-2xs text-text-muted truncate">{item.description}</div>
                  )}
                </div>
                {i === selectedIndex && (
                  <span className="text-2xs text-text-muted shrink-0">Enter</span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border-subtle flex items-center gap-3 text-2xs text-text-muted">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">Enter</kbd> select</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
        </div>
      </div>
    </>
  );
}
