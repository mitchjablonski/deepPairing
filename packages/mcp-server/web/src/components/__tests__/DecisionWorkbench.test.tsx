import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #174 SLICE 1 — the focused decision WORKBENCH ("Expand to discuss").
 *
 * The clean card gains ONE "💬 Discuss" affordance; the expanded view lays the
 * options out side-by-side and makes every part commentable at the right grain
 * (optionId + sectionId, no schema change). Mermaid needs real layout, so we
 * mock it with an SVG carrying g.node elements — the same seam #173 uses.
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
  context: "Which session store should we use?",
  options: [
    {
      id: "o1",
      title: "Redis",
      description: "External cache with native TTL.",
      pros: ["Native per-key TTL"],
      cons: ["Adds an ops dependency"],
      effort: "medium" as const,
      risk: "low" as const,
      recommendation: true,
      concept: { name: "external cache service" },
      visuals: [{ id: "vis_arch", kind: "diagram" as const, title: "Architecture", source: "graph LR; AppServer-->Redis" }],
    },
    {
      id: "o2",
      title: "Postgres",
      description: "Reuse the primary DB.",
      pros: ["No new infrastructure"],
      cons: ["Needs a sweep job"],
      effort: "low" as const,
      risk: "low" as const,
      recommendation: false,
    },
    {
      id: "o3",
      title: "In-memory",
      description: "An LRU map in the process.",
      pros: ["Zero latency"],
      cons: ["Lost on restart"],
      effort: "low" as const,
      risk: "high" as const,
      recommendation: false,
    },
  ],
};

function seedGrainComment(over: { id: string; optionId?: string; sectionId?: string; content: string }) {
  useArtifactStore.getState().addComment({
    id: over.id,
    sessionId: "s",
    target: {
      artifactId: "art_dec",
      ...(over.optionId ? { optionId: over.optionId } : {}),
      ...(over.sectionId ? { sectionId: over.sectionId } : {}),
    },
    parentCommentId: null,
    author: "human",
    content: over.content,
    acknowledged: false,
    createdAt: "2026-07-18T00:00:00.000Z",
  } as any);
}

async function openWorkbench(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Expand to discuss/i }));
  return screen.findByTestId("decision-workbench");
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  renderMock.mockReset();
  renderMock.mockResolvedValue({ svg: TWO_NODE_SVG });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

describe("#174 — the Discuss affordance opens the workbench", () => {
  it("the card shows ONE Discuss affordance and opening it mounts the workbench dialog", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);

    // No workbench until asked (the card stays clean).
    expect(screen.queryByTestId("decision-workbench")).not.toBeInTheDocument();

    const dialog = await openWorkbench(user);
    // A real modal (useModal contract).
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("the Discuss badge shows a count when threads exist", () => {
    seedGrainComment({ id: "g1", optionId: "o1", sectionId: "pro:0", content: "love this" });
    seedGrainComment({ id: "g2", sectionId: "decision:question", content: "is this the right question?" });
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    expect(screen.getByRole("button", { name: /Expand to discuss — 2 comments/i })).toBeInTheDocument();
  });

  it("no Discuss affordance without an artifactId (nothing to anchor to)", () => {
    render(<DecisionCard event={event} decisionId="dec_store" />);
    expect(screen.queryByRole("button", { name: /Expand to discuss/i })).not.toBeInTheDocument();
  });
});

describe("#174 — options laid out side-by-side with their content", () => {
  it("renders every option as a column with summary, pros, cons and effort/risk chips", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    // All three options are present as columns (not a single vertical scroll).
    for (const title of ["Redis", "Postgres", "In-memory"]) {
      expect(within(dialog).getByRole("heading", { name: title })).toBeInTheDocument();
    }
    // Each option's content renders in the workbench.
    expect(within(dialog).getByText("Native per-key TTL")).toBeInTheDocument();
    expect(within(dialog).getByText("No new infrastructure")).toBeInTheDocument();
    expect(within(dialog).getByText(/effort: medium/)).toBeInTheDocument();
    // The recommended option is flagged (reuses the option.recommendation semantic).
    expect(within(dialog).getByText(/Recommended/)).toBeInTheDocument();
  });
});

describe("#174 — grain commenting anchors via optionId + sectionId", () => {
  it("commenting on a pro round-trips with target.optionId + target.sectionId", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    await openWorkbench(user);

    // Activate the pro's grain affordance → the rail composer opens for it.
    await user.click(screen.getByRole("button", { name: /Comment on Redis · pro/i }));
    const box = screen.getByRole("textbox", { name: /Comment on Redis · pro/i });
    await user.type(box, "this TTL is exactly what we need");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.target.optionId).toBe("o1");
    expect(body.target.sectionId).toBe("pro:0");
    expect(body.target.artifactId).toBe("art_dec");
  });

  it("commenting on the decision question anchors via sectionId only (no optionId)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    await user.click(within(dialog).getByRole("button", { name: /Comment on the decision question/i }));
    const box = screen.getByRole("textbox", { name: /Comment on the decision question/i });
    await user.type(box, "should we even be picking a store yet?");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.target.sectionId).toBe("decision:question");
    expect(body.target.optionId).toBeUndefined();
  });

  it("shows an existing grain thread, and the per-option comment count", async () => {
    seedGrainComment({ id: "g1", optionId: "o1", sectionId: "con:0", content: "how much ops really?" });
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    // The rail surfaces the existing thread and its body.
    expect(within(dialog).getByTestId("workbench-thread")).toBeInTheDocument();
    expect(within(dialog).getByText("how much ops really?")).toBeInTheDocument();
    // The per-option "N comments" indicator (nice-to-have) reflects the count.
    expect(within(dialog).getByTestId("option-comment-count")).toHaveTextContent("1");
  });
});

describe("#174 — the diagram zoom reuses #173's focused region view", () => {
  it("expanding an option's diagram stacks #173's DecisionDiagramFocus on the workbench", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    await waitFor(() => expect(document.querySelectorAll(".dp-mermaid svg").length).toBeGreaterThanOrEqual(1));

    await user.click(within(dialog).getByRole("button", { name: /Expand the Redis option's Architecture to comment/i }));

    // #173's focused view mounts on top (the two focused views STACK).
    const focus = await screen.findByTestId("decision-diagram-focus");
    expect(focus).toHaveAttribute("aria-label", expect.stringContaining("Redis"));
    // …and the workbench is still mounted behind it.
    expect(screen.getByTestId("decision-workbench")).toBeInTheDocument();
  });
});

describe("#174 — decision-level actions work from the workbench", () => {
  it("Choose resolves the decision (reuses the card's onSelect) and collapses the workbench", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    await user.click(within(dialog).getByRole("button", { name: /Choose Redis/i }));

    // The decision resolved through the shared handler…
    await waitFor(() =>
      expect(useArtifactStore.getState().resolvedDecisions["dec_store"]?.optionId).toBe("o1"),
    );
    // …and the workbench collapsed (the card behind shows the resolved state).
    await waitFor(() => expect(screen.queryByTestId("decision-workbench")).not.toBeInTheDocument());
  });

  it("the send-back escape hatch is reachable in the workbench footer", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    // DecisionFooter is reused verbatim — its "None of these fit" trigger is here.
    expect(within(dialog).getByRole("button", { name: /Send decision back for revised options/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Reject this framing/i })).toBeInTheDocument();
  });

  it("Esc collapses the workbench (useModal contract)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    await openWorkbench(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("decision-workbench")).not.toBeInTheDocument());
  });
});
