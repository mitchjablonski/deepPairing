import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnIndicator } from "../TurnIndicator";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

function seedConnected(): void {
  useConnectionStore.setState({ connected: true } as any);
}

function seedArtifact(overrides: any = {}): void {
  useArtifactStore.setState((s: any) => ({
    artifacts: [
      ...s.artifacts,
      {
        id: "art_1",
        sessionId: "s1",
        type: "research",
        version: 1,
        parentId: null,
        title: "x",
        status: "approved",
        content: {},
        agentReasoning: null,
        createdAt: "2026-04-20T10:00:00Z",
        updatedAt: "2026-04-20T10:00:00Z",
        ...overrides,
      },
    ],
  }));
}

function seedComment(artifactId: string, partial: any = {}): void {
  useArtifactStore.setState((s: any) => ({
    comments: {
      ...s.comments,
      [artifactId]: [
        ...(s.comments[artifactId] ?? []),
        {
          id: `cmt_${Math.random().toString(36).slice(2, 8)}`,
          sessionId: "s1",
          target: { artifactId },
          author: "human",
          content: "why?",
          intent: "question",
          acknowledged: false,
          createdAt: new Date().toISOString(),
          ...partial,
        },
      ],
    },
  }));
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: false, agentActivityAt: null, agentActiveSince: null } as any);
});

describe("TurnIndicator — #430 PR 1c: no question badge (the Comment-threads count owns it)", () => {
  // The Q4 ❓ "N questions waiting" badge duplicated the Comment-threads
  // button's count (design §2.7 item 2); per §5 the button keeps the ONE count
  // (AppQuestionsCount.dom.test.tsx). This pill is agent state + your turn only.
  it("renders no question badge even with unanswered questions", () => {
    seedConnected();
    seedArtifact();
    seedComment("art_1");
    render(<TurnIndicator />);
    expect(screen.queryByText(/question/i)).not.toBeInTheDocument();
    expect(screen.queryByText("❓")).not.toBeInTheDocument();
  });
});

describe("TurnIndicator — UX1: a draft code_change is 'your turn' (matches PendingBanner)", () => {
  it("shows 'Your turn — 1 change' for a draft code_change (was 'Agent working')", () => {
    seedConnected();
    seedArtifact({ id: "cc", type: "code_change", status: "draft" });
    render(<TurnIndicator />);
    expect(screen.getByText(/your turn/i)).toBeInTheDocument();
    expect(screen.getByText(/1 change/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent working/i)).not.toBeInTheDocument();
  });
});

describe("#192 (usability H1) — 'Your turn' never dangles for changeset/debrief", () => {
  // Screenshot-proven defect: with ONLY a draft changeset/debrief/explainer
  // pending, the summary rendered "Your turn —" with nothing after the dash
  // while the tab badge said 3. Fails on revert (the summary text would be a
  // bare "Your turn —").
  //
  // P3 — the EXPLAINER left the "your turn" set entirely: it is acknowledge-only
  // ("Got it" / "Ask more" — no verdict), so it is not work owed and must not
  // appear in this summary or lift the badge. The dangling-dash guard still
  // holds for the types that ARE owed.
  it("shows the owed nouns, not a dangling dash, when only the new types are pending", () => {
    seedConnected();
    seedArtifact({ id: "cs", type: "changeset", status: "draft" });
    seedArtifact({ id: "db", type: "debrief", status: "draft" });
    seedArtifact({ id: "ex", type: "explainer", status: "draft" });
    render(<TurnIndicator />);
    const pill = screen.getByRole("button", { name: /your turn/i });
    expect(pill).toHaveTextContent("Your turn — 1 changeset, 1 debrief");
    expect(pill.textContent ?? "").not.toMatch(/explainer/i);
    // Guard against the exact regression: the visible summary must not end at the dash.
    expect(pill.textContent ?? "").not.toMatch(/Your turn\s*—\s*$/);
  });

  it("P3 — an explainer-ONLY session is not 'your turn' at all", () => {
    seedConnected();
    seedArtifact({ id: "ex", type: "explainer", status: "draft" });
    render(<TurnIndicator />);
    // No "Your turn" pill: the human owes a READ, not a verdict, and the
    // check_feedback payload says so too ("TO READ", 0 pending).
    expect(screen.queryByRole("button", { name: /your turn/i })).not.toBeInTheDocument();
  });
});

