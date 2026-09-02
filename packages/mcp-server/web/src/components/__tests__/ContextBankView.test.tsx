import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextBankView } from "../ContextBankView";
import { useContextBankStore } from "../../stores/contextBank";
import { useConnectionStore } from "../../stores/connection";
import { useToastStore } from "../../stores/toast";
import type { BankOpenDecision, BankProject, BankSession, ContextBank } from "../../lib/bank";

const CURRENT = "/p/alpha";
const OTHER = "/p/beta";

function decision(over: Partial<BankOpenDecision> = {}): BankOpenDecision {
  return {
    decisionId: "dec_1",
    artifactId: "art_1",
    title: "Which cache?",
    context: "Which cache should we use?",
    ...over,
  };
}

function session(over: Partial<BankSession> = {}): BankSession {
  return {
    sessionId: "s1",
    projectRoot: CURRENT,
    projectName: "alpha",
    oneLiner: "We replaced the session cache with Redis",
    derivationRung: "debrief-summary",
    derivationQuality: "rich",
    lastActivity: "2026-08-01T00:00:00.000Z",
    artifactCount: 4,
    openDecisions: [],
    openDecisionCount: 0,
    draftReviewCount: 0,
    unansweredQuestionCount: 0,
    salience: ["quiet"],
    ...over,
  };
}

function project(over: Partial<BankProject> = {}): BankProject {
  return {
    projectRoot: CURRENT,
    name: "alpha",
    lastSeen: "2026-08-01T00:00:00.000Z",
    stale: false,
    sessions: [],
    openDecisionCount: 0,
    needsYouCount: 0,
    waitingOnAgentCount: 0,
    ...over,
  };
}

function bankOf(projects: BankProject[]): ContextBank {
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    projects,
    totals: {
      projects: projects.length,
      sessions: projects.reduce((n, p) => n + p.sessions.length, 0),
      openDecisions: 0,
      needsYou: 0,
      waitingOnAgent: 0,
      staleProjects: 0,
    },
    staleAfterDays: 21,
  };
}

/** A fake daemon: routes by URL, records every close-out POST it received. */
function stubDaemon(bank: ContextBank, opts: { closeOutStatus?: number } = {}) {
  const closeOuts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/context-bank")) {
        return new Response(JSON.stringify(bank), { status: 200 });
      }
      if (url.includes("/api/projects")) {
        return new Response(
          JSON.stringify({ projects: [{ projectRoot: OTHER, port: 3900 }] }),
          { status: 200 },
        );
      }
      if (url.includes("/close-out")) {
        closeOuts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        const status = opts.closeOutStatus ?? 200;
        return new Response(
          JSON.stringify(
            status === 200
              ? { status: "closed_out" }
              : { error: "This decision belongs to another project.", code: "DP_CROSS_PROJECT" },
          ),
          { status },
        );
      }
      return new Response("{}", { status: 200 });
    }),
  );
  return closeOuts;
}

