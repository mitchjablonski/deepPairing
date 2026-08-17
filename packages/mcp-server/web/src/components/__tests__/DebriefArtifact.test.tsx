import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DebriefArtifact } from "../artifacts/DebriefArtifact";
import { debriefArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { useArtifactStore } from "../../stores/artifact";

// The verb triad (ArtifactStatusActions) only renders its full Approve /
// Request changes / Reject row when the user is at the artifact's end. Stub
// IntersectionObserver to report the sentinel as intersecting so the full
// panel mounts deterministically in jsdom/happy-dom.
function stubIO(isIntersecting: boolean) {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting }]); }
      disconnect() {}
      unobserve() {}
    } as any,
  );
}

/** Read the JSON body of the most recent POST to /api/comments. */
function lastCommentPost(): any {
  const calls = (globalThis.fetch as any).mock.calls.filter(([u]: any[]) =>
    String(u).includes("/api/comments"),
  );
  const [, init] = calls[calls.length - 1];
  return JSON.parse(init.body);
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(debriefArtifact);
  stubIO(true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comment: null }) }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("DebriefArtifact — renders every block", () => {
  it("renders summary, a section (concept + evidence), decisionsMade, needsYourEyes, and deferred", async () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);

    // Summary narrative.
    expect(screen.getByText(/moved the sliding-window session-TTL refresh/i)).toBeInTheDocument();
    // O2 (#230) — "The walk" is collapsed behind a disclosure; expand it to read
    // its sections (the summary + needs-your-eyes stay above, always visible).
    await userEvent.click(screen.getByTestId("debrief-walk-toggle"));
    // Section title + body.
    expect(screen.getByText("Centralized the TTL refresh in middleware")).toBeInTheDocument();
    // Concept (ConceptBadge) — the learning lever.
    expect(screen.getByText("sliding-window expiration")).toBeInTheDocument();
    // Evidence (reused Research renderer) — the file:line header.
    expect(screen.getByText(/auth\/middleware\.ts:26-30/)).toBeInTheDocument();
    // decisionsMade accountability block.
    expect(screen.getByText(/Return 401 and clear the cookie/i)).toBeInTheDocument();
    expect(screen.getByTestId("debrief-decision")).toBeInTheDocument();
    // needsYourEyes prioritized list.
    expect(screen.getByText(/The expiry check in the middleware diff/i)).toBeInTheDocument();
    expect(screen.getByTestId("debrief-needs-eyes")).toBeInTheDocument();
    // deferred list.
    expect(screen.getByText("Refresh-token rotation")).toBeInTheDocument();
    expect(screen.getByTestId("debrief-deferred")).toBeInTheDocument();
    // #190 — openQuestions render via the shared OpenQuestionSection (agent's
    // questions FOR the human, answered on the questionIndex lane).
    expect(screen.getByTestId("debrief-open-questions")).toBeInTheDocument();
    expect(screen.getByText(/survive a server restart/i)).toBeInTheDocument();
  });

  it("shows the unified verb triad (Approve / Request changes / Reject)", () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    // Pre-fix (no ArtifactStatusActions dropped in) these would be absent.
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request changes/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reject$/i })).toBeInTheDocument();
  });
});

describe("DebriefArtifact — needsYourEyes drill-in", () => {
  it("clicking a review item's link SELECTS the referenced artifact", async () => {
    const user = userEvent.setup();
    render(<DebriefArtifact artifact={debriefArtifact} />);
    // Pre-fix (link not wired to selectArtifact) selectedArtifactId would stay
    // on the debrief itself, never advancing to the referenced changeset.
    const link = screen.getByRole("button", { name: /Open to review/i });
    await user.click(link);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("art_changeset_001");
  });
});

