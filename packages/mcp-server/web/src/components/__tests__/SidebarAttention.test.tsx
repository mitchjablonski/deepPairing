import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactPanel } from "../ArtifactPanel";

/**
 * #430 PR 0 (docs/design/attention-hierarchy.md §4.3, §8 "PR 0") — the acute
 * attention bug. The sidebar's 10-most-recent cutoff hid the ONLY high-stakes
 * decision behind "Show N older", and explainer/reasoning drafts wore the same
 * amber "Draft, awaiting review" dot as items that are actually pending.
 */
let seq = 0;
const at = () => `2026-06-01T00:${String(seq++).padStart(2, "0")}:00.000Z`;
const art = (id: string, type: string, title: string, status = "draft", content: Record<string, unknown> = {}) =>
  ({ id, type, title, status, version: 1, sessionId: "s1", parentId: null, agentReasoning: null, createdAt: at(), updatedAt: at(), content }) as any;
const research = (id: string, title: string, status = "draft") =>
  art(id, "research", title, status, { summary: "s", findings: [] });

beforeEach(() => {
  seq = 0;
  useArtifactStore.getState().reset();
});

describe("#430 PR 0 — pending items never collapse out of the sidebar", () => {
  it("the design doc's seeded case: an older HIGH-stakes decision stays visible behind 13 newer drafts", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(research("u_res", "Session cache hit rate is 12%"));
    s.addArtifact(art("u_exp", "explainer", "How the session cache is read today", "draft", { title: "x", overview: "o", sections: [] }));
    s.addArtifact(art("u_dec", "decision", "Which store backs the session cache?", "draft", {
      context: "Needed before Thursday.", decisionId: "d_store", stakes: "high", options: [],
    }));
    for (let i = 0; i < 13; i++) s.addArtifact(research(`q${i}`, `Queue finding ${i}`));
    // Land where the seeded session landed: on the newest item, not the decision.
    s.selectArtifact("q12");
    render(<ArtifactPanel />);
    // Visible WITHOUT expanding "Show older".
    expect(screen.queryAllByText("Which store backs the session cache?").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Session cache hit rate is 12%").length).toBeGreaterThan(0);
    // Only the non-pending explainer may collapse.
    expect(screen.getByText("▾ Show 1 older")).toBeInTheDocument();
    expect(screen.queryByText("How the session cache is read today")).not.toBeInTheDocument();
  });

  it("old NON-pending items still collapse; an old pending decision among them does not", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art("dec", "decision", "Old open decision", "draft", { context: "c", decisionId: "d1", stakes: "high", options: [] }));
    for (let i = 0; i < 12; i++) s.addArtifact(research(`done${i}`, `Done ${i}`, "approved"));
    s.selectArtifact("done11");
    render(<ArtifactPanel />);
    expect(screen.queryAllByText("Old open decision").length).toBeGreaterThan(0);
    // 13 items: 10 recent approved + the pending decision shown; 2 old approved hidden.
    expect(screen.getByText("▾ Show 2 older")).toBeInTheDocument();
    expect(screen.queryByText("Done 0")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("▾ Show 2 older"));
    expect(screen.queryAllByText("Done 0").length).toBeGreaterThan(0);
  });
});

describe("#430 PR 0 — the sidebar dot agrees with what is actually pending", () => {
  const dotFor = (title: string) => {
    const row = screen.getAllByText(title).map((el) => el.closest("button")).find(Boolean)!;
    return row.querySelector("span[aria-label][title]") as HTMLElement;
  };

  it("explainer and reasoning drafts get a NEUTRAL 'for you to read' dot, not the amber review dot", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art("exp", "explainer", "How refresh works", "draft", { title: "t", overview: "o", sections: [] }));
    s.addArtifact(art("rea", "reasoning", "Single-flight instead of a lock", "draft", { action: "a", reasoning: "r" }));
    s.addArtifact(research("res", "Refresh isn't coalesced"));
    render(<ArtifactPanel />);

    for (const title of ["How refresh works", "Single-flight instead of a lock"]) {
      const dot = dotFor(title);
      expect(dot.getAttribute("aria-label")).toBe("New — for you to read");
      expect(dot.className).not.toContain("bg-accent-amber");
      expect(dot.textContent).toBe("○");
    }
    // A reviewable draft is unchanged: amber, "Draft, awaiting review", ●.
    const review = dotFor("Refresh isn't coalesced");
    expect(review.getAttribute("aria-label")).toBe("Draft, awaiting review");
    expect(review.className).toContain("bg-accent-amber");
    expect(review.textContent).toBe("●");
  });

  it("the collapsed icon rail carries the same neutral label for an explainer draft", () => {
    useArtifactStore.getState().addArtifact(art("exp", "explainer", "How refresh works", "draft", { title: "t", overview: "o", sections: [] }));
    render(<ArtifactPanel />);
    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    const btn = screen.getByRole("button", { name: /How refresh works — New — for you to read/ });
    expect(btn).toBeInTheDocument();
  });
});
