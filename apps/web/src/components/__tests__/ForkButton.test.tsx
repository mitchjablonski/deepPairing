import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ForkButton } from "../ForkButton";

describe("ForkButton", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Explore button in idle state", () => {
    render(
      <ForkButton
        sessionId="sess_1"
        decisionId="dec_1"
        optionId="opt_a"
        optionTitle="Option A"
      />,
    );
    expect(screen.getByText("Explore")).toBeInTheDocument();
  });

  it("shows Starting... state on click", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ forkId: "fork_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ForkButton
        sessionId="sess_1"
        decisionId="dec_1"
        optionId="opt_a"
        optionTitle="Option A"
      />,
    );

    fireEvent.click(screen.getByText("Explore"));

    await vi.waitFor(() => {
      expect(screen.getByText("Exploring...")).toBeInTheDocument();
    });
  });

  it("is disabled when disabled prop is true", () => {
    render(
      <ForkButton
        sessionId="sess_1"
        decisionId="dec_1"
        optionId="opt_a"
        optionTitle="Option A"
        disabled
      />,
    );

    const button = screen.getByText("Explore");
    expect(button).toBeDisabled();
  });

  it("calls the correct API endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ forkId: "fork_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ForkButton
        sessionId="sess_1"
        decisionId="dec_1"
        optionId="opt_b"
        optionTitle="Option B"
      />,
    );

    fireEvent.click(screen.getByText("Explore"));

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/sessions/sess_1/decisions/dec_1/fork"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("opt_b"),
        }),
      );
    });
  });
});
