import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactPanel } from "../ArtifactPanel";
import { computeAttention } from "../../lib/attention";
import { selectGoverningBrief, parseReviewMode } from "../../lib/governingBrief";

/**
 * #571 slice 2 — the pinned Governing brief strip. Fakes, not mocks: the real
 * artifact store is fed the same artifacts the WS paths deliver (addArtifact =
 * artifact_created, updateArtifact = artifact_updated, replaceArtifact =
 * plan_progress_updated); the WS dispatch itself is covered in
 * stores/__tests__/connection.test.ts.
 */
let seq = 0;
const ts = () => `2026-10-23T10:${String(seq++).padStart(2, "0")}:00.000Z`;
function art(over: Partial<Artifact> & Record<string, unknown>): Artifact {
  const at = ts();
  return {
    id: `a_${seq}`, sessionId: "s1", type: "spec", version: 1, parentId: null, title: "Brief",
    status: "approved", content: {}, agentReasoning: null, createdAt: at, updatedAt: at, ...over,
  } as Artifact;
}
const BRIEF_CONTENT = {
  objective: "Keep the governing brief findable while delegated work runs",
  context: "Decide alone: layout\nWill ask: schema\nRisk class: low-risk\nWhy: read-only\nReview: packet",
  requirements: [{ id: "REQ-1", text: "r", rationale: "why", acceptanceCriteria: ["a"] }],
  tasks: [
    { description: "t0", status: "done" },
    { description: "t1", status: "done" },
    { description: "t2", status: "done" },
    { description: "t3", status: "in_progress" },
    { description: "t4", status: "pending" },
  ],
  edgePaths: [
    { id: "wake", path: "long-poll wake", risk: "missed" },
    { id: "replay", path: "replay mode", risk: "stale" },
  ],
};
const strip = () => screen.queryByRole("region", { name: "Governing brief" });

