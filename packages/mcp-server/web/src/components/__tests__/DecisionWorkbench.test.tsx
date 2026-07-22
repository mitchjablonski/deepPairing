import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
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

  it("the badge count matches the rail: a #173 diagram-REGION comment is NOT counted", () => {
    // Region comments carry optionId but live in the nested diagram view, not
    // the workbench rail (isGrainComment excludes them). The card badge must
    // agree with the rail — a region-only decision shows NO count, not "1".
    useArtifactStore.getState().addComment({
      id: "reg1",
      sessionId: "s",
      target: {
        artifactId: "art_dec",
        optionId: "o1",
        visualId: "vis_arch",
        region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, labels: ["App Server"] },
      },
      parentCommentId: null,
      author: "human",
      content: "why straight to Redis?",
      acknowledged: false,
      createdAt: "2026-07-18T00:00:00.000Z",
    } as any);
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    // No count in the label (discussCount 0), and no count badge rendered.
    expect(screen.getByRole("button", { name: "Expand to discuss this decision" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expand to discuss — /i })).not.toBeInTheDocument();
  });

  it("a grain comment IS counted alongside a region comment (only the grain one)", () => {
    // Region comment (not counted) + one grain comment (counted) → badge "1".
    useArtifactStore.getState().addComment({
      id: "reg1",
      sessionId: "s",
      target: { artifactId: "art_dec", optionId: "o1", visualId: "vis_arch", region: { x: 0, y: 0, w: 0.1, h: 0.1, labels: ["Redis"] } },
      parentCommentId: null,
      author: "human",
      content: "region note",
      acknowledged: false,
      createdAt: "2026-07-18T00:00:00.000Z",
    } as any);
    seedGrainComment({ id: "g1", optionId: "o1", sectionId: "pro:0", content: "grain note" });
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    expect(screen.getByRole("button", { name: /Expand to discuss — 1 comment$/i })).toBeInTheDocument();
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

describe("workbench interaction pass — the comment rail COLLAPSES until there's discussion", () => {
  it("with no comments and no active anchor, the rail is NOT rendered (options get the full width)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    // Empty deliberation → no rail (before this pass an empty 384px rail
    // squished the columns).
    expect(within(dialog).queryByTestId("decision-workbench-rail")).not.toBeInTheDocument();
  });

  it("activating a part (its 💬 affordance) slides the rail in with that composer", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    expect(within(dialog).queryByTestId("decision-workbench-rail")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Comment on the decision question/i }));
    // Now there's a live composer → the rail claims its column.
    expect(within(dialog).getByTestId("decision-workbench-rail")).toBeInTheDocument();
  });

  it("a pre-existing grain comment renders the rail on open (a thread exists to show)", async () => {
    seedGrainComment({ id: "g1", optionId: "o1", sectionId: "pro:0", content: "love this TTL" });
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    expect(within(dialog).getByTestId("decision-workbench-rail")).toBeInTheDocument();
  });
});

