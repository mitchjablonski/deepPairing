import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArtifactPanel } from "../ArtifactPanel";
import { useArtifactStore } from "../../stores/artifact";
import { useSessionStore } from "../../stores/session";
import { researchArtifact, planArtifact } from "@deeppairing/shared/src/__fixtures__/artifacts";

beforeEach(() => {
  useArtifactStore.setState({
    artifacts: [],
    comments: {},
    selectedArtifactId: null,
  });
  useSessionStore.setState({
    sessionId: "sess_test",
    status: "gathering",
    events: [],
    error: null,
  });
});

describe("ArtifactPanel", () => {
  it("shows empty state when no artifacts", () => {
    render(<ArtifactPanel />);
    expect(screen.getByText(/artifacts will appear/i)).toBeInTheDocument();
  });

  it("renders type tabs and artifact titles", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact, planArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    // Type tabs
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Plans")).toBeInTheDocument();
    // Selected artifact title visible
    expect(screen.getAllByText("Authentication System Analysis").length).toBeGreaterThan(0);
  });

  it("shows status badges on artifacts", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    expect(screen.getAllByText("draft").length).toBeGreaterThan(0);
  });

  it("renders research artifact detail when selected", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    // Research content — findings now have titles and rich evidence
    expect(screen.getByText(/areas for improvement/)).toBeInTheDocument();
    expect(screen.getAllByText("Security").length).toBeGreaterThan(0);
    expect(screen.getByText("Weak Password Hashing")).toBeInTheDocument();
  });

  it("renders plan artifact detail when selected", () => {
    useArtifactStore.setState({
      artifacts: [planArtifact],
      selectedArtifactId: planArtifact.id,
    });
    render(<ArtifactPanel />);

    expect(screen.getByText(/Implementation Steps/)).toBeInTheDocument();
    expect(screen.getByText(/Create AuthService class/)).toBeInTheDocument();
  });

  it("shows approve/revise/reject buttons for draft artifacts", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Request Revision")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
  });

  it("shows revision textarea when Request Revision is clicked", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    fireEvent.click(screen.getByText("Request Revision"));
    expect(screen.getByPlaceholderText("What should be changed?")).toBeInTheDocument();
  });

  it("switches selected artifact when clicking type tab", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact, planArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    // Click the Plans tab — should select the plan artifact
    fireEvent.click(screen.getByText("Plans"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe(planArtifact.id);
  });

  it("hides superseded artifacts from tabs", () => {
    const superseded = { ...researchArtifact, status: "superseded" as const };
    useArtifactStore.setState({
      artifacts: [superseded, planArtifact],
      selectedArtifactId: planArtifact.id,
    });
    render(<ArtifactPanel />);

    // Only Plans tab visible, no Research tab
    expect(screen.getByText("Plans")).toBeInTheDocument();
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });
});