beforeEach(() => {
  useContextBankStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useConnectionStore.setState({ projectRoot: CURRENT, activeSessions: [] } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContextBankView — the index", () => {
  it("renders the lanes triage-first: needs you, waiting on agent, quiet, done", async () => {
    stubDaemon(bankOf([project({ sessions: [session()] })]));
    render(<ContextBankView onClose={() => {}} />);
    await screen.findByTestId("bank-lane-needs-you");
    const order = Array.from(
      document.querySelectorAll("[data-testid^='bank-lane-']"),
    ).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "bank-lane-needs-you",
      "bank-lane-waiting",
      "bank-lane-quiet",
      "bank-lane-done",
    ]);
  });

  it("puts the highest-stakes, oldest decision at the top of needs-you", async () => {
    stubDaemon(
      bankOf([
        project({
          sessions: [
            session({ sessionId: "low", oneLiner: "low thread", salience: ["needs-you"], openDecisionCount: 1, openDecisions: [decision({ stakes: "low", ageDays: 5 })] }),
            session({ sessionId: "high", oneLiner: "high thread", salience: ["needs-you"], openDecisionCount: 1, openDecisions: [decision({ decisionId: "dec_2", artifactId: "art_2", stakes: "high", ageDays: 70 })] }),
          ],
        }),
      ]),
    );
    render(<ContextBankView onClose={() => {}} />);
    const lane = await screen.findByTestId("bank-lane-needs-you");
    const rows = within(lane).getAllByTestId("bank-row");
    expect(rows[0]?.getAttribute("data-session-id")).toBe("high");
    expect(rows[1]?.getAttribute("data-session-id")).toBe("low");
  });

  it("keeps unanswered questions in their OWN lane, never in needs-you", async () => {
    stubDaemon(
      bankOf([
        project({
          sessions: [
            session({ sessionId: "asked", oneLiner: "asked thread", salience: ["waiting-on-agent"], unansweredQuestionCount: 2 }),
          ],
        }),
      ]),
    );
    render(<ContextBankView onClose={() => {}} />);
    const needs = await screen.findByTestId("bank-lane-needs-you");
    const waiting = screen.getByTestId("bank-lane-waiting");
    expect(within(needs).queryAllByTestId("bank-row")).toHaveLength(0);
    expect(within(waiting).getAllByTestId("bank-row")).toHaveLength(1);
    expect(within(waiting).getByText(/2 unanswered questions/)).toBeInTheDocument();
  });

  it("greys a stale registry entry and says the path is gone, without hiding it", async () => {
    stubDaemon(
      bankOf([project({ projectRoot: OTHER, name: "beta", stale: true, sessions: [session({ sessionId: "gone", projectRoot: OTHER, projectName: "beta" })] })]),
    );
    render(<ContextBankView onClose={() => {}} />);
    expect(await screen.findByText("path no longer exists")).toBeInTheDocument();
  });

  it("flags a degraded session rather than dropping it", async () => {
    stubDaemon(
      bankOf([project({ sessions: [session({ sessionId: "bad", degraded: true, degradedReason: "artifacts.json unreadable" })] })]),
    );
    render(<ContextBankView onClose={() => {}} />);
    expect(await screen.findByTestId("bank-degraded")).toBeInTheDocument();
  });
});

describe("ContextBankView — fixture data", () => {
  it("groups demo sessions in a COLLAPSED section, with the honest banner behind it", async () => {
    stubDaemon(
      bankOf([
        project({
          sessions: [
            session({ sessionId: "demo_1", oneLiner: "the demo thread", fixtureLike: true, salience: ["needs-you"] }),
            session({ sessionId: "real", oneLiner: "the real thread" }),
          ],
        }),
      ]),
    );
    render(<ContextBankView onClose={() => {}} />);
    const fixtures = await screen.findByTestId("bank-section-fixtures");
    // Collapsed: the demo row is not on screen, and it never sat in a real lane.
    expect(within(fixtures).queryByText("the demo thread")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("bank-lane-needs-you")).queryAllByTestId("bank-row")).toHaveLength(0);
    await userEvent.click(within(fixtures).getByRole("button", { name: /demo \/ fixture data/i }));
    expect(within(fixtures).getByText("the demo thread")).toBeInTheDocument();
    expect(within(fixtures).getByText(/not your work/i)).toBeInTheDocument();
  });
});

