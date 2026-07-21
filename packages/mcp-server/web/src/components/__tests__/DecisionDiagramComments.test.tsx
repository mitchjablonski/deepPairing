import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #173 — region comments on decision diagrams via the FOCUSED VIEW.
 *
 * The compare grid stays read-only; expanding a diagram opens a full-width
 * dialog where the region layer goes live and a comment anchors to
 * optionId + visualId + region together. Mermaid needs real layout, so we mock
 * it with an SVG carrying real g.node elements (same seam as
 * DiagramRegionLayer.test) — the KEYBOARD node-pick path gives deterministic
 * labels without geometry (happy-dom returns all-zero rects).
 */
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderMock } }));

const TWO_NODE_SVG =
  "<svg aria-label='diagram'>" +
  "<g class='node' id='dp-mmd-5-6-flowchart-AppServer-0'><text>App Server</text></g>" +
  "<g class='node' id='dp-mmd-5-6-flowchart-Redis-1'><text>Redis</text></g>" +
  "</svg>";

const event = {
  type: "decision_request" as const,
  decisionId: "dec_store",
  context: "Which session store?",
  options: [
    {
      id: "o1",
      title: "Redis",
      description: "External cache",
      pros: ["fast"],
      cons: ["ops"],
      effort: "low" as const,
      risk: "low" as const,
      recommendation: true,
      visuals: [{ id: "vis_arch", kind: "diagram" as const, title: "Architecture", source: "graph LR; AppServer-->Redis" }],
    },
    {
      id: "o2",
      title: "Postgres",
      description: "In the DB",
      pros: ["durable"],
      cons: ["slower"],
      effort: "low" as const,
      risk: "low" as const,
      recommendation: false,
      visuals: [{ id: "vis_pg", kind: "diagram" as const, title: "Architecture", source: "graph LR; AppServer-->Postgres" }],
    },
  ],
};

function seedRegionComment(over: { id: string; optionId: string; visualId: string; content: string }) {
  useArtifactStore.getState().addComment({
    id: over.id,
    sessionId: "s",
    target: {
      artifactId: "art_dec",
      optionId: over.optionId,
      visualId: over.visualId,
      region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2, elementIds: ["dp-mmd-1-2-flowchart-AppServer-0"], labels: ["App Server"] },
    },
    parentCommentId: null,
    author: "human",
    content: over.content,
    acknowledged: false,
    createdAt: "2026-07-18T00:00:00.000Z",
  } as any);
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: TWO_NODE_SVG });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

describe("#173 — decision diagram region comments (focused view)", () => {
  it("the compare grid stays READ-ONLY: no drag overlay in the cells, but an Expand-to-comment affordance", async () => {
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    // Both option diagrams render in the grid (mermaid mocked).
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(2));
    // Grid cells are read-only — the region drag overlay is NOT mounted there.
    expect(screen.queryByTestId("dp-region-overlay")).not.toBeInTheDocument();
    // …but each diagram cell offers the expand affordance.
    expect(
      screen.getByRole("button", { name: /Expand the Redis option's Architecture to comment/i }),
    ).toBeInTheDocument();
  });

  it("clicking Expand opens the focused dialog and mounts the LIVE region layer (readOnly off)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(2));

    // No dialog / no region layer yet.
    expect(screen.queryByTestId("decision-diagram-focus")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dp-region-overlay")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Expand the Redis option's Architecture to comment/i }));

    // The dialog is a real modal, and its diagram has the LIVE region layer.
    const dialog = await screen.findByTestId("decision-diagram-focus");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByTestId("dp-region-overlay")).toBeInTheDocument());
    // The dialog names the option + diagram (accessible name + breadcrumb).
    expect(dialog).toHaveAttribute("aria-label", expect.stringContaining("Redis"));
    expect(within(dialog).getByText(/Architecture/)).toBeInTheDocument();
    // The keyboard node-pick affordance (the accessible drag equivalent) is live.
    expect(screen.getByText(/comment on a node/i)).toBeInTheDocument();
  });

  it("round-trips a region comment anchored to optionId + visualId + region (keyboard node pick)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByRole("button", { name: /Expand the Redis option's Architecture to comment/i }));
    await screen.findByTestId("decision-diagram-focus");

    // Drive the keyboard path: reveal node list, pick a node, type + send.
    await user.click(screen.getByText(/comment on a node/i));
    const appBtn = screen.getByRole("button", { name: "App Server" });
    appBtn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/Commenting on \[App Server\]/)).toBeInTheDocument();

    const box = screen.getByPlaceholderText(/add a comment/i);
    await user.type(box, "why straight to Redis?");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    // The anchor carries all three: optionId + visualId + region (labels).
    expect(body.target.optionId).toBe("o1");
    expect(body.target.visualId).toBe("vis_arch");
    expect(body.target.region.labels).toEqual(["App Server"]);
    expect(body.target.artifactId).toBe("art_dec");
  });

  it("re-opening shows the existing region comment, SCOPED to its option", async () => {
    // One comment on o1's diagram, one on o2's — same visualId collision guard:
    // the o1 focused view must show only o1's.
    seedRegionComment({ id: "rc_o1", optionId: "o1", visualId: "vis_arch", content: "redis note" });
    seedRegionComment({ id: "rc_o2_same_vis", optionId: "o2", visualId: "vis_arch", content: "cross-option note" });

    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByRole("button", { name: /Expand the Redis option's Architecture to comment/i }));
    await screen.findByTestId("decision-diagram-focus");

    // The o1 comment shows (its region highlight + text referent redraw);
    // scoping means EXACTLY one region — the o2 comment (same visualId,
    // different optionId) is filtered out, not double-drawn.
    await waitFor(() => expect(screen.getByText(/on region \[App Server\]/)).toBeInTheDocument());
    expect(screen.getAllByTestId("dp-region-highlight")).toHaveLength(1);

    // Open the thread on the redrawn region → its body is o1's, never o2's.
    await user.click(screen.getByRole("button", { name: /on region \[App Server\]/ }));
    expect(await screen.findByText(/redis note/)).toBeInTheDocument();
    expect(screen.queryByText(/cross-option note/)).not.toBeInTheDocument();
  });

  it("Esc / Back-to-compare closes the focused view and returns to the grid", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByRole("button", { name: /Expand the Redis option's Architecture to comment/i }));
    await screen.findByTestId("decision-diagram-focus");

    await user.click(screen.getByRole("button", { name: /Back to compare diagrams/i }));
    await waitFor(() => expect(screen.queryByTestId("decision-diagram-focus")).not.toBeInTheDocument());
    // The region layer is gone with it; the grid is back to read-only.
    expect(screen.queryByTestId("dp-region-overlay")).not.toBeInTheDocument();
  });

  it("no Expand affordance without a real artifactId (nothing to anchor a comment to)", async () => {
    render(<DecisionCard event={event} decisionId="dec_store" />);
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("button", { name: /Expand.*to comment/i })).not.toBeInTheDocument();
  });
});
