import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Comment } from "@deeppairing/shared";
import { DecisionCard } from "../DecisionCard";
import { computeCarryover } from "../decision/DecisionWorkbench";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #177 SLICE 2a — version-aware thread carryover markers (CARRIED / STALE /
 * ORPHAN). A grain thread already RENDERS on v2 (useChainComments aggregates the
 * version chain on read); this slice makes the carry HONEST with a read-side
 * marker derived from the chain + the live v2 options — NO persisted field.
 *
 * Mermaid needs real layout in jsdom, so we mock it (the same seam #173/#174
 * tests use) even though these fixtures carry no diagram.
 */
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) } }));

// --- fixtures ---------------------------------------------------------------

const o1v1 = { id: "o1", title: "Redis", description: "External cache with native TTL.", pros: ["Native per-key TTL"], cons: ["Adds an ops dependency"], effort: "medium" as const, risk: "low" as const, recommendation: true };
const o1v2same = { ...o1v1 };
const o1v2reword = { ...o1v1, description: "Managed cache with a native TTL." };
const o1v2retitle = { ...o1v1, title: "Redis (managed)" };

function decArt(id: string, version: number, parentId: string | null, options: unknown[]): Artifact {
  return {
    id, sessionId: "s", type: "decision", version, parentId,
    title: "t", status: parentId ? "active" : "superseded",
    content: { context: "c", decisionId: "d", options },
    agentReasoning: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Artifact;
}

let cid = 0;
function cmt(artifactId: string, optionId?: string, sectionId?: string): Comment {
  return {
    id: `c${cid++}`, sessionId: "s",
    target: { artifactId, ...(optionId ? { optionId } : {}), ...(sectionId ? { sectionId } : {}) },
    parentCommentId: null, author: "human", content: "x", acknowledged: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Comment;
}

const V1 = "art_dec_v1";
const V2 = "art_dec_v2";
const liveOptions = [o1v2same]; // default: o1 survives unchanged

describe("#177 — computeCarryover is a pure, READ-side derivation from the version chain", () => {
  it("CARRIED: a cross-version summary thread whose anchored text is UNCHANGED", () => {
    const state = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2same])],
      thread: [cmt(V1, "o1", "summary")],
      currentArtifactId: V2,
      anchor: { optionId: "o1", sectionId: "summary" },
      liveOptions: [o1v2same],
    });
    expect(state).toEqual({ kind: "carried", from: 1, to: 2 });
  });

  it("STALE: the SAME comment turns stale when the v2 summary text CHANGED (proof it's read-side, not persisted)", () => {
    // Identical thread + identical v1 artifact; ONLY the current-version content
    // differs between the two calls. The result flips carried→stale purely from
    // the artifact content — nothing is read off the comment. That is the whole
    // "read-side text diff, no persisted field" contract.
    const thread = [cmt(V1, "o1", "summary")];
    const carried = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2same])],
      thread, currentArtifactId: V2, anchor: { optionId: "o1", sectionId: "summary" }, liveOptions: [o1v2same],
    });
    const stale = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2reword])],
      thread, currentArtifactId: V2, anchor: { optionId: "o1", sectionId: "summary" }, liveOptions: [o1v2reword],
    });
    expect(carried.kind).toBe("carried");
    expect(stale).toEqual({ kind: "stale", from: 1, to: 2, procon: false });
    // The comment object is untouched by either call — no carryover field.
    expect((thread[0] as unknown as Record<string, unknown>).carryover).toBeUndefined();
  });

  it("ORPHAN: a cross-version thread whose option id no longer matches any live v2 part", () => {
    const state = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [])],
      thread: [cmt(V1, "o1", "summary")],
      currentArtifactId: V2,
      anchor: { optionId: "o1", sectionId: "summary" },
      liveOptions: [], // o1 removed in v2
    });
    expect(state).toEqual({ kind: "orphan", from: 1 });
  });

  it("the decision QUESTION carries UNCONDITIONALLY (a permanent part of the decision)", () => {
    const state = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2reword])],
      thread: [cmt(V1, undefined, "decision:question")],
      currentArtifactId: V2,
      anchor: { sectionId: "decision:question" },
      liveOptions,
    });
    expect(state).toEqual({ kind: "carried", from: 1, to: 2 });
  });

  it("PRO/CON: a cross-version pro/con is STALE/uncertain (procon flag) — NEVER confident CARRIED", () => {
    const state = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2same])],
      thread: [cmt(V1, "o1", "pro:0")],
      currentArtifactId: V2,
      anchor: { optionId: "o1", sectionId: "pro:0" },
      liveOptions: [o1v2same], // option UNCHANGED — still never green for a positional grain
    });
    expect(state).toEqual({ kind: "stale", from: 1, to: 2, procon: true });
  });

  it("NONE: a thread native to the current version gets no marker", () => {
    const state = computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2same])],
      thread: [cmt(V2, "o1", "summary")], // posted on the CURRENT version
      currentArtifactId: V2,
      anchor: { optionId: "o1", sectionId: "summary" },
      liveOptions: [o1v2same],
    });
    expect(state).toEqual({ kind: "none" });
  });

  it("WHOLE-OPTION: carried when the option title is unchanged, stale when retitled", () => {
    const base = { artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2same])], thread: [cmt(V1, "o1")], currentArtifactId: V2, anchor: { optionId: "o1" } };
    expect(computeCarryover({ ...base, liveOptions: [o1v2same] }).kind).toBe("carried");
    expect(computeCarryover({
      artifacts: [decArt(V1, 1, null, [o1v1]), decArt(V2, 2, V1, [o1v2retitle])],
      thread: [cmt(V1, "o1")], currentArtifactId: V2, anchor: { optionId: "o1" }, liveOptions: [o1v2retitle],
    })).toEqual({ kind: "stale", from: 1, to: 2, procon: false });
  });
});

