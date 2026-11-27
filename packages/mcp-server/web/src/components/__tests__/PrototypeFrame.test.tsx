import { describe, it, expect } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrototypeFrame, type FrameAnnotation } from "../PrototypeFrame";
import { sanitizePageHtml } from "../../lib/pageSanitize";
import { PAGE_MERMAID_PREPARE, renderPageMermaid, type MermaidRenderer } from "../../lib/pageMermaid";
import { usePreferencesStore } from "../../stores/preferences";

describe("PrototypeFrame", () => {
  it("is click-to-run: no iframe until the user opts in", () => {
    render(<PrototypeFrame html="<button onclick='alert(1)'>go</button>" />);
    // Banner + run gate, but nothing executing yet.
    expect(screen.getByText(/sandboxed . no network/i)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
  });

  it("on Run, mounts a hardened sandbox: opaque origin + CSP, agent html only inside srcdoc", async () => {
    render(<PrototypeFrame html="<h1>hello prototype</h1>" />);
    await userEvent.click(screen.getByRole("button", { name: /run prototype/i }));
    const iframe = document.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    // allow-scripts WITHOUT allow-same-origin → opaque origin, no parent access.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    const srcdoc = iframe.getAttribute("srcdoc") ?? "";
    // CSP injected + no network egress, and the agent html is contained in srcdoc.
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("<h1>hello prototype</h1>");
    // The agent html is NOT rendered into the parent document.
    expect(screen.queryByText("hello prototype")).not.toBeInTheDocument();
  });

  it("staticPreview renders the static placeholder, NOT a Run affordance", () => {
    // staticPreview is used inside a revision diff, where running a live frame
    // side-by-side would be pointless. It is SEPARATE from comment-anchoring.
    render(<PrototypeFrame html="<button>go</button>" staticPreview />);
    expect(screen.getByText(/open the live version to run it/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run prototype/i })).not.toBeInTheDocument();
  });

  it("WITHOUT staticPreview it is runnable — the Run affordance, not the placeholder", () => {
    render(<PrototypeFrame html="<button>go</button>" />);
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
    expect(screen.queryByText(/open the live version to run it/i)).not.toBeInTheDocument();
  });

  it("refuses to render a prototype over the size cap", () => {
    const huge = "<div>" + "x".repeat(520 * 1024) + "</div>";
    render(<PrototypeFrame html={huge} />);
    expect(screen.getByText(/too large to render safely/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run prototype/i })).not.toBeInTheDocument();
  });

  it("maxBytes overrides the default cap (#680 pages use 2 MB)", () => {
    const html = "<div>" + "x".repeat(520 * 1024) + "</div>";
    render(<PrototypeFrame html={html} maxBytes={2 * 1024 * 1024} />);
    expect(screen.queryByText(/too large to render safely/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
  });

  it("staticFirst renders a script-less sandboxed frame before Run (#680)", async () => {
    render(<PrototypeFrame html="<p>hi</p><script>1</script>" staticFirst noun="page" />);
    const iframe = document.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox")).toBe("");
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    expect(document.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts");
  });

  // #714 gap 11 — the page's Mermaid blocks are rendered parent-side (a fake
  // renderer here: happy-dom has no layout) before the srcdoc is built.
  describe("Mermaid prepare pass", () => {
    const fakeRenderer = (themes: string[]): MermaidRenderer => async (id, _src, theme) => {
      themes.push(theme);
      return `<svg id="${id}" onload="alert(1)"><g class="node default" id="${id}-flowchart-A-0"><text><tspan>A</tspan></text></g></svg>`;
    };
    function annotationWith(themes: string[], gate?: Promise<void>): FrameAnnotation {
      return {
        script: "/*annotator*/",
        sanitize: sanitizePageHtml,
        prepare: {
          needed: (h) => h.includes("mermaid"),
          run: async (h, theme) => {
            await gate;
            return (await renderPageMermaid(h, { theme, renderer: fakeRenderer(themes) })).html;
          },
        },
      };
    }
    const PAGE = '<h1>Flow</h1><pre class="mermaid">flowchart LR\n  A[A]</pre><script>1</script>';

    it("shows a placeholder, then frames the rendered, sanitized SVG before and after Run", async () => {
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const themes: string[] = [];
      render(<PrototypeFrame html={PAGE} staticFirst noun="page" annotation={annotationWith(themes, gate)} />);
      expect(screen.getByTestId("frame-diagrams-rendering")).toHaveTextContent(/rendering diagrams/i);
      expect(document.querySelector("iframe")).toBeNull();
      await act(async () => { open(); });
      await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
      const before = document.querySelector("iframe")!.getAttribute("srcdoc") ?? "";
      expect(before).toContain('class="node default"');
      expect(before).toContain("dp-page-mermaid-0-flowchart-A-0");
      expect(before).not.toContain("pre class=\"mermaid\"");
      expect(before).not.toMatch(/onload=/);
      await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
      const after = document.querySelector("iframe")!.getAttribute("srcdoc") ?? "";
      expect(after).toContain("dp-page-mermaid-0-flowchart-A-0");
      expect(after).not.toMatch(/onload=/);
      // The Run document is still the agent's own page (its script included).
      expect(after).toContain("<script>1</script>");
    });

    it("re-renders for the companion theme", async () => {
      const themes: string[] = [];
      act(() => usePreferencesStore.getState().setTheme("light"));
      const { unmount } = render(<PrototypeFrame html={PAGE} staticFirst noun="page" annotation={annotationWith(themes)} />);
      await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
      act(() => usePreferencesStore.getState().setTheme("dark"));
      await waitFor(() => expect(themes).toEqual(["light", "dark"]));
      await waitFor(() => expect(document.querySelector("iframe")!.getAttribute("srcdoc")).toContain("background:#1f2020"));
      unmount();
    });

    it("a theme flip while the page is Running does not reload the running page", async () => {
      const themes: string[] = [];
      act(() => usePreferencesStore.getState().setTheme("light"));
      const { unmount } = render(<PrototypeFrame html={PAGE} staticFirst noun="page" annotation={annotationWith(themes)} />);
      await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
      await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
      const runningFrame = document.querySelector("iframe")!;
      const runDoc = runningFrame.getAttribute("srcdoc");
      act(() => usePreferencesStore.getState().setTheme("dark"));
      await new Promise((r) => setTimeout(r, 20));
      expect(themes).toEqual(["light"]);
      expect(document.querySelector("iframe")).toBe(runningFrame);
      expect(runningFrame.getAttribute("srcdoc")).toBe(runDoc);
      unmount();
    });

    it("Run during a pending theme render freezes the displayed document; the late render never reloads the running frame", async () => {
      const themes: string[] = [];
      let openDark!: () => void;
      const darkGate = new Promise<void>((r) => { openDark = r; });
      const annotation: FrameAnnotation = {
        script: "/*annotator*/",
        sanitize: sanitizePageHtml,
        prepare: {
          needed: (h) => h.includes("mermaid"),
          run: async (h, theme) => {
            if (theme === "dark") await darkGate;
            return (await renderPageMermaid(h, { theme, renderer: fakeRenderer(themes) })).html;
          },
        },
      };
      act(() => usePreferencesStore.getState().setTheme("light"));
      const { unmount } = render(<PrototypeFrame html={PAGE} staticFirst noun="page" annotation={annotation} />);
      await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
      // Flip the theme; the dark render is still pending when Run is pressed.
      act(() => usePreferencesStore.getState().setTheme("dark"));
      await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
      const runningFrame = document.querySelector("iframe")!;
      expect(runningFrame.getAttribute("sandbox")).toBe("allow-scripts");
      const runDoc = runningFrame.getAttribute("srcdoc");
      expect(runDoc).toContain("<script>1</script>");
      expect(runDoc).not.toContain("background:#1f2020");
      // The dark render resolves after Run: it must not replace the srcdoc.
      await act(async () => { openDark(); });
      await waitFor(() => expect(themes).toEqual(["light", "dark"]));
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelector("iframe")).toBe(runningFrame);
      expect(runningFrame.getAttribute("srcdoc")).toBe(runDoc);
      unmount();
    });

    it("#714 gap 12: each displayed srcdoc gets its own document id; the frozen Run document keeps its id through a late theme render", async () => {
      const themes: string[] = [];
      let openDark!: () => void;
      const darkGate = new Promise<void>((r) => { openDark = r; });
      const scripts: string[] = [];
      const annotation: FrameAnnotation = {
        script: "/*annotator*/",
        scriptFor: (doc) => { scripts.push(doc); return `/*annotator ${doc}*/`; },
        sanitize: sanitizePageHtml,
        prepare: {
          needed: (h) => h.includes("mermaid"),
          run: async (h, theme) => {
            if (theme === "dark") await darkGate;
            return (await renderPageMermaid(h, { theme, renderer: fakeRenderer(themes) })).html;
          },
        },
      };
      act(() => usePreferencesStore.getState().setTheme("light"));
      const { unmount } = render(<PrototypeFrame html={PAGE} staticFirst noun="page" annotation={annotation} />);
      await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
      const staticFrame = document.querySelector("iframe")!;
      const staticId = staticFrame.getAttribute("data-dp-doc")!;
      expect(staticId).toMatch(/^[0-9a-f]{32}$/);
      // The id is the one injected into THAT srcdoc's annotator.
      expect(staticFrame.getAttribute("srcdoc")).toContain(`/*annotator ${staticId}*/`);
      act(() => usePreferencesStore.getState().setTheme("dark"));
      await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
      const runningFrame = document.querySelector("iframe")!;
      const runId = runningFrame.getAttribute("data-dp-doc")!;
      expect(runId).toMatch(/^[0-9a-f]{32}$/);
      expect(runId).not.toBe(staticId);
      expect(runningFrame.getAttribute("srcdoc")).toContain(`/*annotator ${runId}*/`);
      const minted = scripts.length;
      // The late dark render: no new srcdoc for the running frame, no new id.
      await act(async () => { openDark(); });
      await waitFor(() => expect(themes).toEqual(["light", "dark"]));
      await new Promise((r) => setTimeout(r, 20));
      expect(document.querySelector("iframe")).toBe(runningFrame);
      expect(runningFrame.getAttribute("data-dp-doc")).toBe(runId);
      expect(runningFrame.getAttribute("srcdoc")).toContain(`/*annotator ${runId}*/`);
      // (The before-Run document may be rebuilt off screen; the running one is not.)
      expect(scripts.slice(minted)).not.toContain(runId);
      unmount();
    });

    it("the real gate: a page that only mentions Mermaid frames at once, no placeholder", () => {
      const real: FrameAnnotation = { script: "/*a*/", sanitize: sanitizePageHtml, prepare: PAGE_MERMAID_PREPARE };
      render(<PrototypeFrame html="<h1>Why not mermaid?</h1><p class='mermaid-ish'>We drew SVG.</p>" staticFirst noun="page" annotation={real} />);
      expect(screen.queryByTestId("frame-diagrams-rendering")).toBeNull();
      expect(document.querySelector("iframe")!.getAttribute("srcdoc")).toContain("Why not mermaid?");
    });

    it("a page without Mermaid frames at once, with no prepare pass", () => {
      const themes: string[] = [];
      render(<PrototypeFrame html="<h1>Plain</h1>" staticFirst noun="page" annotation={annotationWith(themes)} />);
      expect(screen.queryByTestId("frame-diagrams-rendering")).toBeNull();
      expect(document.querySelector("iframe")!.getAttribute("srcdoc")).toContain("<h1>Plain</h1>");
      expect(themes).toEqual([]);
    });
  });
});
