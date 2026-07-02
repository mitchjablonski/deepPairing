import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionWrapCard } from "../SessionWrapCard";
import { useArtifactStore } from "../../stores/artifact";

const art = (over: Record<string, unknown> = {}) =>
  ({
    id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null,
    title: "t", status: "approved", content: {}, agentReasoning: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }) as any;

describe("D9 (H3) — SessionWrapCard", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useArtifactStore.getState().reset();
  });

  it("shows counts and concept chips for the wrapped session", () => {
    useArtifactStore.setState({
      artifacts: [
        art(),
        art({ id: "a2", type: "decision", content: { concept: { name: "fakes over mocks" } } }),
      ],
    });
    render(<SessionWrapCard sessionId="s1" />);
    expect(screen.getByText(/Session wrapped/)).toBeInTheDocument();
    expect(screen.getByText("fakes over mocks")).toBeInTheDocument();
    expect(screen.getByText(/2 artifacts/)).toBeInTheDocument();
  });

  it("harvests concepts that live ONLY on decision options (the normal Y5 shape)", () => {
    useArtifactStore.setState({
      artifacts: [
        art({
          id: "a3", type: "decision",
          content: { options: [{ concept: { name: "event sourcing" } }, { concept: { name: "CRUD" } }] },
        }),
      ],
    });
    render(<SessionWrapCard sessionId="s1" />);
    expect(screen.getByText("event sourcing")).toBeInTheDocument();
    expect(screen.getByText("CRUD")).toBeInTheDocument();
  });

  it("refuses to claim 'wrapped' over pending work (draft present)", () => {
    useArtifactStore.setState({ artifacts: [art({ status: "draft" })] });
    render(<SessionWrapCard sessionId="s1" />);
    expect(screen.queryByText(/Session wrapped/)).toBeNull();
  });

  it("dismiss persists per session", () => {
    useArtifactStore.setState({ artifacts: [art()] });
    const { unmount } = render(<SessionWrapCard sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Dismiss session recap"));
    unmount();
    render(<SessionWrapCard sessionId="s1" />);
    expect(screen.queryByText(/Session wrapped/)).toBeNull();
    // A DIFFERENT session is unaffected.
    render(<SessionWrapCard sessionId="s2" />);
    expect(screen.getByText(/Session wrapped/)).toBeInTheDocument();
  });
});
