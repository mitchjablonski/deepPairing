import { create } from "zustand";

type Theme = "dark" | "light" | "system";
type FontSize = "compact" | "default" | "large" | "xlarge";

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
  if (typeof window === "undefined") return "default";
  return (localStorage.getItem("dp-font-size") as FontSize) ?? "default";
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
    contentWidth: (localStorage.getItem("dp-content-width") as "full" | "constrained") ?? "full",
    sidebarCollapsed: false,
    focusedPanel: null,
    editorScheme,

    setTheme: (theme) => {
      localStorage.setItem("dp-theme", theme);
      applyTheme(theme);
      set({ theme });
    },

    setFontSize: (size) => {
      localStorage.setItem("dp-font-size", size);
      applyFontSize(size);
      set({ fontSize: size });
    },

    toggleContentWidth: () =>
      set((s) => {
        const next = s.contentWidth === "full" ? "constrained" : "full";
        localStorage.setItem("dp-content-width", next);
        return { contentWidth: next };
      }),

    toggleSidebar: () =>
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    setFocusedPanel: (panel) => set({ focusedPanel: panel }),

    setEditorScheme: (scheme) => {
      // Find the preset key or save as custom
      const preset = Object.entries(EDITOR_PRESETS).find(([_, v]) => v.template === scheme);
      localStorage.setItem("dp-editor", preset ? preset[0] : "custom");
      localStorage.setItem("dp-editor-template", scheme);
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
