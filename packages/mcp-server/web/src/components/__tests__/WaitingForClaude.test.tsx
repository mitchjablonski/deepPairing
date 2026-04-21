import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { WaitingForClaude } from "../WaitingForClaude";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WaitingForClaude", () => {
  it("renders the heading and a 'try this' suggestion even before daemon-info loads", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never resolves
    render(<WaitingForClaude />);
    expect(screen.getByRole("status", { name: /waiting for claude/i })).toBeInTheDocument();
    expect(screen.getByText(/try this/i)).toBeInTheDocument();
    // Suggestion text is randomized from a fixed list — just check one is rendered.
    const code = screen.getByRole("status").querySelector("code");
    expect(code?.textContent?.length ?? 0).toBeGreaterThan(10);
  });

  it("surfaces daemon PID + projectRoot once /api/daemon-info loads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pid: 12345,
        projectRoot: "/home/user/important-project",
        startedAt: "2026-04-20T10:00:00Z",
      }),
    }));
    render(<WaitingForClaude />);
    await waitFor(() => expect(screen.getByText(/PID 12345/)).toBeInTheDocument());
    expect(screen.getByText(/\/home\/user\/important-project/)).toBeInTheDocument();
    expect(screen.getByText(/wrong project\?/i)).toBeInTheDocument();
    expect(screen.getByText(/npx deeppairing doctor/)).toBeInTheDocument();
  });

  it("doesn't surface the PID block when daemon-info fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<WaitingForClaude />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/PID/i)).not.toBeInTheDocument();
    // Primary content still renders
    expect(screen.getByRole("status", { name: /waiting for claude/i })).toBeInTheDocument();
  });
});
