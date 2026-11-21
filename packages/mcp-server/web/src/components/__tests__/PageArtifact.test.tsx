/**
 * #680 slice 1 — the page artifact renderer: agent HTML inside PrototypeFrame's
 * isolation (opaque-origin sandbox, injected no-network CSP), readable before
 * Run, scripts click-to-run, with the standard review footer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { pageArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { PageArtifact } from "../artifacts/PageArtifact";
import { useArtifactStore } from "../../stores/artifact";

// The full verb row only renders once the reader reaches the artifact's end.
function stubIO(isIntersecting: boolean) {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting }]); }
      disconnect() {}
      unobserve() {}
    } as any,
  );
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(pageArtifact);
  stubIO(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => vi.unstubAllGlobals());

const frame = () => document.querySelector("iframe");

describe("PageArtifact", () => {
  it("mounts the page in a sandboxed iframe at an opaque origin, before Run", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const iframe = frame();
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute("sandbox");
    // Present, and never allow-same-origin (that would hand agent code the
    // daemon's origin). Before Run it is the empty token list: no scripts.
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).toBe("");
    const srcdoc = iframe!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("<h1>Cache invalidation</h1>");
    // The agent markup lives only inside srcdoc, never in the parent document.
    expect(screen.queryByText("Cache invalidation")).not.toBeInTheDocument();
  });

  it("keeps agent scripts click-to-run: Run remounts the frame with allow-scripts only", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(frame()!.getAttribute("sandbox")).toBe("");
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const sandbox = frame()!.getAttribute("sandbox") ?? "";
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("offers no Run button for a page without scripts", () => {
    const plain: Artifact = { ...pageArtifact, id: "art_page_plain", content: { title: "Plain", html: "<p>Just text.</p>" } };
    render(<PageArtifact artifact={plain} />);
    expect(frame()).not.toBeNull();
    expect(screen.queryByRole("button", { name: /run page scripts/i })).not.toBeInTheDocument();
  });

  it("shows the summary and the source path above the frame", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.getByText(/three invalidation strategies we discussed/i)).toBeInTheDocument();
    expect(screen.getByText("docs/cache-options.html")).toBeInTheDocument();
  });

  it("renders the standard review footer (Request changes / Reject)", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.getByPlaceholderText(/respond to the agent/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /request changes/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /^reject/i }).length).toBeGreaterThan(0);
  });

  it("accepts a page over the 512 KB prototype cap (page cap is 2 MB)", () => {
    const big: Artifact = {
      ...pageArtifact,
      id: "art_page_big",
      content: { title: "Big", html: "<p>" + "x".repeat(600 * 1024) + "</p>" },
    };
    render(<PageArtifact artifact={big} />);
    expect(screen.queryByText(/too large to render safely/i)).not.toBeInTheDocument();
    expect(frame()).not.toBeNull();
  });
});
