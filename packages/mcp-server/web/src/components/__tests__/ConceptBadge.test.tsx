import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConceptBadge } from "../ConceptBadge";
import { useLedgerStore, resetLedgerStoreForTests } from "../../stores/ledger";

beforeEach(() => {
  resetLedgerStoreForTests();
  // non-ok → the store keeps digest null unless a test seeds it explicitly.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
});

const DIGEST = {
  shapedThisProject: 0,
  nearMissesThisProject: 0,
  blockedThisProject: 0,
  sessionsTouched: 1,
  topCitedStances: [
    { concept: "pay-per-request hosting", source: "session" as const, citationCount: 1, globalCitationCount: 3 },
  ],
  seededStances: [
    { concept: "pay-per-request hosting", stance: "avoid" as const, citedTimesElsewhere: 2 },
    { concept: "fakes over mocks", stance: "prefer" as const, citedTimesElsewhere: 0 },
  ],
  globalLedger: { concepts: 5, projects: 2, multiProjectConcepts: 1 },
};

describe("ConceptBadge (Y5)", () => {
  it("renders the concept name", () => {
    render(<ConceptBadge name="dependency inversion" />);
    expect(screen.getByText("dependency inversion")).toBeInTheDocument();
  });

  it("does not render an expand chevron when no explanation is supplied", () => {
    render(<ConceptBadge name="just a name" />);
    expect(screen.queryByText("▸")).not.toBeInTheDocument();
    expect(screen.queryByText("▾")).not.toBeInTheDocument();
  });

  it("renders the chevron and toggles the explanation on click when explanation is set", async () => {
    const user = userEvent.setup();
    render(
      <ConceptBadge
        name="optimistic UI"
        explanation="render the success state immediately, roll back on server error"
      />,
    );
    expect(screen.getByText("▸")).toBeInTheDocument();
    expect(
      screen.queryByText(/render the success state immediately/),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Concept: optimistic UI/i }));
    expect(
      screen.getByText(/render the success state immediately/),
    ).toBeInTheDocument();
    expect(screen.getByText("▾")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Concept: optimistic UI/i }));
    expect(
      screen.queryByText(/render the success state immediately/),
    ).not.toBeInTheDocument();
  });

  it("ignores blank-string explanations (treats them as missing)", () => {
    render(<ConceptBadge name="x" explanation="   " />);
    expect(screen.queryByText("▸")).not.toBeInTheDocument();
  });

  it("stops click propagation so a parent option-card click handler doesn't fire", async () => {
    const user = userEvent.setup();
    let parentClicked = false;
    render(
      <div onClick={() => { parentClicked = true; }}>
        <ConceptBadge name="x" explanation="y" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: /Concept: x/i }));
    expect(parentClicked).toBe(false);
  });
});

describe("B4 — ledger-aware ConceptBadge (the learning loop)", () => {
  it("shows recurrence + stance when the ledger knows the concept (case-insensitive)", () => {
    useLedgerStore.setState({ digest: DIGEST as any });
    render(<ConceptBadge name="Pay-Per-Request Hosting" />);
    expect(screen.getByText(/seen 3×/)).toBeInTheDocument();
    expect(screen.getByText(/you avoid this/)).toBeInTheDocument();
  });

  it("a 'prefer' stance renders the positive-alignment pip", () => {
    useLedgerStore.setState({ digest: DIGEST as any });
    render(<ConceptBadge name="fakes over mocks" />);
    expect(screen.getByText(/matches your preference/)).toBeInTheDocument();
    // count is 0 → no noisy 'seen 0×'
    expect(screen.queryByText(/seen/)).not.toBeInTheDocument();
  });

  it("stays a plain badge for a concept the ledger doesn't know", () => {
    useLedgerStore.setState({ digest: DIGEST as any });
    render(<ConceptBadge name="something brand new" />);
    expect(screen.queryByText(/seen/)).not.toBeInTheDocument();
    expect(screen.queryByText("▸")).not.toBeInTheDocument(); // not expandable either
  });

  it("expands (even without an explanation) and deep-links into the ledger drawer", async () => {
    const user = userEvent.setup();
    useLedgerStore.setState({ digest: DIGEST as any });
    let detail: any = null;
    const listener = (e: Event) => { detail = (e as CustomEvent).detail; };
    window.addEventListener("dp:open-your-taste", listener);

    render(<ConceptBadge name="pay-per-request hosting" />);
    await user.click(screen.getByRole("button", { name: /Concept: pay-per-request hosting/i }));
    await user.click(screen.getByRole("button", { name: /view in your ledger/i }));
    expect(detail).toMatchObject({ initialTab: "ledger", highlightConcept: "pay-per-request hosting" });

    window.removeEventListener("dp:open-your-taste", listener);
  });

  it("the deep-link click does NOT bubble to a parent option-card handler", async () => {
    const user = userEvent.setup();
    useLedgerStore.setState({ digest: DIGEST as any });
    let parentClicked = false;
    render(
      <div onClick={() => { parentClicked = true; }}>
        <ConceptBadge name="pay-per-request hosting" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: /Concept: pay-per-request hosting/i }));
    await user.click(screen.getByRole("button", { name: /view in your ledger/i }));
    expect(parentClicked).toBe(false);
  });
});