describe("ContextBankView — the re-entry card's honesty", () => {
  it("says plainly that a THIN card has no debrief behind it", async () => {
    stubDaemon(
      bankOf([
        project({
          sessions: [
            session({
              oneLiner: "Milestone 2: the port window",
              // The rung says debrief-summary — the card must ignore it and key
              // on the QUALITY, which the server force-graded thin.
              derivationRung: "debrief-summary",
              derivationQuality: "thin",
            }),
          ],
        }),
      ]),
    );
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Milestone 2/ }));
    expect(screen.getByTestId("bank-quality-note").textContent).toMatch(
      /No debrief was recorded for this session/i,
    );
    expect(screen.getByText("title only")).toBeInTheDocument();
  });

  it("says nothing extra on a RICH card", async () => {
    stubDaemon(bankOf([project({ sessions: [session({ derivationQuality: "rich" })] })]));
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    expect(screen.queryByTestId("bank-quality-note")).not.toBeInTheDocument();
    expect(screen.getByText("debriefed")).toBeInTheDocument();
  });

  it("qualifies a MEDIUM card as one change or one question, not the session", async () => {
    stubDaemon(bankOf([project({ sessions: [session({ derivationQuality: "medium" })] })]));
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    expect(screen.getByTestId("bank-quality-note").textContent).toMatch(/not the session/i);
  });
});

describe("ContextBankView — decision triage", () => {
  const withDecision = (over: Partial<BankSession> = {}, dec: Partial<BankOpenDecision> = {}) =>
    bankOf([
      project({
        projectRoot: over.projectRoot ?? CURRENT,
        name: over.projectName ?? "alpha",
        sessions: [
          session({
            salience: ["needs-you"],
            openDecisionCount: 1,
            openDecisions: [decision({ ageDays: 70, stakes: "high", ...dec })],
            ...over,
          }),
        ],
      }),
    ]);

  it("uses 'another card mentions this' — never the word superseded", async () => {
    stubDaemon(withDecision({}, { likelySuperseded: true, supersededByArtifactId: "art_9" }));
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    expect(screen.getByTestId("bank-mentions-badge").textContent).toBe("another card mentions this");
    expect(screen.queryByText(/superseded/i)).not.toBeInTheDocument();
  });

  it("badges a 70-day-old decision with its age", async () => {
    stubDaemon(withDecision());
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    expect(screen.getByText("70d open")).toBeInTheDocument();
  });

  it("offers close-out for a CURRENT-project decision and confirms before writing", async () => {
    const closeOuts = stubDaemon(withDecision());
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));

    await userEvent.click(screen.getByTestId("bank-close-out"));
    // Misclick-safe: the first click only ARMS it — nothing has been written.
    expect(screen.getByTestId("bank-close-out-confirm")).toBeInTheDocument();
    expect(closeOuts).toHaveLength(0);

    await userEvent.type(screen.getByLabelText(/why are you closing this out/i), "a later card replaced this");
    await userEvent.click(screen.getByRole("button", { name: /confirm close-out/i }));

    // Optimistic: the row is gone before (and regardless of) the response.
    await waitFor(() => expect(screen.queryByTestId("bank-decision")).not.toBeInTheDocument());
    expect(closeOuts).toHaveLength(1);
    expect(closeOuts[0]?.body).toMatchObject({
      projectRoot: CURRENT,
      sessionId: "s1",
      note: "a later card replaced this",
    });
    // Never a choice: no optionId can ride this path.
    expect(closeOuts[0]?.body).not.toHaveProperty("optionId");
  });

  it("cancelling the confirm leaves the decision exactly where it was", async () => {
    const closeOuts = stubDaemon(withDecision());
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    await userEvent.click(screen.getByTestId("bank-close-out"));
    await userEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByTestId("bank-decision")).toBeInTheDocument();
    expect(closeOuts).toHaveLength(0);
  });

  it("rolls the row back and toasts when the daemon refuses (400)", async () => {
    stubDaemon(withDecision(), { closeOutStatus: 400 });
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    await userEvent.click(screen.getByTestId("bank-close-out"));
    await userEvent.click(screen.getByRole("button", { name: /confirm close-out/i }));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    expect(useToastStore.getState().toasts[0]?.kind).toBe("error");
    // The decision is BACK — an optimistic removal that survives a refusal
    // would tell the human a stale loop is closed when it isn't.
    expect(screen.getByTestId("bank-decision")).toBeInTheDocument();
  });

  it("never offers close-out for another project's decision — it offers the switch instead", async () => {
    stubDaemon(withDecision({ projectRoot: OTHER, projectName: "beta" }));
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    expect(screen.queryByTestId("bank-close-out")).not.toBeInTheDocument();
    expect(screen.getByTestId("bank-switch-to-act").textContent).toMatch(/switch to beta to act/i);
  });

  it("routes a cross-project switch at the owning daemon AND the right session", async () => {
    stubDaemon(withDecision({ projectRoot: OTHER, projectName: "beta", sessionId: "s_beta" }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, search: "" });
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    await waitFor(() => expect(useContextBankStore.getState().peers).toHaveLength(1));
    await userEvent.click(screen.getByTestId("bank-switch-to-act"));
    expect(assign).toHaveBeenCalledWith("http://localhost:3900/?session=s_beta");
  });
});

