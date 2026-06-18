import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlanVisuals } from "../PlanVisuals";
import { useArtifactStore } from "../../stores/artifact";

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("PlanVisuals", () => {
  it("renders nothing when the plan has no visuals", () => {
    const { container } = render(<PlanVisuals artifactId="a" visuals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a file_map with paths/notes and a per-visual comment affordance", () => {
    render(
      <PlanVisuals
        artifactId="a"
        visuals={[
          {
            id: "fm",
            kind: "file_map",
            title: "What I'll touch",
            files: [
              { path: "src/api.ts", change: "create", note: "new route" },
              { path: "src/db.ts", change: "modify" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("Visuals (1)")).toBeInTheDocument();
    expect(screen.getByText("What I'll touch")).toBeInTheDocument();
    expect(screen.getByText("src/api.ts")).toBeInTheDocument();
    expect(screen.getByText(/new route/)).toBeInTheDocument();
    expect(screen.getByText("src/db.ts")).toBeInTheDocument();
    // The block is commentable (CommentTrigger/AskTrigger render buttons).
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("shows a sandboxed placeholder for prototypes (the iframe lands in its own PR)", () => {
    render(<PlanVisuals artifactId="a" visuals={[{ id: "p", kind: "prototype", html: "<button>hi</button>" }]} />);
    expect(screen.getByText(/sandboxed rendering ships/i)).toBeInTheDocument();
    // The raw HTML is NOT injected into the page in this placeholder.
    expect(screen.queryByText("hi")).not.toBeInTheDocument();
  });
});
