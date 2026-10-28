import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlanVisual } from "@deeppairing/shared";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { MermaidDiagram } from "../MermaidDiagram";
import { planStepNodeStates, type StepNodeState } from "../SkeletonFences";
import { decorateStepNodes, sourceHasStepNodes, stepNodeAt, stepNodeKey } from "../../lib/skeletonDiagram";
import { useArtifactStore } from "../../stores/artifact";

/**
 * Skeleton plans, parity PR 3 — the status-coloured, clickable architecture
 * diagram: `step_<id>` nodes coloured + patterned by fence status with a text
 * cue, a click jumps to the fence, non-skeleton diagrams are untouched, and
 * region comments keep working.
 */
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

const SVG =
  "<svg aria-label='diagram'>" +
  "<g class='node' id='dp-mmd-1-2-flowchart-step_1-0'><rect></rect><text>Dedupe</text></g>" +
  "<g class='node' id='dp-mmd-1-2-flowchart-step_2-1'><rect></rect><text>Wire</text></g>" +
  "<g class='node' id='dp-mmd-1-2-flowchart-step_2_1-2'><rect></rect><text>Render</text></g>" +
  "<g class='node existing' id='dp-mmd-1-2-flowchart-Canvas-3'><rect></rect><text>Canvas</text></g>" +
  "</svg>";
const SOURCE = "graph TD; step_1-->step_2; step_2-->step_2_1; step_2_1-->Canvas; classDef existing fill:#eee; class Canvas existing";

const CODE = [
  "export function a() {", // 1
  "  // SKEL[1] dedupe", // 2
  '  throw new Error("SKEL_TODO");', // 3
  "  // /SKEL[1]", // 4
  "}", // 5
  "  // SKEL[2] wire", // 6
  "  return 2;", // 7
  "  // /SKEL[2]", // 8
  "  // SKEL[2.1] render", // 9
  "  return 3;", // 10
  "  // /SKEL[2.1]", // 11
].join("\n");

const SKELETON: PlanVisual = {
  id: "skelcode:src/a.ts",
  kind: "annotated_code",
  filePath: "src/a.ts",
  lineStart: 1,
  code: CODE,
  skeleton: {
    fences: [
      { id: "1", openLine: 2, closeLine: 4, status: "todo" },
      { id: "2", openLine: 6, closeLine: 8, status: "filled" },
      { id: "2.1", openLine: 9, closeLine: 11, status: "filled" },
    ],
  },
};
const DIAGRAM: PlanVisual = { id: "arch", kind: "diagram", title: "Shape", source: SOURCE };
const STEPS = [
  { description: "Dedupe", skelId: "1", status: "pending" },
  { description: "Wire", skelId: "2", status: "done" },
  { description: "Render", skelId: "2.1", status: "in_progress" },
];

beforeEach(() => {
  useArtifactStore.getState().reset();
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: SVG });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

const node = (key: string) => document.querySelector(`g[id$="flowchart-${key}-${key === "step_1" ? 0 : key === "step_2" ? 1 : 2}"]`) as SVGGElement;

describe("skeleton diagram — node status", () => {
  it("colours and patterns each step node by status, with a text cue; existing nodes untouched", async () => {
    render(<ArtifactVisuals artifactId="art_p" visuals={[DIAGRAM, SKELETON]} skeletonSteps={STEPS} />);
    await waitFor(() => expect(document.querySelector("g.dp-skel-step")).not.toBeNull());
    expect(node("step_1").getAttribute("data-skel-status")).toBe("pending");
    expect(node("step_1").classList.contains("dp-skel-pending")).toBe(true);
    expect(node("step_2").getAttribute("data-skel-status")).toBe("filled");
    expect(node("step_2_1").getAttribute("data-skel-status")).toBe("active");
    // Text cue on the node itself (SVG <title>), not colour alone.
    expect(node("step_1").querySelector("title")?.textContent).toBe("Step 1 (SKEL[1]): Pending");
    expect(node("step_2_1").querySelector("title")?.textContent).toBe("Step 3 (SKEL[2.1]): Active");
    const existing = document.querySelector('g[id$="flowchart-Canvas-3"]')!;
    expect(existing.classList.contains("existing")).toBe(true);
    expect(existing.classList.contains("dp-skel-step")).toBe(false);
    expect(existing.querySelector("title")).toBeNull();
    // The accessible legend: each status in words.
    const legend = document.querySelector('[data-skel-legend="true"]')!;
    expect(legend.textContent).toContain("Step 1 · SKEL[1] · Pending");
    expect(legend.textContent).toContain("Step 2 · SKEL[2] · Filled");
    expect(legend.textContent).toContain("Step 3 · SKEL[2.1] · Active");
  });

  it("a checklist/code mismatch is visible on the node and in the legend", async () => {
    const steps = [{ ...STEPS[0]!, status: "done" }, STEPS[1]!, STEPS[2]!];
    render(<ArtifactVisuals artifactId="art_p" visuals={[DIAGRAM, SKELETON]} skeletonSteps={steps} />);
    await waitFor(() => expect(document.querySelector("g.dp-skel-step")).not.toBeNull());
    expect(node("step_1").querySelector("title")?.textContent).toContain("Marked done, but SKEL_TODO is still in the code");
    expect(document.querySelector('[data-skel-legend="true"]')!.textContent).toContain("⚠ Marked done, but SKEL_TODO is still in the code");
    // …and on the fence in the code view.
    expect(document.querySelector('[data-skel-mismatch="true"]')).not.toBeNull();
  });

  it("planStepNodeStates reads status from the code and never guesses a missing fence", () => {
    const states = planStepNodeStates([SKELETON], [...STEPS, { description: "Gone", skelId: "9", status: "pending" }]);
    expect(states["1"]).toMatchObject({ status: "pending", target: { filePath: "src/a.ts", line: 2 } });
    expect(states["2.1"]).toMatchObject({ status: "active", stepNumber: 3 });
    expect(states["9"]).toMatchObject({ status: "unknown", label: "Not in the code view" });
    expect(states["9"]!.target).toBeUndefined();
  });
});

