import { create } from "zustand";

type Theme = "dark" | "light" | "system";

interface PreferencesState {
  theme: Theme;
  sidebarCollapsed: boolean;
  focusedPanel: "activity" | "artifact" | null;

  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setFocusedPanel: (panel: "activity" | "artifact" | null) => void;
}

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem("dp-theme") as Theme) ?? "dark";
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

export const usePreferencesStore = create<PreferencesState>((set) => {
  // Apply initial theme
  const initial = getStoredTheme();
  applyTheme(initial);

  return {
    theme: initial,
    sidebarCollapsed: false,
    focusedPanel: null,

    setTheme: (theme) => {
      localStorage.setItem("dp-theme", theme);
      applyTheme(theme);
      set({ theme });
    },

    toggleSidebar: () =>
      set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    setFocusedPanel: (panel) => set({ focusedPanel: panel }),
  };
});
