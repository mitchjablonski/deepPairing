import { create } from "zustand";

type Theme = "dark" | "light" | "system";

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
  sidebarCollapsed: boolean;
  focusedPanel: "activity" | "artifact" | null;
  editorScheme: string;

  setTheme: (theme: Theme) => void;
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

  const editorKey = getStoredEditor();
  const editorScheme = EDITOR_PRESETS[editorKey]?.template ?? EDITOR_PRESETS.vscode.template;

  return {
    theme: initial,
    sidebarCollapsed: false,
    focusedPanel: null,
    editorScheme,

    setTheme: (theme) => {
      localStorage.setItem("dp-theme", theme);
      applyTheme(theme);
      set({ theme });
    },

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
      return scheme
        .replace("{path}", filePath)
        .replace("{line}", String(line))
        .replace("{column}", String(column));
    },
  };
});
