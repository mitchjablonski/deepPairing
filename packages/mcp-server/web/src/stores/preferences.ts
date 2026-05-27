import { create } from "zustand";

type Theme = "dark" | "light" | "system";
// "auto" = fluid, viewport-scaled (the default; see the index.css clamp). The
// rest pin a fixed root size and override auto. "xxlarge"/"huge" lift the
// manual ceiling past the old 18px for large/high-DPI displays.
type FontSize = "auto" | "compact" | "default" | "large" | "xlarge" | "xxlarge" | "huge";

export const EDITOR_PRESETS: Record<string, { label: string; template: string }> = {
  vscode: { label: "VS Code", template: "vscode://file/{path}:{line}:{column}" },
  cursor: { label: "Cursor", template: "cursor://file/{path}:{line}:{column}" },
  windsurf: { label: "Windsurf", template: "windsurf://file/{path}:{line}:{column}" },
  zed: { label: "Zed", template: "zed://file/{path}:{line}:{column}" },
  jetbrains: { label: "JetBrains", template: "idea://open?file={path}&line={line}&column={column}" },
  sublime: { label: "Sublime Text", template: "subl://open?url=file://{path}&line={line}&column={column}" },
  none: { label: "None", template: "" },
};

interface PreferencesState {
  theme: Theme;
  fontSize: FontSize;
  contentWidth: "full" | "constrained";
  sidebarCollapsed: boolean;
  focusedPanel: "activity" | "artifact" | null;
  editorScheme: string;

  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  toggleContentWidth: () => void;
  toggleSidebar: () => void;
  setFocusedPanel: (panel: "activity" | "artifact" | null) => void;
  setEditorScheme: (scheme: string) => void;
  buildEditorLink: (filePath: string, line: number, column?: number) => string | null;
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem("dp-theme") as Theme) ?? "dark";
}

function getStoredEditor(): string {
  if (typeof window === "undefined") return "vscode";
  return localStorage.getItem("dp-editor") ?? "vscode";
}

function getStoredFontSize(): FontSize {
  if (typeof window === "undefined") return "auto";
  return (localStorage.getItem("dp-font-size") as FontSize) ?? "auto";
}

/** Safe localStorage wrappers so the store loads in non-browser contexts. */
function lsGet(key: string): string | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key: string, value: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try { localStorage.setItem(key, value); } catch {}
}

function applyFontSize(size: FontSize): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-font-size", size);
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;

  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;

  document.documentElement.setAttribute("data-theme", resolved);
}

export const usePreferencesStore = create<PreferencesState>((set, get) => {
  const initial = getStoredTheme();
  applyTheme(initial);
  const initialFontSize = getStoredFontSize();
  applyFontSize(initialFontSize);

  const editorKey = getStoredEditor();
  const editorScheme = EDITOR_PRESETS[editorKey]?.template ?? EDITOR_PRESETS.vscode.template;

  return {
    theme: initial,
    fontSize: initialFontSize,
    contentWidth: (lsGet("dp-content-width") as "full" | "constrained") ?? "full",
    sidebarCollapsed: false,
    focusedPanel: null,
    editorScheme,

    setTheme: (theme) => {
      lsSet("dp-theme", theme);
      applyTheme(theme);
      set({ theme });
    },

    setFontSize: (size) => {
      lsSet("dp-font-size", size);
      applyFontSize(size);
      set({ fontSize: size });
    },

    toggleContentWidth: () =>
      set((s) => {
        const next = s.contentWidth === "full" ? "constrained" : "full";
        lsSet("dp-content-width", next);
        return { contentWidth: next };
      }),

    toggleSidebar: () =>
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    setFocusedPanel: (panel) => set({ focusedPanel: panel }),

    setEditorScheme: (scheme) => {
      // Find the preset key or save as custom
      const preset = Object.entries(EDITOR_PRESETS).find(([_, v]) => v.template === scheme);
      lsSet("dp-editor", preset ? preset[0] : "custom");
      lsSet("dp-editor-template", scheme);
      set({ editorScheme: scheme });
    },

    buildEditorLink: (filePath, line, column = 1) => {
      const scheme = get().editorScheme;
      if (!scheme) return null;

      // Resolve relative paths against project root
      let absPath = filePath;
      if (!filePath.startsWith("/")) {
        try {
          const projectRoot = (window as any).__dpConnectionStore?.getState?.()?.projectRoot;
          if (projectRoot) {
            absPath = `${projectRoot}/${filePath}`;
          }
        } catch {}
      }

      return scheme
        .replace("{path}", absPath)
        .replace("{line}", String(line))
        .replace("{column}", String(column));
    },
  };
});
