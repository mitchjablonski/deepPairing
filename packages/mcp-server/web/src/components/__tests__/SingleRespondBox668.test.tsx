import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
const cleanupAll = () => cleanup();
const research = (over: any = {}) => mk("research", { summary: "s", findings: [] }, over);

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
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

describe("Sol (#672) — Respond owns the saved Comments draft", () => {
  const KEY = "dp:draft:comment:art1:{}";
  const box = () => screen.getByPlaceholderText(/Respond to the agent on this artifact/) as HTMLTextAreaElement;

  it("a pre-existing saved Comments draft loads into Respond (not stranded)", async () => {
    sessionStorage.setItem(KEY, "half-written thought");
    const a = research();
    useArtifactStore.setState({ artifacts: [a], comments: {} } as any);
    render(<ArtifactDetail artifact={a} />);
    expect((await screen.findByPlaceholderText(/Respond to the agent on this artifact/) as HTMLTextAreaElement).value).toBe("half-written thought");
  });

  it("Respond text survives a remount (reload / re-entry)", () => {
    const a = mk("plan", { steps: [] });
    useArtifactStore.setState({ artifacts: [a] } as any);
    const first = render(<ArtifactStatusActions artifact={a} />);
    fireEvent.change(box(), { target: { value: "keep this across reload" } });
    first.unmount();
    render(<ArtifactStatusActions artifact={a} />);
    expect(box().value).toBe("keep this across reload");
  });

  it("Respond and Ask success both retire the saved draft", async () => {
    for (const verb of ["Respond", "Ask"]) {
      sessionStorage.clear();
      const a = mk("plan", { steps: [] });
      const submitComment = vi.fn().mockResolvedValue(undefined);
      useArtifactStore.setState({ artifacts: [a], submitComment } as any);
      const r = render(<ArtifactStatusActions artifact={a} />);
      fireEvent.change(box(), { target: { value: `sent via ${verb}` } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: verb })); });
      expect(box().value).toBe("");
      r.unmount();
      render(<ArtifactStatusActions artifact={a} />);
      expect(box().value).toBe("");
      cleanupAll();
    }
  });

  it("a stale completion does not clear text typed after the send", async () => {
    const a = mk("plan", { steps: [] });
    let resolve!: () => void;
    const submitComment = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    useArtifactStore.setState({ artifacts: [a], submitComment } as any);
    render(<ArtifactStatusActions artifact={a} />);
    fireEvent.change(box(), { target: { value: "first" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Respond" })); });
    fireEvent.change(box(), { target: { value: "first, and a follow-up" } });
    await act(async () => { resolve(); });
    expect(box().value).toBe("first, and a follow-up");
  });

  it("the footer is the eligible editor only where it renders: an approved artifact uses the thread", async () => {
    sessionStorage.setItem(KEY, "after approval");
    const a = research({ status: "approved" });
    useArtifactStore.setState({ artifacts: [a], comments: {} } as any);
    render(<ArtifactDetail artifact={a} />);
    expect((await screen.findByPlaceholderText(/Add a comment/) as HTMLTextAreaElement).value).toBe("after approval");
  });
});

describe("Sol (#672) follow-up — same-mounted transitions and the raw-text fence", () => {
  const box = () => screen.getByPlaceholderText(/Respond to the agent on this artifact/) as HTMLTextAreaElement;

  it("a mounted draft turning approved renders the follow-up editor (no hook-order crash)", async () => {
    const a = research();
    useArtifactStore.setState({ artifacts: [a], comments: {} } as any);
    const { rerender } = render(<ArtifactDetail artifact={a} />);
    await screen.findByPlaceholderText(/Respond to the agent on this artifact/);
    const approved = { ...a, status: "approved" };
    act(() => { useArtifactStore.setState({ artifacts: [approved] } as any); });
    rerender(<ArtifactDetail artifact={approved} />);
    expect(await screen.findByPlaceholderText(/Add a comment/)).toBeInTheDocument();
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
  });

  it("replay starting on a mounted draft freezes it without crashing", async () => {
    const a = research();
    useArtifactStore.setState({ artifacts: [a], comments: {} } as any);
    render(<ArtifactDetail artifact={a} />);
    await screen.findByPlaceholderText(/Respond to the agent on this artifact/);
    act(() => { useReplayStore.setState({ active: true } as any); });
    expect(screen.queryByPlaceholderText(/Respond to the agent on this artifact/)).toBeNull();
    act(() => { useReplayStore.setState({ active: false } as any); });
    expect(await screen.findByPlaceholderText(/Respond to the agent on this artifact/)).toBeInTheDocument();
  });

  it("a whitespace-only edit during an in-flight send is kept (editor and saved draft)", async () => {
    const a = mk("plan", { steps: [] });
    let resolve!: () => void;
    const submitComment = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    useArtifactStore.setState({ artifacts: [a], submitComment } as any);
    const first = render(<ArtifactStatusActions artifact={a} />);
    fireEvent.change(box(), { target: { value: "note" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Respond" })); });
    fireEvent.change(box(), { target: { value: "note\n" } });
    await act(async () => { resolve(); });
    expect(box().value).toBe("note\n");
    first.unmount();
    render(<ArtifactStatusActions artifact={a} />);
    expect(box().value).toBe("note\n");
  });
});

describe("Sol (#672) — the read-only thread holds no writer on Respond's draft key", () => {
  const KEY = "dp:draft:comment:art1:{}";
  const respondBox = () => screen.getByPlaceholderText(/Respond to the agent on this artifact/) as HTMLTextAreaElement;

  it("existing comment + new Respond text survive pagehide and remount, then move to the follow-up editor on approval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      sessionStorage.setItem(KEY, "older saved text");
      const a = research();
      useArtifactStore.setState({ artifacts: [a], comments: { [a.id]: [comment(a.id, "EARLIER-NOTE")] } } as any);
      const first = render(<ArtifactDetail artifact={a} />);
      await screen.findByText("EARLIER-NOTE");
      fireEvent.change(respondBox(), { target: { value: "newer respond text" } });
      act(() => { vi.advanceTimersByTime(400); }); // debounced writes settle
      act(() => { window.dispatchEvent(new Event("pagehide")); });
      expect(sessionStorage.getItem(KEY)).toBe("newer respond text");
      first.unmount();
      expect(sessionStorage.getItem(KEY)).toBe("newer respond text");

      const second = render(<ArtifactDetail artifact={a} />);
      await screen.findByText("EARLIER-NOTE");
      expect(respondBox().value).toBe("newer respond text");

      // Approved elsewhere: the thread becomes the editor and shows the live draft.
      const approved = { ...a, status: "approved" };
      act(() => { useArtifactStore.setState({ artifacts: [approved] } as any); });
      second.rerender(<ArtifactDetail artifact={approved} />);
      expect(((await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement).value).toBe("newer respond text");
    } finally {
      vi.useRealTimers();
    }
  });
});
