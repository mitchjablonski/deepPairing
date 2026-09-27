import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentThread } from "../CommentThread";
import { DecisionCard } from "../DecisionCard";
import { MessageInput } from "../MessageInput";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useToastStore } from "../../stores/toast";

/**
 * #417 review — the rest of the draft class.
 *
 * 1. Artifact/decision-keyed composers UNMOUNT on a session switch, and the
 *    unmount persists their draft. A send that succeeds after that could only
 *    call a dead setter, so the sent text came back as an unsent draft on
 *    return — inviting a duplicate. The success path now retires the saved
 *    copy (compare-and-delete) even with the component gone.
 * 2. MessageInput's in-flight guard lived in the instance; a remount mid-send
 *    offered Send again and a second click posted twice.
 *
 * Real stores, real useDraft (real sessionStorage); only fetch is faked, with
 * the POST held open so every ordering is deterministic.
 */
vi.mock("../MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));

const ok = () => new Response(JSON.stringify({ comment: null }), { status: 200, headers: { "Content-Type": "application/json" } });
let pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];

beforeEach(() => {
  sessionStorage.clear();
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  (window as any).__dpConnectionStore = { getState: () => useConnectionStore.getState() };
  useConnectionStore.setState({ sessionId: "sA", connected: true, activeSessions: [{ sessionId: "sA", live: true }] } as any);
  pending = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); })));
});

afterEach(() => {
  // Never leave a send in flight: the in-flight marker is module-level.
  for (const p of pending) p.resolve(ok());
  vi.unstubAllGlobals();
  useConnectionStore.setState({ sessionId: null, activeSessions: [] } as any);
});

const decision = {
  type: "decision_request" as const,
  decisionId: "dec_late",
  context: "Which cache?",
  options: [
    { id: "o1", title: "Redis", description: "In-memory", pros: ["fast"], cons: ["svc"], effort: "low" as const, risk: "low" as const, recommendation: true },
    { id: "o2", title: "CDN", description: "Edge", pros: ["no infra"], cons: ["inval"], effort: "medium" as const, risk: "medium" as const, recommendation: false },
  ],
};

describe("#417 review (1) — a late success retires the saved draft of an UNMOUNTED composer", () => {
  it("CommentThread: send, unmount (session switch), late success → the saved draft is gone", async () => {
    const view = render(<CommentThread artifactId="a1" comments={[]} />);
    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), { target: { value: "ship it" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/add a comment/i), { key: "Enter", metaKey: true });
    expect(pending).toHaveLength(1);
    view.unmount(); // the switch; the unmount flushes the draft
    expect(sessionStorage.getItem("dp:draft:comment:a1:{}")).toBe("ship it");
    await act(async () => pending[0]!.resolve(ok()));
    expect(sessionStorage.getItem("dp:draft:comment:a1:{}")).toBeNull();
  });

  it("CommentThread: text saved AFTER the sent draft is never deleted", async () => {
    const view = render(<CommentThread artifactId="a1" comments={[]} />);
    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), { target: { value: "ship it" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/add a comment/i), { key: "Enter", metaKey: true });
    view.unmount();
    sessionStorage.setItem("dp:draft:comment:a1:{}", "a newer thought");
    await act(async () => pending[0]!.resolve(ok()));
    expect(sessionStorage.getItem("dp:draft:comment:a1:{}")).toBe("a newer thought");
  });

  it("DecisionCard send-back: send, unmount, late success → the saved draft is gone", async () => {
    const view = render(<DecisionCard event={decision} decisionId="dec_late" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    fireEvent.change(screen.getByPlaceholderText(/all 4 are matchers/i), { target: { value: "try a hybrid" } });
    fireEvent.click(screen.getByRole("button", { name: /^↻ Send back for revision$/ }));
    expect(pending).toHaveLength(1);
    view.unmount();
    expect(sessionStorage.getItem("dp:draft:dec-sendback:dec_late")).toBe("try a hybrid");
    await act(async () => pending[0]!.resolve(ok()));
    expect(sessionStorage.getItem("dp:draft:dec-sendback:dec_late")).toBeNull();
  });

  it("DecisionCard reasoning: select with reasoning, unmount, late success → the saved reasoning draft is gone", async () => {
    const view = render(<DecisionCard event={decision} decisionId="dec_late" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /Expand to discuss/i }));
    const wb = within(await screen.findByTestId("decision-workbench"));
    await userEvent.click(wb.getByRole("button", { name: /\+ Add reasoning/i }));
    const input = wb.getByPlaceholderText(/Why — becomes the/i);
    fireEvent.change(input, { target: { value: "fits our infra" } });
    fireEvent.keyDown(input, { key: "Enter" }); // commits the focused option with this reasoning
    expect(pending.length).toBeGreaterThanOrEqual(1);
    view.unmount();
    expect(sessionStorage.getItem("dp:draft:dec-reason:dec_late")).toBe("fits our infra");
    await act(async () => { for (const p of pending) p.resolve(ok()); });
    expect(sessionStorage.getItem("dp:draft:dec-reason:dec_late")).toBeNull();
  });
});

describe("#417 review (2) — MessageInput's in-flight guard survives a remount", () => {
  const box = () => screen.getByPlaceholderText(/message the agent/i) as HTMLTextAreaElement;
  const send = () => screen.getByRole("button", { name: /send|sent/i });

  it("remount mid-send: the new composer stays sending, and a second send posts nothing", async () => {
    const first = render(<MessageInput />);
    fireEvent.change(box(), { target: { value: "once only" } });
    fireEvent.click(send());
    expect(fetch).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<MessageInput />);
    expect(box().value).toBe("once only"); // the saved draft loads
    expect(box()).toBeDisabled();
    expect(send()).toBeDisabled();
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    fireEvent.click(send());
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => pending[0]!.resolve(ok()));
    expect(box()).not.toBeDisabled();
    expect(box().value).toBe(""); // and the sent text is retired
  });

  it("a FAILED send releases the marker, so the remounted composer can retry (never wedged)", async () => {
    const first = render(<MessageInput />);
    fireEvent.change(box(), { target: { value: "retry me" } });
    fireEvent.click(send());
    first.unmount();
    render(<MessageInput />);
    await act(async () => pending[0]!.reject(new TypeError("Failed to fetch")));
    expect(box()).not.toBeDisabled();
    expect(box().value).toBe("retry me");
    fireEvent.click(send());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a POST that NEVER settles times out: marker released, composer re-enabled, draft kept, timeout toast shown", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that only ends if aborted — what a hung daemon looks like.
      vi.stubGlobal("fetch", vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));
      render(<MessageInput />);
      fireEvent.change(box(), { target: { value: "hung send" } });
      fireEvent.click(send());
      expect(box()).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(box()).not.toBeDisabled();
      expect(box().value).toBe("hung send");
      const titles = useToastStore.getState().toasts.map((t) => t.title);
      expect(titles).toEqual(["Send timed out"]);
      expect(useToastStore.getState().toasts[0]!.body).toMatch(/may or may not have reached/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