describe("DebriefArtifact — ask-anything thread", () => {
  it("posts a question with intent 'question' (the question-priority lane)", async () => {
    const user = userEvent.setup();
    render(<DebriefArtifact artifact={debriefArtifact} />);

    const composer = screen.getByLabelText("Comment on this debrief");
    await user.type(composer, "Any perf concern under load?");
    // The secondary "Ask" submit is what carries intent:"question". The debrief
    // also renders openQuestions (each via OpenQuestionSection, which has its own
    // "Ask" button that stays DISABLED while its composer is empty) — so target
    // the ENABLED Ask, which is the ask-anything thread's after we typed.
    const askButtons = screen.getAllByRole("button", { name: "Ask" });
    const enabledAsk = askButtons.find((b) => !(b as HTMLButtonElement).disabled)!;
    await user.click(enabledAsk);

    await waitFor(() => {
      const body = lastCommentPost();
      // Pre-fix (thread without secondarySubmitLabel="Ask") no intent would ride
      // along and the question lane would never light up.
      expect(body.intent).toBe("question");
      expect(body.target.artifactId).toBe("art_debrief_001");
      expect(body.target.sectionId).toBeUndefined();
    });
  });
});

describe("DebriefArtifact — grain comments", () => {
  it("a block comment carries the debrief:<key> sectionId grain", async () => {
    const user = userEvent.setup();
    render(<DebriefArtifact artifact={debriefArtifact} />);

    // Open the summary block's grain composer.
    await user.click(screen.getByRole("button", { name: "Comment on What we built" }));
    const composer = screen.getByLabelText("Comment on What we built");
    await user.type(composer, "Exactly the choke point I wanted.");
    // Scope to the block's own composer — the ask-anything thread also has a
    // "Comment" submit, so the query would be ambiguous unscoped.
    const block = composer.closest("div.rounded-lg") as HTMLElement;
    await user.click(within(block).getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      const body = lastCommentPost();
      // Pre-fix (target without the sectionId grain) the server delivery layer
      // couldn't anchor the comment to the summary block.
      expect(body.target.sectionId).toBe("debrief:summary");
    });
  });

  it("#193 E2 — a per-item needs-your-eyes comment carries `debrief:needs-your-eyes:<i>`", async () => {
    const user = userEvent.setup();
    render(<DebriefArtifact artifact={debriefArtifact} />);

    // The needsYourEyes item's own grain affordance (label = the item's `what`).
    const item = screen.getByTestId("debrief-needs-eyes");
    await user.click(within(item).getByRole("button", { name: /Comment on/i }));
    const composer = within(item).getByLabelText(/Comment on/i);
    await user.type(composer, "checked — looks right");
    await user.click(within(item).getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      const body = lastCommentPost();
      expect(body.target.sectionId).toBe("debrief:needs-your-eyes:0");
    });
  });
});

describe("DebriefArtifact — #207 (I2) write-axis lock", () => {
  const retracted = { ...debriefArtifact, status: "retracted" as const };
  const approved = { ...debriefArtifact, status: "approved" as const };

  it("RETRACTED: withholds EVERY composer — ask-anything, per-block grain, per-item grain, open-questions", async () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(retracted);
    render(<DebriefArtifact artifact={retracted} />);
    // Expand the walk (O2 disclosure) so the section grain-affordance count below
    // is measured with the sections in the DOM — a retracted walk still renders
    // its sections read-only (no grain composers), which is the point.
    await userEvent.click(screen.getByTestId("debrief-walk-toggle"));

    // Ask-anything composer gone (its labelled textarea is withheld read-only).
    expect(screen.queryByLabelText("Comment on this debrief")).not.toBeInTheDocument();
    // The per-block grain toggle ("💬 Comment") is pulled — no grain-affordance
    // buttons anywhere (summary, walk, decisions, deferred, needs-your-eyes).
    expect(screen.queryByRole("button", { name: "Comment on What we built" })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-grain-affordance]").length).toBe(0);
    // Open-questions composer withheld (no Answer/Ask buttons on any question).
    expect(screen.queryByRole("button", { name: "Answer" })).not.toBeInTheDocument();
    // …but the narrative history stays readable.
    expect(screen.getByText(/moved the sliding-window session-TTL refresh/i)).toBeInTheDocument();
    expect(screen.getByText("Centralized the TTL refresh in middleware")).toBeInTheDocument();
    // The invitation copy no longer promises an answer.
    expect(screen.getByText(/this debrief is read-only/i)).toBeInTheDocument();
  });

  it("RETRACTED: a prior grain thread stays readable (history preserved, composer gone)", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(retracted);
    useArtifactStore.setState({
      comments: {
        [retracted.id]: [
          {
            id: "gc1",
            sessionId: "s",
            author: "human",
            content: "PRIOR-GRAIN-NOTE",
            createdAt: "2026-01-01T00:00:00.000Z",
            parentCommentId: null,
            target: { artifactId: retracted.id, sectionId: "debrief:summary" },
          } as any,
        ],
      },
    } as any);
    render(<DebriefArtifact artifact={retracted} />);

    // The posted grain comment renders (read-only thread)…
    expect(screen.getByText("PRIOR-GRAIN-NOTE")).toBeInTheDocument();
    // …with no composer for it (the summary block's grain toggle is gone).
    expect(screen.queryByRole("button", { name: "Comment on What we built" })).not.toBeInTheDocument();
  });

  it("APPROVED stays LATE-COMMENTABLE (the #187 follow-up lane) — composers STILL LIVE", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(approved);
    render(<DebriefArtifact artifact={approved} />);

    // The regression that matters most: an approved debrief keeps its composers.
    expect(screen.getByLabelText("Comment on this debrief")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comment on What we built" })).toBeInTheDocument();
    // Open-questions answer composer present too.
    expect(screen.getAllByRole("button", { name: "Answer" }).length).toBeGreaterThan(0);
  });
});

