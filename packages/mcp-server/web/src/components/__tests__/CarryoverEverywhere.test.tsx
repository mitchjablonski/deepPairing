import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import type { Artifact, Comment } from "@deeppairing/shared";
import { DecisionCard } from "../DecisionCard";
import { OptionCard } from "../decision/OptionCard";
import { DecisionGeneralComments } from "../decision/DecisionGeneralComments";
import { ArtifactDetail } from "../ArtifactPanel";
import type { DecisionOption } from "../decision/types";
// Single-source proof: the workbench re-exports the SAME references the new
// surfaces import from the shared modules (no forked copy).
import {
  computeCarryover as ccWorkbench,
  CarryoverBadge as badgeWorkbench,
} from "../decision/DecisionWorkbench";
import { computeCarryover as ccShared, optionCarryover } from "../decision/carryover";
import { CarryoverBadge as badgeShared } from "../decision/CarryoverBadge";
import { useArtifactStore } from "../../stores/artifact";

/**
 * #180 (fast-follow to #177 slice 2a) — the version-aware thread carryover
 * markers (CARRIED / STALE / ORPHAN), extracted to a SHARED module, now render
 * on the DEFAULT decision surfaces too: DecisionCard's inline OptionCards and
 * the ArtifactPanel decision-comment thread — not only inside the Discuss
 * workbench. Reuses the existing carryover tests' seeded superseded-decision
 * pattern (decArt / cmt / a v1→v2 chain via useChainComments).
 *
 * Mermaid needs real layout in jsdom, so we mock it (the seam the #173/#174/#177
 * tests use) even though these fixtures carry no diagram.
 */
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg/>" }) } }));

// --- fixtures (a superseded v1 → v2 chain) ----------------------------------

const A_v1 = { id: "a", title: "Redis", description: "External cache with native TTL.", pros: ["Native per-key TTL"], cons: ["Adds an ops dependency"], effort: "medium" as const, risk: "low" as const, recommendation: true };
const A_v2 = { ...A_v1 };                                            // unchanged → CARRIED
const B_v1 = { id: "b", title: "Postgres", description: "Reuse the primary DB.", pros: ["No new infra"], cons: ["Needs a sweep"], effort: "low" as const, risk: "low" as const, recommendation: false };
const B_v2 = { ...B_v1, description: "Reuse the primary Postgres DB and add a sweep job." }; // reworded → STALE
const C_v1 = { id: "c", title: "In-memory", description: "An LRU map in the process.", pros: ["Zero latency"], cons: ["Lost on restart"], effort: "low" as const, risk: "high" as const, recommendation: false }; // removed in v2 → ORPHAN
const D_v1 = { id: "d", title: "Memcached", description: "External memcached.", pros: ["Simple"], cons: ["No persistence"], effort: "low" as const, risk: "low" as const, recommendation: false };
const D_v2 = { ...D_v1 };                                            // unchanged, but a POSITIONAL pro comment → STALE (never green)

const V1 = "art_dec_v1";
const V2 = "art_dec_v2";

