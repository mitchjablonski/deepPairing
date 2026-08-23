import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { ResearchArtifact } from "../ResearchArtifact";
import { useArtifactStore } from "../../../stores/artifact";

/**
 * U2 (round-15 generalization) — the Evidence renderer must anchor to DOCS, not
 * only code. A code finding (file:line) keeps the unchanged line-numbered gutter
 * (back-compat); a doc-anchored finding (a `locator`, no line grain) renders as
 * a QUOTED, per-passage-COMMENTABLE block — the flagship
 * comment-on-the-exact-passage affordance survives instead of degrading to prose.
 */

function mount(findings: unknown[]): Artifact {
  const artifact: Artifact = {
    id: "art_u2",
    type: "research",
    version: 1,
    parentId: null,
    status: "draft",
    createdAt: new Date().toISOString(),
    sessionId: "s",
    content: { summary: "review", findings },
  } as unknown as Artifact;
  useArtifactStore.getState().addArtifact(artifact);
  return artifact;
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("U2 — Evidence renders to docs, not only code", () => {
  it("a CODE evidence (file:line) still renders the line-numbered header (back-compat)", () => {
    const artifact = mount([
      {
        category: "security",
        detail: "weak hash",
        significance: "high",
        evidence: [
          {
            filePath: "/src/auth.ts",
            lineStart: 20,
            lineEnd: 24,
            snippet: "bcrypt.hash(pw, 4)",
            explanation: "weak cost factor",
          },
        ],
      },
    ]);
    render(<ResearchArtifact artifact={artifact} />);
    // the file:line anchor header — the unchanged code path.
    expect(screen.getByText(/\/src\/auth\.ts:20-24/)).toBeInTheDocument();
  });

  it("a DOC evidence (locator, no line grain) renders a QUOTED, per-passage-commentable block", () => {
    const artifact = mount([
      {
        category: "risk",
        detail: "undefined burst cap",
        significance: "high",
        evidence: [
          {
            snippet: "the burst cap is undefined",
            explanation: "Open ceiling — the vendor can throttle at will.",
            locator: { kind: "heading", value: "§5 ¶3" },
          },
        ],
      },
    ]);
    render(<ResearchArtifact artifact={artifact} />);
    // the passage is quoted…
    expect(screen.getByText("the burst cap is undefined")).toBeInTheDocument();
    // …the heading anchor is shown…
    expect(screen.getByText("§5 ¶3")).toBeInTheDocument();
    // …and the flagship comment-on-the-passage affordance is present.
    expect(screen.getByRole("button", { name: /Comment on this passage/i })).toBeInTheDocument();
    // an Ask affordance is present too (finding-level + this passage-level).
    expect(screen.getAllByRole("button", { name: /Ask the agent/i }).length).toBeGreaterThan(0);
    // it is NOT degraded to a raw JSON dump.
    expect(screen.queryByText(/"locator"/)).not.toBeInTheDocument();
  });

  it("a hostile locator/quote value renders ESCAPED (React text node — no markup injected)", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const artifact = mount([
      {
        category: "risk",
        detail: "x",
        significance: "high",
        evidence: [{ explanation: "z", locator: { kind: "quote", value: hostile } }],
      },
    ]);
    render(<ResearchArtifact artifact={artifact} />);
    // the literal string is present as text; no <img> element was created.
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("a url locator is a clickable http(s) link; a javascript: locator stays inert text", () => {
    const artifact = mount([
      {
        category: "risk",
        detail: "x",
        significance: "high",
        evidence: [
          { snippet: "the terms", explanation: "e", locator: { kind: "url", value: "the terms", href: "https://ex.com/terms#5" } },
          { snippet: "evil", explanation: "e", locator: { kind: "url", value: "evil", href: "javascript:alert(1)" } },
        ],
      },
    ]);
    render(<ResearchArtifact artifact={artifact} />);
    const link = screen.getByRole("link", { name: "the terms" });
    expect(link).toHaveAttribute("href", "https://ex.com/terms#5");
    // the javascript: href is never rendered as an anchor.
    expect(screen.queryByRole("link", { name: "evil" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
