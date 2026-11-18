import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { ArtifactDetail } from "../ArtifactPanel";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";

/** #668 item 3 (Mitch, 11-18) — keep Respond; one artifact-level composer while drafting. */
const mk = (type: string, content: any, over: any = {}) =>
  ({ id: over.id ?? "art1", sessionId: "s1", type, title: "t", status: "draft", version: 1, parentId: null,
    createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", agentReasoning: null, content, ...over }) as any;
const comment = (artifactId: string, content: string) =>
  ({ id: `c_${content}`, author: "human", content, createdAt: "2026-06-01T00:00:01.000Z", parentCommentId: null,
    target: { artifactId } }) as any;
const research = (over: any = {}) => mk("research", { summary: "s", findings: [] }, over);

beforeEach(() => {
  vi.restoreAllMocks();
  useArtifactStore.getState().reset();
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], disconnectedSince: null } as any);
});

describe("#668 item 3 — single Respond box on a reviewable draft", () => {
  it("draft with no comments: no Comments composer under Respond", async () => {
    const a = research();
    useArtifactStore.setState({ artifacts: [a], comments: {} } as any);
    render(<ArtifactDetail artifact={a} />);
    await screen.findByPlaceholderText(/Respond to the agent on this artifact/);
    expect(screen.queryByPlaceholderText(/Add a comment/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Comments" })).toBeNull();
  });

  it("draft with comments: the thread stays readable but has no composer", async () => {
    const a = research();
    useArtifactStore.setState({ artifacts: [a], comments: { [a.id]: [comment(a.id, "EARLIER-NOTE")] } } as any);
    render(<ArtifactDetail artifact={a} />);
    await screen.findByText("EARLIER-NOTE");
    expect(screen.getByRole("heading", { name: "Comments" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Add a comment/)).toBeNull();
    expect(screen.queryByText(/this artifact is read-only/)).toBeNull();
  });

  it("approved: Respond is gone, so the Comments composer comes back for follow-ups", async () => {
    const a = research({ status: "approved" });
    useArtifactStore.setState({ artifacts: [a], comments: {} } as any);
    render(<ArtifactDetail artifact={a} />);
    expect(await screen.findByPlaceholderText(/Add a comment/)).toBeInTheDocument();
  });

  it("Ask sits beside Respond and posts the same text as a question", async () => {
    const a = mk("plan", { steps: [] });
    const submitComment = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ artifacts: [a], submitComment } as any);
    render(<ArtifactStatusActions artifact={a} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "why this order?" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ask" })); });
    expect(submitComment).toHaveBeenCalledWith("art1", "why this order?", undefined, { intent: "question" });
  });

  it("Respond still posts a plain comment", async () => {
    const a = mk("plan", { steps: [] });
    const submitComment = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ artifacts: [a], submitComment } as any);
    render(<ArtifactStatusActions artifact={a} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "looks close" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Respond" })); });
    expect(submitComment).toHaveBeenCalledWith("art1", "looks close");
  });

  it("debrief keeps its own ask-anything composer: no Ask beside Respond", () => {
    const a = mk("debrief", { summary: "s" });
    useArtifactStore.setState({ artifacts: [a] } as any);
    render(<ArtifactStatusActions artifact={a} />);
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
  });
});