function decArt(id: string, version: number, parentId: string | null, options: unknown[]): Artifact {
  return {
    id, sessionId: "s", type: "decision", version, parentId,
    title: "Pick a store", status: parentId ? "active" : "superseded",
    content: { context: "Which session store should we use?", decisionId: "dec_store", options },
    agentReasoning: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Artifact;
}

let cid = 0;
function cmt(artifactId: string, content: string, optionId?: string, sectionId?: string): Comment {
  return {
    id: `c${cid++}`, sessionId: "s",
    target: { artifactId, ...(optionId ? { optionId } : {}), ...(sectionId ? { sectionId } : {}) },
    parentCommentId: null, author: "human", content, acknowledged: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Comment;
}

const CARRIED_A = "TTL is exactly what we need";
const STALE_B = "does the sweep run often enough?";
const ORPHAN_C = "restart loss is a dealbreaker";
const CARRIED_Q = "are we sure we need a store at all?";
const PROCON_D = "this pro is what sold me";

const eventV2 = {
  type: "decision_request" as const,
  decisionId: "dec_store",
  context: "Which session store should we use?",
  options: [A_v2, B_v2, D_v2],
};

/** Seed the superseded v1 → v2 chain + the v1-anchored grain threads that carry
 *  forward onto v2 via useChainComments. */
function seedChain() {
  const store = useArtifactStore.getState();
  store.addArtifact(decArt(V1, 1, null, [A_v1, B_v1, C_v1, D_v1]));
  store.addArtifact(decArt(V2, 2, V1, eventV2.options));
  store.addComment(cmt(V1, CARRIED_A, "a", "summary")); // CARRIED (a unchanged)
  store.addComment(cmt(V1, STALE_B, "b", "summary"));    // STALE (b reworded)
  store.addComment(cmt(V1, ORPHAN_C, "c", "summary"));   // ORPHAN (c removed)
  store.addComment(cmt(V1, CARRIED_Q, undefined, "decision:question")); // CARRIED (permanent)
  store.addComment(cmt(V1, PROCON_D, "d", "pro:0"));     // STALE procon (never green)
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  cid = 0;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }));
});

// --- single-source (no logic drift) -----------------------------------------

describe("#180 — the carryover read-model + marker are SINGLE-SOURCE", () => {
  it("the workbench and the shared module export the SAME computeCarryover + CarryoverBadge (not a fork)", () => {
    expect(ccWorkbench).toBe(ccShared);
    expect(badgeWorkbench).toBe(badgeShared);
  });

  it("optionCarryover reuses computeCarryover — a carried option summary is carried, a reworded one is stale", () => {
    const artifacts = [decArt(V1, 1, null, [A_v1, B_v1]), decArt(V2, 2, V1, [A_v2, B_v2])];
    const carried = optionCarryover({ artifacts, comments: [cmt(V1, CARRIED_A, "a", "summary")], currentArtifactId: V2, option: A_v2 });
    const stale = optionCarryover({ artifacts, comments: [cmt(V1, STALE_B, "b", "summary")], currentArtifactId: V2, option: B_v2 });
    expect(carried.kind).toBe("carried");
    expect(stale.kind).toBe("stale");
    // A positional pro/con NEVER resolves confident-green, even on an unchanged option.
    const procon = optionCarryover({ artifacts, comments: [cmt(V1, PROCON_D, "a", "pro:0")], currentArtifactId: V2, option: A_v2 });
    expect(procon.kind).toBe("stale");
  });
});

// --- OptionCard (the inline compare card, a DEFAULT surface) ----------------

function renderOptionCard(option: DecisionOption) {
  return render(
    <OptionCard
      option={option}
      index={0}
      focused={false}
      submitting={false}
      artifactId={V2}
      onSelect={() => {}}
      onFocus={() => {}}
      selectButtonRef={() => {}}
    />,
  );
}

describe("#180 — OptionCard shows the carryover marker on the inline compare card", () => {
  it("CARRIED (green) on an option whose summary carried unchanged", () => {
    seedChain();
    renderOptionCard(A_v2);
    const badge = screen.getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "carried");
    expect(badge).toHaveTextContent(/CARRIED v1→v2/);
  });

  it("STALE (amber) on an option whose summary was reworded", () => {
    seedChain();
    renderOptionCard(B_v2);
    const badge = screen.getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "stale");
    expect(badge).toHaveTextContent(/does your comment still apply/i);
  });

  it("a pro/con thread is STALE/uncertain — NEVER confident CARRIED", () => {
    seedChain();
    renderOptionCard(D_v2); // D is unchanged, but carries a positional pro comment
    const badge = screen.getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "stale");
    expect(badge).toHaveTextContent(/the list may have changed/i);
    expect(badge).not.toHaveTextContent(/CARRIED/);
  });

  it("NO marker when the option has no cross-version thread", () => {
    // Fresh v2-native comment only → nothing carried.
    const store = useArtifactStore.getState();
    store.addArtifact(decArt(V1, 1, null, [A_v1]));
    store.addArtifact(decArt(V2, 2, V1, [A_v2]));
    store.addComment(cmt(V2, "native", "a", "summary")); // posted on the CURRENT version
    renderOptionCard(A_v2);
    expect(screen.queryByTestId("carryover-badge")).not.toBeInTheDocument();
  });
});

