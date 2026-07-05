import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ReplyModeToggle, type ReplyMode } from "../ReplyModeToggle";

function Harness({ initial = "comment" as ReplyMode }) {
  const [mode, setMode] = useState<ReplyMode>(initial);
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <ReplyModeToggle mode={mode} setMode={setMode} />
    </div>
  );
}

describe("ReplyModeToggle", () => {
  it("renders both segments and marks the active one pressed", () => {
    render(<Harness />);
    const comment = screen.getByRole("button", { name: /^comment$/i });
    const ask = screen.getByRole("button", { name: /^ask$/i });
    expect(comment).toBeInTheDocument();
    expect(ask).toBeInTheDocument();
    // Default is comment: comment pressed, ask not.
    expect(comment).toHaveAttribute("aria-pressed", "true");
    expect(ask).toHaveAttribute("aria-pressed", "false");
  });

  it("flips to question mode when Ask is clicked and back on Comment", async () => {
    render(<Harness />);
    expect(screen.getByTestId("mode")).toHaveTextContent("comment");

    await userEvent.click(screen.getByRole("button", { name: /^ask$/i }));
    expect(screen.getByTestId("mode")).toHaveTextContent("question");
    expect(screen.getByRole("button", { name: /^ask$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^comment$/i })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: /^comment$/i }));
    expect(screen.getByTestId("mode")).toHaveTextContent("comment");
  });

  it("calls setMode with the chosen mode", async () => {
    const setMode = vi.fn();
    render(<ReplyModeToggle mode="comment" setMode={setMode} />);
    await userEvent.click(screen.getByRole("button", { name: /^ask$/i }));
    expect(setMode).toHaveBeenCalledWith("question");
  });
});
