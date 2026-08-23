import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { ReasoningCard } from "../ReasoningCard";
import { useArtifactStore } from "../../../stores/artifact";

/**
 * U2 F2 — the shared Evidence type now allows a locator-only evidence (no
 * filePath/lineStart). The reasoning card's EvidenceChip must NOT render
 * `undefined:undefined` for one; it shows the locator "where" instead. A code
 * evidence still renders its file:line label byte-identical.
 */
function mount(evidence: unknown[]): Artifact {
  const artifact = {
    id: "art_reason_u2",
    type: "reasoning",
    version: 1,
    parentId: null,
    status: "presented",
    createdAt: new Date().toISOString(),
    sessionId: "s",
    content: { action: "read the contract", reasoning: "checking the clause", evidence },
  } as unknown as Artifact;
  useArtifactStore.getState().addArtifact(artifact);
  return artifact;
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("U2 F2 — ReasoningCard EvidenceChip", () => {
  it("a code evidence renders its file:line label (back-compat)", () => {
    const artifact = mount([{ filePath: "/src/auth.ts", lineStart: 5, lineEnd: 8, snippet: "x", explanation: "e" }]);
    render(<ReasoningCard artifact={artifact} />);
    expect(screen.getByText("/src/auth.ts:5-8")).toBeInTheDocument();
    expect(screen.queryByText(/undefined:undefined/)).not.toBeInTheDocument();
  });

  it("a locator-only evidence shows the locator label, never `undefined:undefined`", () => {
    const artifact = mount([{ snippet: "the burst cap is undefined", explanation: "open ceiling", locator: { kind: "heading", value: "§5 ¶3" } }]);
    render(<ReasoningCard artifact={artifact} />);
    expect(screen.getByText("§5 ¶3")).toBeInTheDocument();
    expect(screen.queryByText(/undefined:undefined/)).not.toBeInTheDocument();
    // the passage snippet still renders.
    expect(screen.getByText("the burst cap is undefined")).toBeInTheDocument();
  });
});