describe("ContextBankView — the counts cannot disagree with the lanes", () => {
  it("does not count a fixture session in 'need you' while the lane quarantines it", async () => {
    const b = bankOf([
      project({
        sessions: [
          session({ sessionId: "demo_1", oneLiner: "the demo thread", fixtureLike: true, salience: ["needs-you"], openDecisionCount: 1, openDecisions: [decision({ stakes: "high", ageDays: 40 })] }),
        ],
      }),
    ]);
    // The server total says 1 — and it is not wrong, it counts every session.
    // The surface must still show what its own lanes show.
    b.totals = { ...b.totals, projects: 1, sessions: 1, needsYou: 1, openDecisions: 1 };
    stubDaemon(b);
    render(<ContextBankView onClose={() => {}} />);
    const totals = await screen.findByTestId("bank-totals");
    expect(totals.textContent).toMatch(/0 need you/);
    expect(totals.textContent).toMatch(/1 demo/);
    expect(within(screen.getByTestId("bank-lane-needs-you")).queryAllByTestId("bank-row")).toHaveLength(0);
  });
});

describe("ContextBankView — a refused close-out keeps the human's note", () => {
  it("restores the typed note (and the armed confirm) after a 400 rollback", async () => {
    stubDaemon(
      bankOf([
        project({
          sessions: [
            session({ salience: ["needs-you"], openDecisionCount: 1, openDecisions: [decision({ ageDays: 70, stakes: "high" })] }),
          ],
        }),
      ]),
      { closeOutStatus: 400 },
    );
    render(<ContextBankView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /replaced the session cache/ }));
    await userEvent.click(screen.getByTestId("bank-close-out"));
    await userEvent.type(screen.getByLabelText(/why are you closing this out/i), "a later card replaced this");
    await userEvent.click(screen.getByRole("button", { name: /confirm close-out/i }));

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    // The optimistic removal remounted the row; the sentence has to come back
    // with it, on the one path where the human is about to retry.
    const restored = await screen.findByLabelText(/why are you closing this out/i);
    expect((restored as HTMLInputElement).value).toBe("a later card replaced this");
  });
});

describe("ContextBankView — chrome details", () => {
  it("shows a disclosure caret that flips when the row expands", async () => {
    stubDaemon(bankOf([project({ sessions: [session()] })]));
    render(<ContextBankView onClose={() => {}} />);
    const row = await screen.findByRole("button", { name: /replaced the session cache/ });
    expect(row.textContent?.startsWith("\u25b8")).toBe(true);
    await userEvent.click(row);
    expect(screen.getByRole("button", { name: /replaced the session cache/ }).textContent?.startsWith("\u25be")).toBe(true);
  });

  it("keeps the 'partially read' chip OFF amber so amber stays attention-only", async () => {
    stubDaemon(bankOf([project({ sessions: [session({ degraded: true, degradedReason: "unreadable" })] })]));
    render(<ContextBankView onClose={() => {}} />);
    const chip = await screen.findByTestId("bank-degraded");
    expect(chip.className).not.toMatch(/accent-amber/);
    expect(chip.className).toMatch(/surface-secondary/);
  });
});
