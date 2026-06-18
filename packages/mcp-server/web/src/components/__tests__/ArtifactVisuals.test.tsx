import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { useArtifactStore } from "../../stores/artifact";

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("ArtifactVisuals", () => {
  it("renders nothing when there are no visuals", () => {
    const { container } = render(<ArtifactVisuals artifactId="a" visuals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a file_map as a directory tree with a change summary + per-visual comment affordance", () => {
    render(
      <ArtifactVisuals
        artifactId="a"
        visuals={[
          {
            id: "fm",
            kind: "file_map",
            title: "What I'll touch",
            files: [
              { path: "src/api/routes.ts", change: "create", note: "new route" },
              { path: "src/api/handlers.ts", change: "create" },
              { path: "src/db.ts", change: "modify" },
              { path: "old.ts", change: "delete" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("Visuals (1)")).toBeInTheDocument();
    expect(screen.getByText("What I'll touch")).toBeInTheDocument();
    // Directory nodes collapse shared prefixes; leaf files render under them.
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.getByText("api/")).toBeInTheDocument();
    expect(screen.getByText("routes.ts")).toBeInTheDocument();
    expect(screen.getByText("handlers.ts")).toBeInTheDocument();
    expect(screen.getByText("db.ts")).toBeInTheDocument();
    expect(screen.getByText("old.ts")).toBeInTheDocument();
    // The change summary line.
    expect(screen.getByText("+2 new")).toBeInTheDocument();
    expect(screen.getByText("~1 changed")).toBeInTheDocument();
    expect(screen.getByText("−1 removed")).toBeInTheDocument();
    expect(screen.getByText(/new route/)).toBeInTheDocument();
    // Commentable (CommentTrigger/AskTrigger render buttons).
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("renders a prototype as a click-to-run sandboxed frame (html not injected into the page)", () => {
    render(<ArtifactVisuals artifactId="a" visuals={[{ id: "p", kind: "prototype", html: "<button>hi</button>" }]} />);
    expect(screen.getByText(/sandboxed . no network/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
    // The raw agent HTML never lands in the parent DOM.
    expect(screen.queryByText("hi")).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull(); // not until the user opts in
  });
});
