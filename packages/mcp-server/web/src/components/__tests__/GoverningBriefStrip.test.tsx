import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactPanel } from "../ArtifactPanel";
import { NextUpBar } from "../NextUpBar";
import { usePreferencesStore } from "../../stores/preferences";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
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
const NO_REVIEW_CONTEXT = "Decide alone: layout\nRisk class: low-risk\nWe will review this later: packet";
const strip = () => screen.queryByRole("region", { name: "Governing brief" });

describe("GoverningBriefStrip (#571 slice 2)", () => {
  beforeEach(() => {
    seq = 0;
    useArtifactStore.getState().reset();
    useReplayStore.setState({ active: false } as any);
    usePreferencesStore.setState({ nextUpBar: false, sidebarCollapsed: false } as any);
  });

  it("is absent when the session has no governing brief", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "r1", type: "research", content: { summary: "s", findings: [] } }));
    s.addArtifact(art({ id: "sp_rej", status: "rejected", content: BRIEF_CONTENT }));
    render(<ArtifactPanel />);
    expect(strip()).not.toBeInTheDocument();
  });

  it("is absent for a spec without a headed Review: line (not a delegated run)", () => {
    useArtifactStore.getState().addArtifact(art({ id: "sp1", content: { ...BRIEF_CONTENT, context: NO_REVIEW_CONTEXT } }));
    render(<ArtifactPanel />);
    expect(strip()).not.toBeInTheDocument();
  });

  it("is absent once every task is done or skipped", () => {
    useArtifactStore.getState().addArtifact(art({ id: "sp1", content: { ...BRIEF_CONTENT,
      tasks: [{ description: "a", status: "done" }, { description: "b", status: "skipped" }] } }));
    render(<ArtifactPanel />);
    expect(strip()).not.toBeInTheDocument();
  });

  it("is absent for a fresh draft whose tasks are all pending", () => {
    useArtifactStore.getState().addArtifact(art({ id: "sp1", status: "draft", content: { ...BRIEF_CONTENT,
      tasks: [{ description: "a", status: "pending" }, { description: "b", status: "pending" }] } }));
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
    expect(r.getByTestId("governing-brief-objective")).toHaveAttribute("title", BRIEF_CONTENT.objective);
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

  it("updates live on a plan_progress_updated patch, and unpins when the run finishes", () => {
    const s = useArtifactStore.getState();
    const spec = art({ id: "sp1", content: BRIEF_CONTENT });
    s.addArtifact(spec);
    render(<ArtifactPanel />);
    expect(within(strip()!).getByTestId("governing-brief-progress")).toHaveTextContent("3/5 tasks done");
    act(() => s.replaceArtifact({ ...spec, content: { ...BRIEF_CONTENT,
      tasks: BRIEF_CONTENT.tasks.map((t, i) => (i === 3 ? { ...t, status: "done" } : t)) } }));
    expect(within(strip()!).getByTestId("governing-brief-progress")).toHaveTextContent("4/5 tasks done");
    act(() => s.replaceArtifact({ ...spec, content: { ...BRIEF_CONTENT,
      tasks: BRIEF_CONTENT.tasks.map((t, i) => (i === 4 ? { ...t, status: "skipped" } : { ...t, status: "done" })) } }));
    expect(strip()).not.toBeInTheDocument();
  });

  it("shows an in-progress draft brief once a task has started", () => {
    useArtifactStore.getState().addArtifact(art({ id: "sp1", status: "draft", content: { ...BRIEF_CONTENT,
      tasks: [{ description: "t", status: "in_progress" }, { description: "u", status: "pending" }] } }));
    render(<ArtifactPanel />);
    expect(within(strip()!).getByTestId("governing-brief-progress")).toHaveTextContent("0/2 tasks done");
  });

  it("legacy brief without task status or edgePaths renders only what it has", () => {
    useArtifactStore.getState().addArtifact(art({ id: "legacy", title: "Old brief",
      content: { objective: "Legacy objective", context: "Some background.\nReview: line-by-line", requirements: [],
        tasks: [{ description: "a" }, { description: "b" }] } }));
    render(<ArtifactPanel />);
    const r = within(strip()!);
    expect(r.getByTestId("governing-brief-title")).toHaveTextContent("Old brief");
    expect(r.getByTestId("governing-brief-progress")).toHaveTextContent("2 tasks");
    expect(r.queryByTestId("governing-brief-edge-paths")).not.toBeInTheDocument();
    expect(r.getByTestId("governing-brief-review")).toHaveTextContent("Review: line-by-line");
  });

  it("a legacy spec with no Review line is not pinned", () => {
    useArtifactStore.getState().addArtifact(art({ id: "legacy", content: { objective: "o", context: "Some background.", requirements: [] } }));
    render(<ArtifactPanel />);
    expect(strip()).not.toBeInTheDocument();
  });

  it("picks the most recently approved of several briefs", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "older", title: "Older", content: BRIEF_CONTENT, statusHistory: [{ status: "approved", at: "2026-10-23T11:00:00.000Z" }] }));
    s.addArtifact(art({ id: "newer", title: "Newer", content: BRIEF_CONTENT, statusHistory: [{ status: "approved", at: "2026-10-23T12:00:00.000Z" }] }));
    s.addArtifact(art({ id: "late_created", title: "Created later, approved earlier", content: BRIEF_CONTENT,
      statusHistory: [{ status: "approved", at: "2026-10-23T10:30:00.000Z" }] }));
    expect(selectGoverningBrief(useArtifactStore.getState().artifacts)?.id).toBe("newer");
  });

  it("is withheld in the all-sessions view and pins in a single-session view", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(art({ id: "sp1", sessionId: "s1", title: "S1 brief", content: BRIEF_CONTENT }));
    s.addArtifact(art({ id: "r2", sessionId: "s2", type: "research", title: "S2 research", content: { summary: "s", findings: [] } }));
    render(<ArtifactPanel />);
    expect(strip()).not.toBeInTheDocument(); // "All" agents: no unlabelled pin
    fireEvent.click(screen.getByRole("button", { name: /^Agent 1 \(/ }));
    expect(within(strip()!).getByTestId("governing-brief-title")).toHaveTextContent("S1 brief");
    fireEvent.click(screen.getByRole("button", { name: /^Agent 2 \(/ }));
    expect(strip()).not.toBeInTheDocument(); // s2 has no brief of its own
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

  it("pinning the brief changes no attention lane, Next-up bar or badge", () => {
    // Differential: the same session rendered twice, once where the spec is a
    // delegate brief (strip pinned) and once where it is not (no strip). The
    // Next-up bar, the attention lanes and the unread badges must be identical.
    useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1",
      activeSessions: [{ sessionId: "s1", live: true }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false } as any);
    usePreferencesStore.setState({ nextUpBar: true } as any);
    const run = (context: string) => {
      seq = 0;
      useArtifactStore.getState().reset();
      const s = useArtifactStore.getState();
      s.addArtifact(art({ id: "plan_d", type: "plan", title: "Draft plan", status: "draft", content: { summary: "p", steps: [] } }));
      s.addArtifact(art({ id: "sp1", title: "The brief", content: { ...BRIEF_CONTENT, context } }));
      s.addArtifact(art({ id: "r1", type: "research", title: "Fresh research", status: "draft", content: { summary: "s", findings: [] } }));
      render(<><NextUpBar /><ArtifactPanel /></>);
      const st = useArtifactStore.getState();
      const lanes = computeAttention({ artifacts: st.artifacts, comments: st.comments }).lanes;
      const out = {
        pinned: strip() !== null,
        bar: screen.getAllByTestId("next-up-bar").map((el) => el.textContent),
        lanes: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, (v as unknown[]).length])),
        unread: [...st.unreadIds],
      };
      cleanup();
      return out;
    };
    const withBrief = run(BRIEF_CONTENT.context);
    const without = run(NO_REVIEW_CONTEXT);
    expect(withBrief.pinned).toBe(true);
    expect(without.pinned).toBe(false);
    expect(withBrief.bar.length).toBeGreaterThan(0);
    expect(withBrief.bar).toEqual(without.bar);
    expect(withBrief.lanes).toEqual(without.lanes);
    expect(withBrief.unread).toEqual(without.unread);
  });
});

describe("parseReviewMode", () => {
  it("reads only a whole headed Review line", () => {
    expect(parseReviewMode("Risk class: low\nReview: packet")).toBe("packet");
    expect(parseReviewMode("Review:   LINE-BY-LINE  \nWhy: x")).toBe("line-by-line");
    expect(parseReviewMode("review: packet\r\nWhy: x")).toBe("packet");
  });
  it("shows nothing for prose, other values or no line", () => {
    expect(parseReviewMode(undefined)).toBeUndefined();
    expect(parseReviewMode(42)).toBeUndefined();
    expect(parseReviewMode("Code review: packet")).toBeUndefined();
    expect(parseReviewMode("Review: packet, unless the diff is large")).toBeUndefined();
    expect(parseReviewMode("Review: later")).toBeUndefined();
    expect(parseReviewMode("We discussed it. Review: packet")).toBeUndefined();
    expect(parseReviewMode("Review:   ")).toBeUndefined();
  });
});
