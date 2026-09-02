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
import type { BankProject, BankSession, ContextBank } from "../../lib/bank";

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

function stubDaemon(bank: ContextBank) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/context-bank")) return new Response(JSON.stringify(bank), { status: 200 });
      if (url.includes("/api/projects")) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  useContextBankStore.getState().reset();
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, hydrated: true, projectRoot: CURRENT, activeSessions: [] } as never);
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
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
