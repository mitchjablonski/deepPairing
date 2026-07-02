import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { useArtifactStore } from "../../stores/artifact";

const artifact = {
  id: "res_1", sessionId: "s1", type: "research", version: 1, parentId: null,
  title: "Audit", status: "draft", agentReasoning: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  content: {
    summary: "s",
    findings: [0, 1, 2, 3].map((i) => ({
      category: "Security", title: `Finding ${i + 1}`, detail: "d", significance: "medium",
    })),
  },
} as any;

function seedVerdict(findingIndex: number, text: string) {
  useArtifactStore.setState((s: any) => ({
    comments: {
      ...s.comments,
      res_1: [
        ...(s.comments.res_1 ?? []),
        {
          id: `v_${findingIndex}`, sessionId: "s1", author: "human", content: text,
          target: { artifactId: "res_1", findingIndex, sectionId: "verdict" },
          createdAt: new Date().toISOString(),
        },
      ],
    },
  }));
}

beforeEach(() => useArtifactStore.getState().reset());

describe("C5 — triage progress strip", () => {
  it("counts reviewed findings from verdict comments and exposes per-finding chips", () => {
    seedVerdict(0, "Approved — finding #1");
    seedVerdict(2, "Rejected: nope");
    render(<ResearchArtifact artifact={artifact} />);

    expect(screen.getByText(/reviewed 2 \/ 4/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finding 1: approved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finding 2: not reviewed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finding 3: rejected/i })).toBeInTheDocument();
  });

  it("'Next unreviewed' retargets the focus carousel to the first hollow chip", () => {
    seedVerdict(0, "Approved");
    render(<ResearchArtifact artifact={artifact} />);
    // Focus mode makes the jump observable without DOM scrolling: the
    // carousel header shows the target index.
    fireEvent.click(screen.getByRole("button", { name: /^focus$/i }));
    fireEvent.click(screen.getByRole("button", { name: /next unreviewed/i }));
    expect(screen.getByText(/2 \/ 4/)).toBeInTheDocument();
  });

  it("hides below 3 findings (no noise on small artifacts)", () => {
    const small = { ...artifact, content: { summary: "s", findings: artifact.content.findings.slice(0, 2) } };
    render(<ResearchArtifact artifact={small} />);
    expect(screen.queryByText(/reviewed \d/i)).not.toBeInTheDocument();
  });
});