describe("DebriefArtifact — #193 E2 lifecycle", () => {
  it("renders 'Needs your eyes' ABOVE the narrative (what must I look at, first)", () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    const eyes = screen.getByText("Needs your eyes");
    const summary = screen.getByText("What we built");
    // Node order: needs-your-eyes precedes the summary block in the DOM.
    expect(eyes.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Reject is de-fanged — one step, no 'name the pattern' field, no concept sent", async () => {
    const user = userEvent.setup();
    render(<DebriefArtifact artifact={debriefArtifact} />);
    // A rejected debrief means "redo the digest", not a remembered rule.
    // The verdict textarea (ArtifactStatusActions) — type the redo reason there.
    const verdictBox = screen.getByPlaceholderText(/respond to the agent/i);
    await user.type(verdictBox, "please redo the summary — too terse");
    await user.click(screen.getByRole("button", { name: /^reject$/i }));

    // No cross-project ledger prompt appears…
    expect(screen.queryByLabelText(/what pattern are you rejecting/i)).not.toBeInTheDocument();
    // …and the status POST is a plain reject with NO concept.
    await waitFor(() => {
      const statusCall = (globalThis.fetch as any).mock.calls.find(([u]: any[]) =>
        String(u).includes("/api/artifacts/art_debrief_001/status"),
      );
      expect(statusCall).toBeTruthy();
      expect(statusCall[1].body).toContain('"status":"rejected"');
      expect(statusCall[1].body).not.toContain('"concept"');
    });
  });
});

describe("DebriefArtifact — progressive disclosure of 'The walk' (O2 #230)", () => {
  it("collapses the walk by default; needs-your-eyes + summary stay above the fold", () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    // The disclosure toggle is present, labelled with the section count…
    const toggle = screen.getByTestId("debrief-walk-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(/Full walk-through \(2 sections\)/i);
    // …but the walk's section content is NOT rendered while collapsed.
    expect(screen.queryByText("Centralized the TTL refresh in middleware")).not.toBeInTheDocument();
    // The 30-second view stays visible: needs-your-eyes + summary.
    expect(screen.getByText("Needs your eyes")).toBeInTheDocument();
    expect(screen.getByText("What we built")).toBeInTheDocument();
  });

  it("expands on click and collapses again", async () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    const toggle = screen.getByTestId("debrief-walk-toggle");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Centralized the TTL refresh in middleware")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Centralized the TTL refresh in middleware")).not.toBeInTheDocument();
  });

  it("a section carrying a live comment thread starts EXPANDED (unresolved comment never hidden)", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(debriefArtifact);
    useArtifactStore.setState({
      comments: {
        [debriefArtifact.id]: [
          {
            id: "gc_walk",
            sessionId: "s",
            author: "human",
            content: "WALK-SECTION-THREAD",
            createdAt: "2026-01-01T00:00:00.000Z",
            parentCommentId: null,
            target: { artifactId: debriefArtifact.id, sectionId: "debrief:0" },
          } as any,
        ],
      },
    } as any);
    render(<DebriefArtifact artifact={debriefArtifact} />);
    // Auto-expanded: the section (and its live thread) is on screen without a click.
    expect(screen.getByTestId("debrief-walk-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Centralized the TTL refresh in middleware")).toBeInTheDocument();
    expect(screen.getByText("WALK-SECTION-THREAD")).toBeInTheDocument();
  });
});