// --- mount: the markers render on the rail threads --------------------------

const eventV2 = {
  type: "decision_request" as const,
  decisionId: "dec_store",
  context: "Which session store should we use?",
  options: [
    { ...o1v2same }, // o1 Redis unchanged → CARRIED
    { id: "o2", title: "Postgres", description: "Reuse the primary Postgres DB and add a sweep job.", pros: ["No new infrastructure"], cons: ["Needs a sweep job"], effort: "low" as const, risk: "low" as const, recommendation: false }, // reworded → STALE
    // o3 In-memory REMOVED → its v1 threads ORPHAN
  ],
};

const o2v1 = { id: "o2", title: "Postgres", description: "Reuse the primary DB.", pros: ["No new infrastructure"], cons: ["Needs a sweep job"], effort: "low" as const, risk: "low" as const, recommendation: false };
const o3v1 = { id: "o3", title: "In-memory", description: "An LRU map in the process.", pros: ["Zero latency"], cons: ["Lost on restart"], effort: "low" as const, risk: "high" as const, recommendation: false };

function seedChain() {
  const store = useArtifactStore.getState();
  store.addArtifact(decArt(V1, 1, null, [o1v1, o2v1, o3v1]));
  store.addArtifact(decArt(V2, 2, V1, eventV2.options));
  // v1 grain threads
  store.addComment(cmt(V1, "o1", "summary")); // CARRIED
  store.addComment(cmt(V1, "o2", "summary")); // STALE (reworded)
  store.addComment(cmt(V1, "o3", "summary")); // ORPHAN (option removed)
  store.addComment(cmt(V1, undefined, "decision:question")); // CARRIED
  store.addComment(cmt(V1, "o1", "pro:0")); // STALE procon
  store.addComment(cmt(V1, "o1")); // whole-option CARRIED
  // a native v2 thread (no marker)
  store.addComment(cmt(V2, "o1", "con:0"));
}

async function openWorkbench(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Expand to discuss/i }));
  return screen.findByTestId("decision-workbench");
}

function threadContaining(dialog: HTMLElement, sub: string): HTMLElement {
  const t = within(dialog).getAllByTestId("workbench-thread").find((el) => el.textContent?.includes(sub));
  if (!t) throw new Error(`no rail thread containing "${sub}"`);
  return t;
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  cid = 0;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

describe("#177 — the carryover markers render on the workbench rail threads", () => {
  it("CARRIED (green) on an unchanged option summary — badge 'CARRIED v1→v2'", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    const thread = threadContaining(dialog, "Redis · summary");
    const badge = within(thread).getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "carried");
    expect(badge).toHaveTextContent(/CARRIED v1→v2/);
  });

  it("STALE (amber) on a reworded option summary — 'does your comment still apply?'", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    const thread = threadContaining(dialog, "Postgres · summary");
    const badge = within(thread).getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "stale");
    expect(badge).toHaveTextContent(/does your comment still apply/i);
  });

  it("ORPHAN (red) on a removed option — explicit 'no longer in this decision', NO raw-id label", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    // The orphan thread names the grain type generically — never the raw option id.
    const orphanLabel = within(dialog).getByTestId("orphan-label");
    expect(orphanLabel).toHaveTextContent("an option summary");
    const thread = orphanLabel.closest('[data-testid="workbench-thread"]') as HTMLElement;
    expect(thread).toBeTruthy();
    // The confusing raw-id degraded label ("o3 · summary") must be gone.
    expect(thread.textContent).not.toContain("o3");
    const badge = within(thread).getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "orphan");
    expect(badge).toHaveTextContent(/no longer in this decision/i);
  });

  it("the decision QUESTION thread is CARRIED unconditionally", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    const thread = threadContaining(dialog, "the decision question");
    expect(within(thread).getByTestId("carryover-badge")).toHaveAttribute("data-carryover", "carried");
  });

  it("a PRO/CON cross-version thread is STALE/uncertain — never confident CARRIED", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    const thread = threadContaining(dialog, "Redis · pro");
    const badge = within(thread).getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "stale");
    expect(badge).toHaveTextContent(/the list may have changed/i);
    expect(badge).not.toHaveTextContent(/CARRIED/);
  });

  it("a NATIVE v2 thread shows NO carryover marker", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    const thread = threadContaining(dialog, "Redis · con");
    expect(within(thread).queryByTestId("carryover-badge")).not.toBeInTheDocument();
  });

  it("the whole-option pop-out inline composer carries its marker too", async () => {
    seedChain();
    const user = userEvent.setup();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const dialog = await openWorkbench(user);

    // Pop out o1 (Redis) — its whole-option thread (title unchanged) is CARRIED,
    // and the marker shows above the persistent inline composer.
    await user.click(within(dialog).getAllByTestId("option-popout")[0]!);
    const focused = within(dialog).getByTestId("workbench-focused-option");
    const badge = within(focused).getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "carried");
  });
});
