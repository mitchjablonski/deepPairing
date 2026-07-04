import { useState, useMemo, useRef, useEffect } from "react";
import { useArtifactStore } from "../stores/artifact";
import { useConnectionStore } from "../stores/connection";
import { usePreferencesStore } from "../stores/preferences";
import { useModal } from "../hooks/useModal";
import { ArtifactIcon } from "./icons/ArtifactIcons";
import { fuzzyScore } from "../lib/fuzzy";

/** Recursively collect string VALUES from artifact content (keys excluded). */
function collectStrings(v: unknown, out: string[] = []): string {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out.join(" ").replace(/\s+/g, " ");
}

interface PaletteItem {
  /** E3 (L3) — flattened artifact content, lowercase, capped; substring-searched. */
  searchText?: string;
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
  const { dialogProps } = useModal({ onClose });
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);
  const theme = usePreferencesStore((s) => s.theme);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const toggleSidebar = usePreferencesStore((s) => s.toggleSidebar);

  // Build searchable items
  const boundSessionId = useConnectionStore((st) => st.sessionId);
  const allItems = useMemo((): PaletteItem[] => {
    const items: PaletteItem[] = [];

    // Actions
    // F9 (L7) — the merged store carries OTHER sessions' drafts: a blanket
    // approve-all silently reviewed work the user may never have looked at
    // (and F6's owner routing means those writes now LAND). Scope to the
    // bound session when one is bound; the label discloses the scope + count.
    const approvableDrafts = artifacts.filter(
      (a) =>
        a.status === "draft" &&
        a.type !== "decision" &&
        (!boundSessionId || a.sessionId === boundSessionId),
    );
    const draftSessionCount = new Set(approvableDrafts.map((a) => a.sessionId)).size;
    items.push({
      id: "action_approve_all",
      label: `Approve all ${approvableDrafts.length} draft artifact${approvableDrafts.length === 1 ? "" : "s"}${boundSessionId ? " in this session" : !boundSessionId && draftSessionCount > 1 ? ` across ${draftSessionCount} sessions` : ""} (except decisions)`,
      type: "action",
      // F2 — decisions are intentionally EXCLUDED: a blanket "approved" flip
      // records no optionId, so the agent never learns which option was picked
      // (and resolveDecision never runs). They must be resolved individually via
      // the decision card. Await sequentially so a flaky daemon surfaces one
      // error toast, not N parallel ones, and a mid-batch failure stops cleanly.
      action: async () => {
        for (const a of approvableDrafts) {
          try {
            await updateArtifactStatus(a.id, "approved");
          } catch {
            break; // store already toasted; don't fire a cascade of failures
          }
        }
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
      // E3 (L3) — content is searchable, not just title/type: at 15+
      // artifacts "where did we discuss the retry policy?" needs an answer.
      // Review — string VALUES only: JSON.stringify put schema KEYS in the
      // haystack, so queries like 'status'/'steps'/'evidence' matched every
      // artifact structurally. 50KB cap (was a silent 2KB truncation that
      // failed exactly on the big artifacts where search matters most).
      const contentText = collectStrings(a.content).slice(0, 50_000).toLowerCase();
      items.push({
        id: a.id,
        label: a.title,
        description: `${a.type} · ${a.status}`,
        searchText: contentText,
        icon: a.type,
        type: "artifact",
        action: () => { selectArtifact(a.id); onClose(); },
      });
    }

    return items;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- zustand actions are stable identities; listing them would re-mint the palette items per render for nothing
  }, [artifacts, theme, boundSessionId]);

  // Filter and sort by fuzzy score
  const results = useMemo(() => {
    if (!query.trim()) return allItems.slice(0, 10);

    return allItems
      .map((item) => ({
        item,
        score: Math.max(
          fuzzyScore(query, item.label),
          fuzzyScore(query, item.description ?? ""),
          // Content: exact-substring only (fuzzy over a 2000-char haystack
          // matches everything); scored below title hits so titles rank first.
          item.searchText?.includes(query.trim().toLowerCase()) ? 1 : -1,
        ),
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
    }
    // Escape is handled by useModal's dialogProps.onKeyDown on the panel (the
    // input's keydown bubbles to it) — no branch here, or it'd double-close.
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Palette */}
      <div
        {...dialogProps}
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
