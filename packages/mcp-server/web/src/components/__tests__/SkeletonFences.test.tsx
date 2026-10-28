import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PlanVisual } from "@deeppairing/shared";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { useArtifactStore } from "../../stores/artifact";

/**
 * Skeleton plans, parity PR 2 — the plan card's skeleton code: fences shaded by
 * status (pending / filled / active), each labelled with its step in TEXT, and
 * the lines still commentable.
 */
beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

const CODE = [
  "export function a() {", // 1
  "  // SKEL[1] dedupe", // 2
  '  throw new Error("SKEL_TODO");', // 3
  "  // /SKEL[1]", // 4
  "}", // 5
  "export function b() {", // 6
  "  // SKEL[2] wire", // 7
  "  return 2;", // 8
  "  // /SKEL[2]", // 9
  "}", // 10
  "export function c() {", // 11
  "  // SKEL[3] render", // 12
  "  return 3;", // 13
  "  // /SKEL[3]", // 14
  "}", // 15
].join("\n");

const SKELETON: PlanVisual = {
  id: "skelcode:src/a.ts",
  kind: "annotated_code",
  title: "src/a.ts",
  filePath: "src/a.ts",
  lineStart: 1,
  code: CODE,
  skeleton: {
    fences: [
      { id: "1", title: "dedupe", openLine: 2, closeLine: 4, status: "todo" },
      { id: "2", title: "wire", openLine: 7, closeLine: 9, status: "filled" },
      { id: "3", title: "render", openLine: 12, closeLine: 14, status: "filled" },
    ],
  },
};

const STEPS = [
  { description: "Dedupe the points", skelId: "1", status: "pending" },
  { description: "Wire the canvas", skelId: "2", status: "done" },
  { description: "Render the stroke", skelId: "3", status: "in_progress" },
];

const statusOfLine = (container: HTMLElement, line: number) =>
  container.querySelector(`[data-comment-anchor="line:src/a.ts:${line}"]`)?.getAttribute("data-skel-status") ?? null;

describe("skeleton code in the plan card", () => {
  it("shades each fence by status: pending (SKEL_TODO), filled, active (in_progress step)", () => {
    const { container } = render(<ArtifactVisuals artifactId="art_p" visuals={[SKELETON]} skeletonSteps={STEPS} />);
    expect(statusOfLine(container, 3)).toBe("pending");
    expect(statusOfLine(container, 8)).toBe("filled");
    // Fence 3's snapshot says filled, but its step is in progress: active wins.
    expect(statusOfLine(container, 13)).toBe("active");
    // Code outside every fence is undecorated.
    expect(statusOfLine(container, 1)).toBeNull();
    expect(statusOfLine(container, 5)).toBeNull();
  });

  it("labels every fence with its step and status in text, not colour alone", () => {
    render(<ArtifactVisuals artifactId="art_p" visuals={[SKELETON]} skeletonSteps={STEPS} />);
    const notes = screen.getAllByRole("note");
    expect(notes.map((n) => n.getAttribute("aria-label"))).toEqual([
      "SKEL[1] fence, Step 1, Pending",
      "SKEL[2] fence, Step 2, Filled",
      "SKEL[3] fence, Step 3, Active",
    ]);
    expect(notes[0]!.textContent).toContain("Dedupe the points");
    // The compact summary counts by status.
    expect(screen.getByText(/1 pending/)).toBeInTheDocument();
    expect(screen.getByText(/1 filled/)).toBeInTheDocument();
    expect(screen.getByText(/1 active/)).toBeInTheDocument();
    expect(screen.getByText("Skeleton code")).toBeInTheDocument();
  });

  it("keeps the code commentable per line and offers the visual-level comment", () => {
    const { container } = render(<ArtifactVisuals artifactId="art_p" visuals={[SKELETON]} skeletonSteps={STEPS} />);
    expect(container.textContent).toContain('throw new Error("SKEL_TODO");');
    expect(screen.getByText("Comment on this code")).toBeInTheDocument();
    // Every line keeps its comment anchor (the gutter LineComposer posts to).
    expect(container.querySelectorAll('[data-comment-anchor^="line:src/a.ts:"]').length).toBe(15);
    // Whole files take the 60vh cap so a long skeleton can't bury the steps.
    expect(container.querySelector('[data-dp-visual-cap="true"]')).not.toBeNull();
  });

  it("without steps a fence falls back to its snapshot status; a fence no step claims says so", () => {
    render(<ArtifactVisuals artifactId="art_p" visuals={[SKELETON]} />);
    const labels = screen.getAllByRole("note").map((n) => n.getAttribute("aria-label"));
    expect(labels).toEqual([
      "SKEL[1] fence, No step claims it, Pending",
      "SKEL[2] fence, No step claims it, Filled",
      "SKEL[3] fence, No step claims it, Filled",
    ]);
  });

  it("marks a truncated snapshot and a tracked (unfenced) file", () => {
    const truncated: PlanVisual = { ...SKELETON, skeleton: { ...SKELETON.skeleton!, truncated: { shownLines: 15, totalLines: 90 } } };
    const tracked: PlanVisual = { id: "skelcode:src/types.ts", kind: "annotated_code", filePath: "src/types.ts", code: "export type P = 1;", skeleton: { fences: [], tracked: true } };
    render(<ArtifactVisuals artifactId="art_p" visuals={[truncated, tracked]} skeletonSteps={STEPS} />);
    expect(screen.getByText(/Truncated: lines 1–15 of 90/)).toBeInTheDocument();
    expect(screen.getByText("Tracked file, no fences")).toBeInTheDocument();
  });

  it("an ordinary annotated_code visual renders exactly as before (no fence decoration)", () => {
    const plain: PlanVisual = { id: "ac", kind: "annotated_code", code: "const x = 1;", filePath: "src/x.ts" };
    const { container } = render(<ArtifactVisuals artifactId="art_p" visuals={[plain]} skeletonSteps={STEPS} />);
    expect(container.querySelector("[data-skel-status]")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("Annotated code")).toBeInTheDocument();
    expect(container.querySelector('[data-dp-visual-cap="true"]')).toBeNull();
  });
});
