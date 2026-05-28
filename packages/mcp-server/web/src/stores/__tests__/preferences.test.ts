import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePreferencesStore, EDITOR_PRESETS, SIDEBAR_WIDTHS } from "../preferences";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferences store — buildEditorLink", () => {
  beforeEach(() => {
    // Fresh store state
    usePreferencesStore.setState({
      editorScheme: EDITOR_PRESETS.vscode.template,
    });
  });

  it("returns null when the editor scheme is empty (None preset)", () => {
    usePreferencesStore.setState({ editorScheme: "" });
    const link = usePreferencesStore.getState().buildEditorLink("src/a.ts", 10);
    expect(link).toBeNull();
  });

  it("passes absolute paths through unchanged", () => {
    const link = usePreferencesStore.getState().buildEditorLink(
      "/home/mitch/src/a.ts",
      42,
      5,
    );
    expect(link).toBe("vscode://file//home/mitch/src/a.ts:42:5");
  });

  it("resolves relative paths against projectRoot on the connection store", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ projectRoot: "/home/mitch/project" }),
      },
    });
    const link = usePreferencesStore.getState().buildEditorLink("src/a.ts", 10);
    expect(link).toBe("vscode://file//home/mitch/project/src/a.ts:10:1");
  });

  it("leaves relative paths as-is when no projectRoot is available", () => {
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ projectRoot: null }),
      },
    });
    const link = usePreferencesStore.getState().buildEditorLink("src/a.ts", 10);
    expect(link).toBe("vscode://file/src/a.ts:10:1");
  });

  it("uses the configured editor scheme (Cursor)", () => {
    usePreferencesStore.setState({ editorScheme: EDITOR_PRESETS.cursor.template });
    const link = usePreferencesStore.getState().buildEditorLink(
      "/abs/src/a.ts",
      10,
      3,
    );
    expect(link).toBe("cursor://file//abs/src/a.ts:10:3");
  });

  it("JetBrains scheme uses query-string style", () => {
    usePreferencesStore.setState({ editorScheme: EDITOR_PRESETS.jetbrains.template });
    const link = usePreferencesStore.getState().buildEditorLink(
      "/abs/src/a.ts",
      10,
      3,
    );
    expect(link).toBe("idea://open?file=/abs/src/a.ts&line=10&column=3");
  });

  it("defaults column to 1 when omitted", () => {
    const link = usePreferencesStore.getState().buildEditorLink("/abs/a.ts", 42);
    expect(link).toBe("vscode://file//abs/a.ts:42:1");
  });
});

describe("preferences store — simple setters", () => {
  it("setTheme updates state", () => {
    usePreferencesStore.getState().setTheme("light");
    expect(usePreferencesStore.getState().theme).toBe("light");
  });

  it("setFontSize updates state", () => {
    usePreferencesStore.getState().setFontSize("large");
    expect(usePreferencesStore.getState().fontSize).toBe("large");
  });

  it("setFontSize accepts 'auto' (fluid default) and the larger presets", () => {
    for (const size of ["auto", "xxlarge", "huge"] as const) {
      usePreferencesStore.getState().setFontSize(size);
      expect(usePreferencesStore.getState().fontSize).toBe(size);
    }
  });

  it("setSidebarWidth updates state; presets ascend compact→xwide", () => {
    usePreferencesStore.getState().setSidebarWidth("wide");
    expect(usePreferencesStore.getState().sidebarWidth).toBe("wide");
    expect(SIDEBAR_WIDTHS.compact).toBeLessThan(SIDEBAR_WIDTHS.default);
    expect(SIDEBAR_WIDTHS.default).toBeLessThan(SIDEBAR_WIDTHS.wide);
    expect(SIDEBAR_WIDTHS.wide).toBeLessThan(SIDEBAR_WIDTHS.xwide);
  });

  it("toggleContentWidth flips full <-> constrained", () => {
    usePreferencesStore.setState({ contentWidth: "full" });
    usePreferencesStore.getState().toggleContentWidth();
    expect(usePreferencesStore.getState().contentWidth).toBe("constrained");
    usePreferencesStore.getState().toggleContentWidth();
    expect(usePreferencesStore.getState().contentWidth).toBe("full");
  });

  it("toggleSidebar toggles collapsed state", () => {
    usePreferencesStore.setState({ sidebarCollapsed: false });
    usePreferencesStore.getState().toggleSidebar();
    expect(usePreferencesStore.getState().sidebarCollapsed).toBe(true);
  });
});
