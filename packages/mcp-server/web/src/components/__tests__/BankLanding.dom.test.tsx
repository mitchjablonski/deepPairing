/**
 * THE LANDING DECISION. The bank takes the landing only when it carries
 * cross-signal the session view structurally cannot show; otherwise the app
 * lands exactly where it always has. Both directions are pinned here, plus the
 * deep link, because "the surface nobody lands on" is this project's own
 * recurring death class — and its inverse (a triage index in front of someone
 * with one project and one thread) is the over-correction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "../../App";
import { useContextBankStore } from "../../stores/contextBank";
import { useConnectionStore } from "../../stores/connection";
import { useArtifactStore } from "../../stores/artifact";
import { enterSessionReplay } from "../../lib/session-replay";
import type { BankProject, BankSession, ContextBank } from "../../lib/bank";
import { resetLedgerStoreForTests } from "../../stores/ledger";

// The replay route has its own module tests; here we assert App HANDS OFF to it
// (a fake, not a mock of the whole fetch layer).
vi.mock("../../lib/session-replay", () => ({
  enterSessionReplay: vi.fn().mockResolvedValue(true),
}));

const CURRENT = "/p/alpha";

function session(over: Partial<BankSession> = {}): BankSession {
  return {
    sessionId: "s1",
    projectRoot: CURRENT,
    projectName: "alpha",
    oneLiner: "We replaced the session cache",
    derivationRung: "debrief-summary",
    derivationQuality: "rich",
    lastActivity: "2026-08-01T00:00:00.000Z",
    artifactCount: 3,
    openDecisions: [],
    openDecisionCount: 0,
    draftReviewCount: 0,
    unansweredQuestionCount: 0,
    salience: ["quiet"],
    ...over,
  };
}

function bankOf(projects: BankProject[]): ContextBank {
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    projects,
    totals: { projects: projects.length, sessions: 1, openDecisions: 0, needsYou: 0, waitingOnAgent: 0, staleProjects: 0 },
    staleAfterDays: 21,
  };
}

const oneProject = bankOf([
  { projectRoot: CURRENT, name: "alpha", lastSeen: "2026-08-01T00:00:00.000Z", stale: false, sessions: [session()], openDecisionCount: 0, needsYouCount: 0, waitingOnAgentCount: 0 },
]);
const twoProjects = bankOf([
  { projectRoot: CURRENT, name: "alpha", lastSeen: "2026-08-01T00:00:00.000Z", stale: false, sessions: [session()], openDecisionCount: 0, needsYouCount: 0, waitingOnAgentCount: 0 },
  { projectRoot: "/p/beta", name: "beta", lastSeen: "2026-08-01T00:00:00.000Z", stale: false, sessions: [session({ sessionId: "s2", projectRoot: "/p/beta", projectName: "beta" })], openDecisionCount: 0, needsYouCount: 0, waitingOnAgentCount: 0 },
]);

function stubDaemon(bank: ContextBank, activeSessions: Array<{ sessionId: string }> = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/context-bank")) return new Response(JSON.stringify(bank), { status: 200 });
      if (url.includes("/api/projects")) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      if (url.includes("/api/ledger/digest")) return Response.json({
        shapedThisProject: 0, nearMissesThisProject: 0, blockedThisProject: 0, sessionsTouched: 0,
        topCitedStances: [], globalLedger: { concepts: 0, projects: 0, multiProjectConcepts: 0 },
      });
      if (url.includes("/api/active-sessions"))
        return new Response(JSON.stringify({ sessions: activeSessions }), { status: 200 });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  resetLedgerStoreForTests();
  vi.spyOn(console, "error");
  vi.mocked(enterSessionReplay).mockClear();
  useContextBankStore.getState().reset();
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, hydrated: true, projectRoot: CURRENT, activeSessions: [] } as never);
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  expect(console.error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  resetLedgerStoreForTests();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("bank landing heuristic", () => {
  it("lands on the bank when a second project carries real work", async () => {
    stubDaemon(twoProjects);
    render(<App />);
    await waitFor(() => expect(useContextBankStore.getState().open).toBe(true));
    expect(await screen.findByTestId("context-bank-view")).toBeInTheDocument();
  });

  it("does NOT hijack the single-project, single-session flow", async () => {
    stubDaemon(oneProject);
    render(<App />);
    await waitFor(() => expect(useContextBankStore.getState().bank).not.toBeNull());
    expect(useContextBankStore.getState().open).toBe(false);
    expect(screen.queryByTestId("context-bank-view")).not.toBeInTheDocument();
  });

  it("leaves a deep link alone — ?session= still wins over the bank", async () => {
    window.history.replaceState({}, "", "/?session=s2");
    stubDaemon(twoProjects);
    render(<App />);
    await waitFor(() => expect(useContextBankStore.getState().bank).not.toBeNull());
    expect(useContextBankStore.getState().open).toBe(false);
    expect(screen.queryByTestId("context-bank-view")).not.toBeInTheDocument();
  });

  it("is reachable from the header at any time", async () => {
    stubDaemon(oneProject);
    render(<App />);
    const entry = await screen.findByTestId("open-context-bank");
    entry.click();
    await waitFor(() => expect(useContextBankStore.getState().open).toBe(true));
  });
});

describe("the header badge counts what the lanes count", () => {
  it("shows no needs-you badge when the only needs-you session is a fixture", async () => {
    const demoOnly = bankOf([
      {
        projectRoot: CURRENT, name: "alpha", lastSeen: "2026-08-01T00:00:00.000Z", stale: false,
        sessions: [session({ sessionId: "demo_1", fixtureLike: true, salience: ["needs-you"], openDecisionCount: 1 })],
        openDecisionCount: 1, needsYouCount: 1, waitingOnAgentCount: 0,
      },
    ]);
    demoOnly.totals = { ...demoOnly.totals, needsYou: 1, openDecisions: 1 };
    stubDaemon(demoOnly);
    render(<App />);
    await waitFor(() => expect(useContextBankStore.getState().bank).not.toBeNull());
    // The badge is the header's promise that work is waiting. On a fresh
    // `deeppairing demo` the only such session is the demo itself.
    expect(screen.queryByLabelText(/threads need you/i)).not.toBeInTheDocument();
  });

  it("shows the badge when a REAL session needs you", async () => {
    const real = bankOf([
      {
        projectRoot: CURRENT, name: "alpha", lastSeen: "2026-08-01T00:00:00.000Z", stale: false,
        sessions: [session({ salience: ["needs-you"], openDecisionCount: 1 })],
        openDecisionCount: 1, needsYouCount: 1, waitingOnAgentCount: 0,
      },
    ]);
    stubDaemon(real);
    render(<App />);
    expect(await screen.findByLabelText(/1 threads need you/i)).toBeInTheDocument();
  });
});

describe("?session= pointing at a session this daemon has not registered", () => {
  it("replays it instead of silently landing on the default session", async () => {
    // The bank's headline population is DEAD on-disk sessions, and the
    // cross-project "switch to act" affordance sends exactly this URL.
    window.history.replaceState({}, "", "/?session=s_dead");
    stubDaemon(oneProject, [{ sessionId: "s_live" }]);
    render(<App />);
    await waitFor(() => expect(enterSessionReplay).toHaveBeenCalledWith("s_dead"));
  });

  it("leaves a LIVE deep-linked session on the normal binding path (no replay)", async () => {
    window.history.replaceState({}, "", "/?session=s_live");
    stubDaemon(oneProject, [{ sessionId: "s_live" }]);
    render(<App />);
    await waitFor(() => expect(useContextBankStore.getState().bank).not.toBeNull());
    expect(enterSessionReplay).not.toHaveBeenCalled();
  });

  it("does nothing extra when there is no deep link at all", async () => {
    stubDaemon(oneProject, [{ sessionId: "s_live" }]);
    render(<App />);
    await waitFor(() => expect(useContextBankStore.getState().bank).not.toBeNull());
    expect(enterSessionReplay).not.toHaveBeenCalled();
  });
});