describe("skeleton diagram — click to the fence", () => {
  it("a legend button scrolls to the fence's opening line (scrollIntoView, optional)", async () => {
    const scroll = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    render(<ArtifactVisuals artifactId="art_p" visuals={[DIAGRAM, SKELETON]} skeletonSteps={STEPS} />);
    await waitFor(() => expect(document.querySelector('[data-skel-legend-step="2.1"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-skel-legend-step="2.1"]')!);
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.instances.at(-1)).toBe(document.querySelector('[data-comment-anchor="line:src/a.ts:9"]'));
  });

  it("a plain click on a step node through the region overlay jumps; a drag still opens a region comment", async () => {
    const onJump = vi.fn();
    const states: Record<string, StepNodeState> = {
      "1": { skelId: "1", status: "pending", label: "Pending", stepNumber: 1, target: { filePath: "a.ts", line: 2 } },
    };
    render(<MermaidDiagram source={SOURCE} region={{ artifactId: "a", visualId: "arch" }} stepNodes={{ states, onJump }} />);
    await waitFor(() => expect(document.querySelector("g.dp-skel-step")).not.toBeNull());
    // Layout for the step node only (by attribute, so a re-render that swaps
    // the SVG DOM keeps it); everything else measures as zero, as in happy-dom.
    const zero = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const box = { ...zero, right: 100, bottom: 40, width: 100, height: 40 } as DOMRect;
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.getAttribute("data-skel-step") === "1" ? box : zero;
    });
    const overlay = screen.getByTestId("dp-region-overlay");
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 11, clientY: 10 });
    expect(onJump).toHaveBeenCalledWith("1");
    expect(screen.queryByText(/Commenting on/)).not.toBeInTheDocument();
    // Region comments are unchanged: a real drag opens the composer, no jump.
    onJump.mockClear();
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(overlay, { pointerId: 2, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(overlay, { pointerId: 2, clientX: 300, clientY: 200 });
    expect(screen.getByText(/Commenting on/)).toBeInTheDocument();
    expect(onJump).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("decorateStepNodes wires a direct click (read-only views) and its undo restores the node", () => {
    const host = document.createElement("div");
    host.innerHTML = SVG;
    const onJump = vi.fn();
    const states = planStepNodeStates([SKELETON], STEPS);
    const undo = decorateStepNodes(host, states, onJump);
    const g = host.querySelector('g[id$="flowchart-step_2_1-2"]')!;
    g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onJump).toHaveBeenCalledWith("2.1");
    undo();
    expect(g.classList.contains("dp-skel-step")).toBe(false);
    expect(g.querySelector("title")).toBeNull();
    expect(stepNodeAt(host, 0, 0)).toBeNull();
  });
});

describe("skeleton diagram — everything else unchanged", () => {
  it("a diagram with no step_ nodes renders exactly as before (no decoration, no legend)", async () => {
    renderMock.mockResolvedValue({ svg: "<svg aria-label='diagram'><g class='node' id='dp-mmd-1-2-flowchart-A-0'><text>A</text></g></svg>" });
    const plain: PlanVisual = { id: "d", kind: "diagram", source: "graph TD; A-->B" };
    render(<ArtifactVisuals artifactId="art_p" visuals={[plain, SKELETON]} skeletonSteps={STEPS} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(document.querySelector("g.dp-skel-step")).toBeNull();
    expect(document.querySelector('[data-skel-legend="true"]')).toBeNull();
  });

  it("a non-skeleton plan's diagram with step_-looking ids is untouched (no code view, no states)", async () => {
    render(<ArtifactVisuals artifactId="art_p" visuals={[DIAGRAM]} skeletonSteps={STEPS} />);
    await waitFor(() => expect(document.querySelector(".dp-mermaid svg")).not.toBeNull());
    expect(document.querySelector("g.dp-skel-step")).toBeNull();
    expect(document.querySelector('[data-skel-legend="true"]')).toBeNull();
  });

  it("step node keys: dots and dashes become underscores; the source check is whole-word", () => {
    expect(stepNodeKey("2.1")).toBe("step_2_1");
    expect(stepNodeKey("a-b")).toBe("step_a_b");
    expect(sourceHasStepNodes("graph TD; step_2_1-->X", ["2.1"])).toBe(true);
    expect(sourceHasStepNodes("graph TD; step_21-->X", ["2"])).toBe(false);
  });
});