describe("GoverningBriefStrip (#571 slice 2)", () => {
  beforeEach(() => {
    seq = 0;
    useArtifactStore.getState().reset();
  });

  it("is absent when the session has no governing brief", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "r1", type: "research", content: { summary: "s", findings: [] } }));
    // A draft spec with no task tracking and no approved ancestor is not a brief yet.
    s.addArtifact(art({ id: "sp_draft", status: "draft", content: { objective: "o", requirements: [] } }));
    s.addArtifact(art({ id: "sp_rej", status: "rejected", content: { objective: "o", requirements: [] } }));
    render(<ArtifactPanel />);
    expect(strip()).not.toBeInTheDocument();
  });

  it("shows an approved spec's title, objective, task progress, edge-path count and Review mode", () => {
    useArtifactStore.getState().addArtifact(art({ id: "sp1", title: "Pin the brief", content: BRIEF_CONTENT }));
    render(<ArtifactPanel />);
    const region = strip()!;
    expect(region).toBeInTheDocument();
    const r = within(region);
    expect(r.getByTestId("governing-brief-title")).toHaveTextContent("Pin the brief");
    expect(r.queryByTestId("governing-brief-version")).not.toBeInTheDocument(); // v1 shows no version chip
    expect(r.getByTestId("governing-brief-objective")).toHaveTextContent(BRIEF_CONTENT.objective);
    expect(r.getByTestId("governing-brief-progress")).toHaveTextContent("3/5 tasks done");
    expect(r.getByTestId("governing-brief-edge-paths")).toHaveTextContent("2 edge paths");
    expect(r.getByTestId("governing-brief-review")).toHaveTextContent("Review: packet");
    expect(r.queryByTestId("governing-brief-awaiting")).not.toBeInTheDocument();
    // Honest cursor on the one interactive element; nothing meaningful is faded.
    expect(r.getByRole("button").className).toContain("cursor-pointer");
    expect(region.innerHTML).not.toMatch(/opacity-/);
  });

  it("follows a revise_artifact supersede to v2", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "sp1", title: "Brief v1", content: BRIEF_CONTENT,
      statusHistory: [{ status: "approved", at: "2026-10-23T10:00:30.000Z" }] }));
    render(<ArtifactPanel />);
    expect(within(strip()!).getByTestId("governing-brief-title")).toHaveTextContent("Brief v1");
    act(() => {
      s.addArtifact(art({ id: "sp2", title: "Brief v2", version: 2, parentId: "sp1", status: "draft",
        content: { ...BRIEF_CONTENT, tasks: [{ description: "t0" }], edgePaths: undefined } }));
      s.updateArtifact("sp1", "superseded");
    });
    const r = within(strip()!);
    expect(r.getByTestId("governing-brief-title")).toHaveTextContent("Brief v2");
    expect(r.getByTestId("governing-brief-version")).toHaveTextContent("v2");
    // Changed scope does not silently inherit v1's approval.
    expect(r.getByTestId("governing-brief-awaiting")).toHaveTextContent(/awaiting approval/);
    expect(r.queryByTestId("governing-brief-edge-paths")).not.toBeInTheDocument();
    act(() => s.updateArtifact("sp2", "approved"));
    expect(within(strip()!).queryByTestId("governing-brief-awaiting")).not.toBeInTheDocument();
    expect(within(strip()!).getByTestId("governing-brief-title")).toHaveTextContent("Brief v2");
  });

  it("updates live on a plan_progress_updated patch", () => {
    const s = useArtifactStore.getState();
    const spec = art({ id: "sp1", content: BRIEF_CONTENT });
    s.addArtifact(spec);
    render(<ArtifactPanel />);
    expect(within(strip()!).getByTestId("governing-brief-progress")).toHaveTextContent("3/5 tasks done");
    act(() => s.replaceArtifact({ ...spec, content: { ...BRIEF_CONTENT,
      tasks: BRIEF_CONTENT.tasks.map((t, i) => (i === 4 ? { ...t, status: "skipped" } : { ...t, status: "done" })) } }));
    expect(within(strip()!).getByTestId("governing-brief-progress")).toHaveTextContent("4/5 tasks done · 1 skipped");
  });

  it("shows an in-progress draft brief once its tasks are tracked", () => {
    useArtifactStore.getState().addArtifact(art({ id: "sp1", status: "draft",
      content: { objective: "o", requirements: [], tasks: [{ description: "t", status: "in_progress" }] } }));
    render(<ArtifactPanel />);
    expect(within(strip()!).getByTestId("governing-brief-progress")).toHaveTextContent("0/1 task done");
  });

  it("legacy spec without task status, edgePaths or Review renders only what it has", () => {
    useArtifactStore.getState().addArtifact(art({ id: "legacy", title: "Old spec",
      content: { objective: "Legacy objective", context: "Some background.", requirements: [],
        tasks: [{ description: "a" }, { description: "b" }] } }));
    render(<ArtifactPanel />);
    const r = within(strip()!);
    expect(r.getByTestId("governing-brief-title")).toHaveTextContent("Old spec");
    expect(r.getByTestId("governing-brief-progress")).toHaveTextContent("2 tasks");
    expect(r.queryByTestId("governing-brief-edge-paths")).not.toBeInTheDocument();
    expect(r.queryByTestId("governing-brief-review")).not.toBeInTheDocument();
  });

  it("picks the most recently approved of several briefs", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "older", title: "Older", statusHistory: [{ status: "approved", at: "2026-10-23T11:00:00.000Z" }] }));
    s.addArtifact(art({ id: "newer", title: "Newer", statusHistory: [{ status: "approved", at: "2026-10-23T12:00:00.000Z" }] }));
    s.addArtifact(art({ id: "late_created", title: "Created later, approved earlier",
      statusHistory: [{ status: "approved", at: "2026-10-23T10:30:00.000Z" }] }));
    expect(selectGoverningBrief(useArtifactStore.getState().artifacts)?.id).toBe("newer");
  });

  it("opens the brief from the keyboard", async () => {
    const user = userEvent.setup();
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "other", type: "research", title: "Some research", content: { summary: "s", findings: [] } }));
    s.addArtifact(art({ id: "sp1", title: "Pin the brief", content: BRIEF_CONTENT }));
    s.selectArtifact("other");
    render(<ArtifactPanel />);
    const button = within(strip()!).getByRole("button");
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("sp1");
    act(() => s.selectArtifact("other"));
    button.focus();
    await user.keyboard(" ");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("sp1");
  });

  it("changes no attention lane or badge count", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "sp1", content: BRIEF_CONTENT }));
    s.addArtifact(art({ id: "plan_d", type: "plan", status: "draft", content: { summary: "p", steps: [] } }));
    const before = useArtifactStore.getState();
    const attentionBefore = computeAttention({ artifacts: before.artifacts, comments: before.comments });
    const unreadBefore = [...before.unreadIds];
    render(<ArtifactPanel />);
    expect(strip()).toBeInTheDocument();
    const after = useArtifactStore.getState();
    expect(computeAttention({ artifacts: after.artifacts, comments: after.comments })).toEqual(attentionBefore);
    expect(after.unreadIds).toEqual(unreadBefore);
    // The strip itself carries no badge, count pill or live region.
    expect(within(strip()!).queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("parseReviewMode", () => {
  it("reads the headed Review line in its common markdown shapes", () => {
    expect(parseReviewMode("Risk class: low\nReview: packet")).toBe("packet");
    expect(parseReviewMode("- **Review:** line-by-line")).toBe("line-by-line");
    expect(parseReviewMode("**Review**: `packet`")).toBe("packet");
  });
  it("shows nothing when the line is absent or does not parse", () => {
    expect(parseReviewMode(undefined)).toBeUndefined();
    expect(parseReviewMode(42)).toBeUndefined();
    expect(parseReviewMode("Code review: later")).toBeUndefined();
    expect(parseReviewMode("Review:   ")).toBeUndefined();
  });
});
