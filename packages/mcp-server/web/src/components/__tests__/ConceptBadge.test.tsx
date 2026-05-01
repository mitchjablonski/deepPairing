import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConceptBadge } from "../ConceptBadge";

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
