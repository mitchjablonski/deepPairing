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

  it("renders artifact list with type icons", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact, planArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    expect(screen.getAllByText("Authentication System Analysis").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Auth Refactoring Plan").length).toBeGreaterThan(0);
    expect(screen.getByText("Artifacts (2)")).toBeInTheDocument();
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

    // Research content
    expect(screen.getByText(/areas for improvement/)).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(screen.getByText(/Bcrypt with 10 salt rounds/)).toBeInTheDocument();
  });

  it("renders plan artifact detail when selected", () => {
    useArtifactStore.setState({
      artifacts: [planArtifact],
      selectedArtifactId: planArtifact.id,
    });
    render(<ArtifactPanel />);

    expect(screen.getByText(/Implementation Steps/)).toBeInTheDocument();
    expect(screen.getByText("Create AuthService class")).toBeInTheDocument();
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

  it("switches selected artifact on click", () => {
    useArtifactStore.setState({
      artifacts: [researchArtifact, planArtifact],
      selectedArtifactId: researchArtifact.id,
    });
    render(<ArtifactPanel />);

    fireEvent.click(screen.getByText("Auth Refactoring Plan"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe(planArtifact.id);
  });

  it("hides superseded artifacts from the list", () => {
    const superseded = { ...researchArtifact, status: "superseded" as const };
    useArtifactStore.setState({
      artifacts: [superseded, planArtifact],
      selectedArtifactId: planArtifact.id,
    });
    render(<ArtifactPanel />);

    expect(screen.getByText("Artifacts (1)")).toBeInTheDocument();
  });
});
