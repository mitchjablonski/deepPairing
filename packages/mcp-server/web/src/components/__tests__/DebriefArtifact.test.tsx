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
  it("renders summary, a section (concept + evidence), decisionsMade, needsYourEyes, and deferred", () => {
    render(<DebriefArtifact artifact={debriefArtifact} />);

    // Summary narrative.
    expect(screen.getByText(/moved the sliding-window session-TTL refresh/i)).toBeInTheDocument();
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

  it("RETRACTED: withholds EVERY composer — ask-anything, per-block grain, per-item grain, open-questions", () => {
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(retracted);
    render(<DebriefArtifact artifact={retracted} />);

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