describe("workbench interaction pass — per-option ⤢ pop-out (focus one option full-width)", () => {
  it("clicking an option's ⤢ shows ONLY that option; 'Back to all options' returns to the grid", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    // The compare grid shows every option, each with a pop-out button.
    const popouts = within(dialog).getAllByTestId("option-popout");
    expect(popouts).toHaveLength(3);
    expect(within(dialog).getByRole("heading", { name: "Postgres" })).toBeInTheDocument();

    // Pop out the FIRST option (Redis, o1) → only it remains, full-width.
    await user.click(popouts[0]!);
    const focused = within(dialog).getByTestId("workbench-focused-option");
    expect(within(focused).getByRole("heading", { name: "Redis" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Postgres" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "In-memory" })).not.toBeInTheDocument();
    // The focused column doesn't offer to focus itself (no pop-out button in it).
    expect(within(dialog).queryByTestId("option-popout")).not.toBeInTheDocument();

    // Back returns to the full compare grid.
    await user.click(within(dialog).getByRole("button", { name: /Back to all options/i }));
    expect(within(dialog).queryByTestId("workbench-focused-option")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Postgres" })).toBeInTheDocument();
    expect(within(dialog).getAllByTestId("option-popout")).toHaveLength(3);
  });

  it("the pop-out inline composer posts a WHOLE-OPTION comment (bare optionId, NO sectionId, roomy)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    await user.click(within(dialog).getAllByTestId("option-popout")[0]!);

    // The persistent inline composer is anchored to the OPTION itself — its
    // textarea's accessible name is the bare option title (no "· pro/con").
    const box = within(dialog).getByRole("textbox", { name: "Comment on Redis" });
    await user.type(box, "managed Redis is basically zero ops though");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.target.optionId).toBe("o1");
    expect(body.target.sectionId).toBeUndefined();
    expect(body.target.artifactId).toBe("art_dec");
  });

  it("GRID mode: a whole-option comment stays in the rail (its thread) — the head 💬 is the grid's whole-option entry point", async () => {
    // optionId, NO sectionId → key "o1|". In the compare GRID this is NOT
    // filtered out: the rail is the whole-option surface here (mode-coherent
    // with the pop-out, where the inline composer owns it).
    seedGrainComment({ id: "wo1", optionId: "o1", content: "whole-option note here" });
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    expect(within(dialog).getByTestId("decision-workbench-rail")).toBeInTheDocument();
    const thread = within(dialog).getByTestId("workbench-thread");
    expect(within(thread).getByText("whole-option note here")).toBeInTheDocument();
  });

  it("POP-OUT mode: a whole-option comment renders EXACTLY ONCE (inline) — no rail double-show (reviewer's 2-render repro)", async () => {
    // Pop out an option that already has a whole-option comment. Pre-fix, the
    // focused column still rendered the head whole-option 💬 whose activeAnchor
    // re-added the bare-option key to the rail → the SAME comment rendered twice
    // (inline composer + rail). Fix: suppress the head 💬 in the focused column
    // and exclude "opt|" keys from the rail in pop-out — inline is the sole
    // whole-option surface, so it shows once.
    seedGrainComment({ id: "wo1", optionId: "o1", content: "whole-option note here" });
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    await user.click(within(dialog).getAllByTestId("option-popout")[0]!);
    const focused = within(dialog).getByTestId("workbench-focused-option");

    // The head whole-option 💬 (the double-show trigger) is gone in the pop-out.
    expect(within(focused).queryByRole("button", { name: /whole option/i })).not.toBeInTheDocument();
    // The comment renders exactly once (inline), and the rail doesn't double it.
    expect(within(dialog).getAllByText("whole-option note here")).toHaveLength(1);
    expect(within(dialog).queryByTestId("decision-workbench-rail")).not.toBeInTheDocument();
  });
});

describe("workbench interaction pass — layered Esc + click-to-comment rows", () => {
  it("layered Esc: from a popped-out option Esc returns to the grid (stays OPEN); from the grid Esc closes", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    await user.click(within(dialog).getAllByTestId("option-popout")[0]!);
    expect(within(dialog).getByTestId("workbench-focused-option")).toBeInTheDocument();

    // Esc #1 (focusedOptionId set) — un-focus back to the compare grid; the
    // workbench must STAY open (onClose NOT called). Fire on the panel directly
    // so the assertion doesn't hinge on where focus landed after the unmount.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByTestId("decision-workbench")).toBeInTheDocument();
    expect(screen.queryByTestId("workbench-focused-option")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("decision-workbench")).getByRole("heading", { name: "Postgres" })).toBeInTheDocument();

    // Esc #2 (no focusedOptionId) — delegates to useModal's onKeyDown → onClose.
    fireEvent.keyDown(screen.getByTestId("decision-workbench"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("decision-workbench")).not.toBeInTheDocument());
  });

  it("clicking a con ROW opens that anchor's composer with the EXACT anchor {optionId, sectionId} (a #187 payload, not a MouseEvent)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);

    // Click the con ROW text itself (the clickable div), NOT the 💬 button.
    await user.click(within(dialog).getByText("Adds an ops dependency"));

    // The row dispatched the exact grain anchor, so the rail opened THIS
    // composer (labelled for Redis · con). A MouseEvent-as-anchor bug would open
    // a bare "option" composer and the POST would carry no optionId/sectionId.
    const box = within(dialog).getByRole("textbox", { name: /Comment on Redis · con/i });
    await user.type(box, "how much ops really?");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((fetch as any).mock.calls.at(-1)[1].body);
    expect(body.target.optionId).toBe("o1");
    expect(body.target.sectionId).toBe("con:0");
    expect(body.target.artifactId).toBe("art_dec");
  });

  it("the 💬 row button still works as the keyboard/SR trigger (click-to-comment is additive)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    // The explicit button path opens the same composer as the row click.
    await user.click(within(dialog).getByRole("button", { name: /Comment on Redis · pro/i }));
    expect(within(dialog).getByRole("textbox", { name: /Comment on Redis · pro/i })).toBeInTheDocument();
  });

  it("← Back clears a section composer activated while popped out (no stray rail lingering in the grid)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    await user.click(within(dialog).getAllByTestId("option-popout")[0]!);
    const focused = within(dialog).getByTestId("workbench-focused-option");

    // Activate a SECTION composer while popped out → the rail opens alongside.
    await user.click(within(focused).getByText("Adds an ops dependency"));
    expect(within(dialog).getByTestId("decision-workbench-rail")).toBeInTheDocument();

    // Back to the grid — activeAnchor is cleared too, so the composer doesn't
    // linger as a stray rail over the compare grid (pre-fix it would).
    await user.click(within(dialog).getByRole("button", { name: /Back to all options/i }));
    expect(within(dialog).queryByTestId("workbench-focused-option")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("decision-workbench-rail")).not.toBeInTheDocument();
  });

  it("the workbench modal is the wider 1280px surface", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_store" artifactId="art_dec" />);
    const dialog = await openWorkbench(user);
    expect(dialog.className).toContain("max-w-[1280px]");
  });
});
