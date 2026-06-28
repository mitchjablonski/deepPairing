import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastLayer } from "../ToastLayer";
import { useToastStore, type PreflightBlockHero } from "../../stores/toast";

beforeEach(() => {
  useToastStore.getState().dismissAll();
});

function push(kind: any, opts: any) {
  act(() => {
    useToastStore.getState().push({ kind, title: "t", ...opts });
  });
}

function heroOf(overrides: Partial<PreflightBlockHero> = {}): PreflightBlockHero {
  return {
    source: "session",
    concept: "optimistic UI rollback",
    proposal: "add an optimistic rollback to the form",
    reason: "kept triggering stale-data flashes last quarter",
    via: "concept",
    ...overrides,
  };
}

describe("ToastLayer", () => {
  it("U1 — keeps the live region mounted (but empty) when the queue is empty, so SRs announce reliably", () => {
    const { container } = render(<ToastLayer />);
    const region = container.querySelector('[role="status"]');
    expect(region).toBeInTheDocument(); // always present (not gated on toast count)
    expect(region?.children.length).toBe(0); // but no toasts yet
  });

  it("U1 — error toasts are assertive (role=alert) so they interrupt rather than queue", () => {
    push("error", { title: "Send failed", body: "the daemon rejected it" });
    render(<ToastLayer />);
    expect(screen.getByRole("alert")).toHaveTextContent("Send failed");
  });

  it("renders a generic toast with title + body", () => {
    push("info", { title: "Heads up", body: "something happened" });
    render(<ToastLayer />);
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("something happened")).toBeInTheDocument();
  });

  it("dismisses on click", async () => {
    push("info", { title: "Dismiss me" });
    render(<ToastLayer />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("Dismiss me")).not.toBeInTheDocument();
  });

  describe("preflight-block hero (O2)", () => {
    it("renders the hero card shape with concept, reason, and source attribution (session)", () => {
      push("preflight-block", { title: "x", hero: heroOf({ source: "session" }) });
      render(<ToastLayer />);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/blocked by your taste/i)).toBeInTheDocument();
      expect(screen.getByText(/optimistic UI rollback/)).toBeInTheDocument();
      expect(screen.getByText(/stale-data flashes/)).toBeInTheDocument();
      expect(screen.getByText(/your personal taste/i)).toBeInTheDocument();
      expect(screen.getByText(/matched by underlying concept/i)).toBeInTheDocument();
    });

    it("attributes to team policy and includes addedBy when source is team", () => {
      push("preflight-block", { title: "x", hero: heroOf({ source: "team", via: "avoid", addedBy: "alex", reason: "use the repository pattern" }) });
      render(<ToastLayer />);
      expect(screen.getByText(/blocked by team policy/i)).toBeInTheDocument();
      expect(screen.getByText(/team policy \(added by alex\)/i)).toBeInTheDocument();
      expect(screen.getByText(/matches a team 'avoid' rule/i)).toBeInTheDocument();
    });

    it("surfaces 'missing team-required approach' copy for require violations", () => {
      push("preflight-block", { title: "x", hero: heroOf({ source: "team", via: "require" }) });
      render(<ToastLayer />);
      expect(screen.getByText(/missing team-required approach/i)).toBeInTheDocument();
    });

    it("renders the action button and invokes the handler on click", async () => {
      const onAction = vi.fn();
      push("preflight-block", {
        title: "x",
        hero: heroOf({ source: "session" }),
        action: { label: "Open Your taste", onClick: onAction },
      });
      render(<ToastLayer />);
      await userEvent.click(screen.getByRole("button", { name: /open your taste/i }));
      expect(onAction).toHaveBeenCalled();
    });

    it("shows project count when >1 (personal philosophy that spans projects)", () => {
      push("preflight-block", { title: "x", hero: heroOf({ source: "session", projectCount: 3 }) });
      render(<ToastLayer />);
      expect(screen.getByText(/3 projects/)).toBeInTheDocument();
    });

    it("shows humanized age when rejectedAt is provided", () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      push("preflight-block", { title: "x", hero: heroOf({ rejectedAt: fiveDaysAgo }) });
      render(<ToastLayer />);
      expect(screen.getByText(/5 days ago/i)).toBeInTheDocument();
    });

    it("hides the 'proposed' line when it equals the concept (no redundancy)", () => {
      push("preflight-block", {
        title: "x",
        hero: heroOf({ concept: "global state", proposal: "global state", reason: "r" }),
      });
      render(<ToastLayer />);
      // The concept renders; a separate "Proposed: global state" line should NOT.
      expect(screen.queryByText(/proposed:/i)).not.toBeInTheDocument();
    });

    it("offers 'Not my taste' on a personal block, and clicking it overrides + dismisses", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "overridden", retired: 1 }) });
      vi.stubGlobal("fetch", fetchMock);
      push("preflight-block", {
        title: "x",
        hero: heroOf({ source: "session", concept: "pay-per-request hosting", description: "Deploy: Railway", via: "concept" }),
      });
      render(<ToastLayer />);
      await userEvent.click(screen.getByRole("button", { name: /not my taste/i }));
      // POSTs the override with the stance identity (description + concept).
      const call = fetchMock.mock.calls.find((c: any) => String(c[0]).includes("/api/philosophy/override"));
      expect(call).toBeTruthy();
      const body = JSON.parse(call![1].body);
      expect(body).toMatchObject({ source: "session", description: "Deploy: Railway", concept: "pay-per-request hosting" });
      // The block toast is dismissed after overriding.
      expect(screen.queryByText("Blocked by your taste")).not.toBeInTheDocument();
      vi.unstubAllGlobals();
    });

    it("does NOT offer override on a team block — points to team.json instead", () => {
      push("preflight-block", { title: "x", hero: heroOf({ source: "team", via: "avoid" }) });
      render(<ToastLayer />);
      expect(screen.queryByRole("button", { name: /not my taste/i })).not.toBeInTheDocument();
      expect(screen.getByText(/edit team\.json/i)).toBeInTheDocument();
    });
  });
});