// --- DecisionCard (the inline card renders the OptionCards) ------------------

describe("#180 — DecisionCard surfaces the markers through its inline OptionCards", () => {
  it("shows a carried + two stale markers (no workbench open)", () => {
    seedChain();
    render(<DecisionCard event={eventV2} decisionId="dec_store" artifactId={V2} />);
    const badges = screen.getAllByTestId("carryover-badge");
    const kinds = badges.map((b) => b.getAttribute("data-carryover")).sort();
    // A carried, B stale, D stale (pro). C is removed → not rendered as a card.
    expect(kinds).toEqual(["carried", "stale", "stale"]);
    // ORPHAN belongs to the flat thread (a removed option has no card), not here.
    expect(badges.some((b) => b.getAttribute("data-carryover") === "orphan")).toBe(false);
  });
});

// --- ArtifactPanel decision-comment view (the flat thread) ------------------

describe("#180 — the ArtifactPanel decision-comment thread shows the markers", () => {
  const generalComments = () => useArtifactStore.getState().comments[V1] ?? [];

  it("CARRIED / STALE / ORPHAN each render on the right flat-thread comment", () => {
    seedChain();
    render(<DecisionGeneralComments artifact={decArt(V2, 2, V1, eventV2.options)} comments={generalComments()} />);

    const badgeFor = (content: string) => {
      const container = screen.getByText(content).closest("div.space-y-2") as HTMLElement;
      return within(container).getByTestId("carryover-badge");
    };
    expect(badgeFor(CARRIED_A)).toHaveAttribute("data-carryover", "carried");
    expect(badgeFor(CARRIED_Q)).toHaveAttribute("data-carryover", "carried");
    expect(badgeFor(STALE_B)).toHaveAttribute("data-carryover", "stale");
    expect(badgeFor(ORPHAN_C)).toHaveAttribute("data-carryover", "orphan");
    expect(badgeFor(ORPHAN_C)).toHaveTextContent(/no longer in this decision/i);
  });

  it("a pro/con flat-thread comment is STALE/uncertain — never confident-green", () => {
    seedChain();
    render(<DecisionGeneralComments artifact={decArt(V2, 2, V1, eventV2.options)} comments={generalComments()} />);
    const container = screen.getByText(PROCON_D).closest("div.space-y-2") as HTMLElement;
    const badge = within(container).getByTestId("carryover-badge");
    expect(badge).toHaveAttribute("data-carryover", "stale");
    expect(badge).not.toHaveTextContent(/CARRIED/);
  });

  it("the carryover badge SUBSUMES the generic 'from vN' chip (no two version indicators)", () => {
    seedChain();
    render(<DecisionGeneralComments artifact={decArt(V2, 2, V1, eventV2.options)} comments={generalComments()} />);
    // Every seeded grain comment carries a state, so the CommentBubble's
    // "from vN" chip is suppressed everywhere in favour of the richer badge.
    expect(screen.queryAllByTitle("Posted on an earlier version of this artifact")).toHaveLength(0);
    expect(screen.getAllByTestId("carryover-badge").length).toBeGreaterThanOrEqual(5);
  });
});

// --- ArtifactPanel wiring (ArtifactDetail branches decisions to the above) ---

describe("#180 — ArtifactDetail wires the decision-comment thread for decision artifacts", () => {
  it("renders a carryover marker in the general Comments section of a decision artifact", async () => {
    seedChain();
    render(<ArtifactDetail artifact={decArt(V2, 2, V1, eventV2.options)} />);
    // DecisionGeneralComments is lazy — wait for a carryover badge to appear in
    // the flat Comments thread (proving ArtifactDetail routed the decision here).
    await waitFor(() => {
      expect(screen.getAllByTestId("carryover-badge").length).toBeGreaterThan(0);
    });
  });
});