describe("TurnIndicator — U2 agent liveness", () => {
  it("shows 'Up to date' (not a forever 'Agent working' pulse) once activity is stale", () => {
    seedConnected();
    seedArtifact({ status: "approved", createdAt: "2026-04-20T10:00:00Z", updatedAt: "2026-04-20T10:00:00Z" });
    render(<TurnIndicator />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent working/i)).not.toBeInTheDocument();
  });

  it("shows 'Agent working' while there is recent activity", () => {
    seedConnected();
    const now = new Date().toISOString();
    seedArtifact({ status: "approved", createdAt: now, updatedAt: now });
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("C2 — a freshly-connected session with NO signal shows 'Connected — waiting', not the unfalsifiable 'Agent working'", () => {
    seedConnected(); // no artifacts/comments/heartbeats
    render(<TurnIndicator />);
    expect(screen.getByText(/connected — waiting/i)).toBeInTheDocument();
    expect(screen.queryByText(/agent working/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("re-arms: new activity flips a stale 'Up to date' back to 'Agent working'", () => {
    seedConnected();
    seedArtifact({ id: "old", status: "approved", createdAt: "2026-04-20T10:00:00Z", updatedAt: "2026-04-20T10:00:00Z" });
    const { rerender } = render(<TurnIndicator />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
    // fresh activity arrives
    const now = new Date().toISOString();
    act(() => { seedArtifact({ id: "fresh", status: "approved", createdAt: now, updatedAt: now }); });
    rerender(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });
});

describe("B2 — heartbeat liveness + elapsed label", () => {
  it("shows 'Agent working · Nm' from the agent_activity heartbeat even with stale artifacts", () => {
    seedConnected();
    const now = Date.now();
    // Artifacts are old (past the 45s idle cutoff) — pre-B2 this flipped to
    // "Up to date" while the agent was mid-edit-run. The heartbeat keeps it
    // honest and adds elapsed time.
    seedArtifact({ id: "old", status: "approved", createdAt: "2026-01-01T00:00:00Z" });
    useConnectionStore.setState({
      agentActivityAt: now - 1_000,
      agentActiveSince: now - 3 * 60_000,
    } as any);
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working · 3m/i)).toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });

  it("stays 'Up to date' when the heartbeat is also stale", () => {
    seedConnected();
    const stale = Date.now() - 10 * 60_000;
    seedArtifact({ id: "old", status: "approved", createdAt: "2026-01-01T00:00:00Z" });
    useConnectionStore.setState({ agentActivityAt: stale, agentActiveSince: stale } as any);
    render(<TurnIndicator />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });
});

describe("C2 — honest t=0: no signal must not claim 'Agent working'", () => {
  // (the zero-signal case itself is asserted in the rewritten U2 test above)
  it("flips to 'Agent working' once the first heartbeat arrives", () => {
    seedConnected();
    useConnectionStore.setState({ agentActivityAt: Date.now(), agentActiveSince: Date.now() } as any);
    render(<TurnIndicator />);
    expect(screen.getByText(/agent working/i)).toBeInTheDocument();
    expect(screen.queryByText(/connected — waiting/i)).not.toBeInTheDocument();
  });
});

describe("B1 — the 'Your turn' pill is a jump button, not a dead label", () => {
  it("clicking jumps to the first pending artifact and cycles on repeat clicks", async () => {
    const user = userEvent.setup();
    seedConnected();
    seedArtifact({ id: "d1", status: "draft", title: "first" });
    seedArtifact({ id: "d2", status: "draft", title: "second" });
    render(<TurnIndicator />);

    const pill = screen.getByRole("button", { name: /your turn/i });
    await user.click(pill);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1");
    await user.click(pill);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d2");
    await user.click(pill); // wraps
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1");
  });
});

describe("F8 (M6) — no check-in promise from a dead session", () => {
  it("the pill states 'Agent exited' when the owning session is dead", () => {
    useConnectionStore.setState({
      connected: true,
      sessionId: "s1",
      activeSessions: [{ sessionId: "s1", live: false }],
    } as any);
    useArtifactStore.setState({
      comments: {
        art_q: [{
          id: "c_q", artifactId: "art_q", sessionId: "s1", author: "human",
          intent: "question", content: "?", createdAt: "2026-07-01T00:00:00.000Z",
          target: { artifactId: "art_q" },
        } as any],
      },
    });
    render(<TurnIndicator />);
    // M3 (#196) — the exited state is stated ONCE, canonically, by the agent's
    // -turn pill (not repeated in the questions badge).
    expect(screen.getByText(/agent exited/i)).toBeInTheDocument();
    // #430 PR 1c — the question badge is gone from this pill; the exited-agent
    // wording for open questions lives in ResumeQuestionsBanner.
    expect(screen.queryByText(/question.*waiting/i)).not.toBeInTheDocument();
  });
});

describe("#196 F2 — banner-soup dedup (M4)", () => {
  it("S2 — drops the pending COUNT (not just the breakdown) when the PendingBanner owns it", () => {
    seedConnected();
    seedArtifact({ id: "d1", type: "code_change", status: "draft" });
    render(<TurnIndicator pendingBannerVisible />);
    // S2 dedup: the banner is the ONE authoritative pending-count signal, so the
    // header pill shows NEITHER the breakdown NOR the number — a bare "Your turn"
    // jump affordance. The number no longer renders twice one band apart.
    expect(screen.queryByText(/for you/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your turn — 1 change/i)).not.toBeInTheDocument();
    // The affordance survives: still a jump button, and it visibly says "Your turn".
    const pill = screen.getByRole("button", { name: /your turn/i });
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/^Your turn$/);
    // The full breakdown is preserved in the accessible name (title/aria).
    expect(pill).toHaveAttribute("aria-label", expect.stringMatching(/Your turn — 1 change/i));
  });

  it("keeps the full 'Your turn' pill when the banner is absent (default)", () => {
    seedConnected();
    seedArtifact({ id: "d1", type: "code_change", status: "draft" });
    render(<TurnIndicator />);
    expect(screen.getByText(/Your turn — 1 change/i)).toBeInTheDocument();
  });

  it("J2b (#212) — collapses to a count when the single pending card is in view (banner suppressed)", () => {
    // The banner is gone (App suppressed it because the one draft is on screen),
    // so the pill drops the verbatim breakdown too — the visible card is the
    // detail; the pill stays a bare count summary.
    seedConnected();
    seedArtifact({ id: "d1", type: "code_change", status: "draft" });
    render(<TurnIndicator pendingCardInView />);
    expect(screen.getByText(/1 for you/i)).toBeInTheDocument();
    expect(screen.queryByText(/Your turn — 1 change/i)).not.toBeInTheDocument();
    // The jump affordance survives (accessible name is the full breakdown).
    expect(screen.getByRole("button", { name: /your turn/i })).toBeInTheDocument();
  });

});