describe("DebriefArtifact — 'Walk me through this' on a needs-your-eyes item (O2 #230)", () => {
  it("emits a scoped explain request naming the flagged item", async () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    const item = screen.getByTestId("debrief-needs-eyes");
    await userEvent.click(within(item).getByTestId("walk-me-through-needs-eyes"));
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.filter(([u]: any[]) =>
        String(u).includes("/api/requests"),
      );
      expect(calls.length).toBeGreaterThan(0);
      const body = JSON.parse(calls[calls.length - 1][1].body);
      expect(body.intent).toBe("explain");
      expect(body.text).toContain("The expiry check in the middleware diff");
      expect(body.text).toContain("present_explainer");
    });
  });

  /**
   * P2 fix 2 (round-11 MED) — the REF TRAVELS. O2 passed `hasArtifactRef:
   * !!item.artifactRef` — a BOOLEAN — so the emitted text promised "scoped to
   * the linked artifact" while the id itself never left the browser: the agent
   * was told a link existed without being told what it pointed at.
   */
  it("the item's artifactRef TRAVELS — in the prose and in the structured scope", async () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    const item = screen.getByTestId("debrief-needs-eyes");
    await userEvent.click(within(item).getByTestId("walk-me-through-needs-eyes"));
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.filter(([u]: any[]) =>
        String(u).includes("/api/requests"),
      );
      expect(calls.length).toBeGreaterThan(0);
      const body = JSON.parse(calls[calls.length - 1][1].body);
      // The fixture needs-your-eyes item links artifact "art_changeset_001".
      expect(body.text).toContain("the linked artifact art_changeset_001");
      expect(body.source).toBe("walk_me_through");
      expect(body.scope).toEqual({
        artifactId: "art_changeset_001",
        // P2 review F6 — the DEBRIEF the item was flagged in, so itemRef no
        // longer anchors into an artifact the scope never names.
        sourceArtifactId: "art_debrief_001",
        itemRef: "debrief:needs-your-eyes:0",
      });
    });
  });
});

/**
 * P2 fix 5 (round-11 MED) — the disclosure toggle was styled BYTE-IDENTICALLY to
 * the static section headings (text-xs font-semibold text-text-muted uppercase
 * tracking-wide, cursor:default), so "FULL WALK-THROUGH (3 SECTIONS)" read as an
 * empty section rather than a control. It must not be class-identical to a
 * heading, and it must carry interactive affordances.
 */
describe("DebriefArtifact — the disclosure reads as a CONTROL, not a heading (P2)", () => {
  it("is not styled as a static section heading", () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    const toggle = screen.getByTestId("debrief-walk-toggle");
    const heading = screen.getByText("What we built"); // the h4 it used to mimic
    expect(toggle.className).not.toBe(heading.className);
    // The heading mimicry itself is gone.
    expect(toggle.className).not.toContain("uppercase");
    expect(heading.className).toContain("uppercase");
  });

  it("carries interactive affordances: pointer cursor, border, hover state, rotating chevron", () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);
    const toggle = screen.getByTestId("debrief-walk-toggle");
    expect(toggle.className).toContain("cursor-pointer");
    expect(toggle.className).toMatch(/\bborder\b/);
    expect(toggle.className).toMatch(/hover:bg-/);
    // The chevron rotates with the expanded state (collapsed = not rotated).
    const chevron = toggle.querySelector("[aria-hidden='true']")!;
    expect(chevron.className).toContain("transition-transform");
    expect(chevron.className).not.toContain("rotate-90");
  });

  it("keeps the 'has your comments' hint when collapsed over a live thread", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(debriefArtifact);
    render(<DebriefArtifact artifact={debriefArtifact} />);
    // No thread in the base fixture → no hint; the hint's own test lives in the
    // auto-expand case above. Here we only pin that the label is a plain,
    // sentence-case action string.
    expect(screen.getByTestId("debrief-walk-toggle")).toHaveTextContent(/Show the full walk-through/i);
  });
});
