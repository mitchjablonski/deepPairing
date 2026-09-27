import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "../MessageInput";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useToastStore } from "../../stores/toast";

/**
 * #417 — a free-form send's completion lands on the composer it came FROM.
 * MessageInput is not keyed by session: a switch re-keys its draft in place,
 * so a send started in A and settled after a switch to B used to clear B's
 * unsent draft (and its saved copy, after the 300ms debounce) and flash
 * "Sent" in B. Deferred responses make every ordering deterministic.
 */
const DRAFT = (sid: string) => `dp:draft:msg:${sid}`;
const ok = () => new Response(JSON.stringify({ comment: { id: "c1" } }), { status: 200, headers: { "Content-Type": "application/json" } });

let switched: string[] = [];
let settle!: { resolve: (r: Response) => void; reject: (e: unknown) => void };

beforeEach(() => {
  sessionStorage.clear();
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  switched = [];
  // The shared setup deletes this bridge after each test; re-point it at the live store.
  (window as any).__dpConnectionStore = { getState: () => useConnectionStore.getState() };
  useConnectionStore.setState({
    sessionId: "sA",
    connected: true,
    activeSessions: [{ sessionId: "sA", live: true }, { sessionId: "sB", live: true }],
    adapter: { switchSession: (id: string) => switched.push(id) },
  } as any);
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve, reject) => { settle = { resolve, reject }; })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useConnectionStore.setState({ adapter: null, sessionId: null, activeSessions: [] } as any);
});

const textarea = () => screen.getByPlaceholderText(/message the agent/i) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: /send|sent/i });

/** Type in A and send; the POST is held open. */
async function sendInA(text = "A's message") {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.click(sendButton());
  expect(fetch).toHaveBeenCalledTimes(1);
}
async function switchTo(id: string) {
  const n = switched.length;
  await act(async () => { useConnectionStore.getState().switchSession(id); });
  await vi.waitFor(() => expect(switched).toHaveLength(n + 1));
}
/** Let useDraft's 300ms debounced write run. */
const debounce = () => act(async () => { await new Promise((r) => setTimeout(r, 350)); });

describe("#417 — MessageInput send completion is bound to its originating session", () => {
  it("A→B, late SUCCESS: B's draft (screen + saved) is untouched, no 'Sent' in B, and A's sent draft is retired", async () => {
    sessionStorage.setItem(DRAFT("sB"), "B's unsent draft");
    render(<MessageInput />);
    await sendInA();
    await switchTo("sB");
    expect(textarea().value).toBe("B's unsent draft");

    await act(async () => settle.resolve(ok()));
    await debounce();
    expect(textarea().value).toBe("B's unsent draft");
    expect(sessionStorage.getItem(DRAFT("sB"))).toBe("B's unsent draft");
    expect(sendButton().textContent).not.toMatch(/Sent/);
    // The server has A's message; its saved draft must not come back as unsent.
    expect(sessionStorage.getItem(DRAFT("sA"))).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("A→B, late FAILURE: B's draft is untouched; the toast names the PREVIOUS session and A keeps its draft to retry", async () => {
    sessionStorage.setItem(DRAFT("sB"), "B's unsent draft");
    render(<MessageInput />);
    await sendInA();
    await switchTo("sB");

    await act(async () => settle.reject(new TypeError("Failed to fetch")));
    await debounce();
    expect(textarea().value).toBe("B's unsent draft");
    expect(sessionStorage.getItem(DRAFT("sB"))).toBe("B's unsent draft");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toMatch(/previous session/i);
    expect(sessionStorage.getItem(DRAFT("sA"))).toBe("A's message");
  });

  it("A→B, late success never deletes text written in A AFTER the sent draft", async () => {
    render(<MessageInput />);
    await sendInA();
    await switchTo("sB");
    sessionStorage.setItem(DRAFT("sA"), "a newer thought"); // e.g. another tab/instance
    await act(async () => settle.resolve(ok()));
    expect(sessionStorage.getItem(DRAFT("sA"))).toBe("a newer thought");
  });

  it("A→B→A, late success: back in A, the (sent) draft is cleared and Sent flashes there", async () => {
    render(<MessageInput />);
    await sendInA();
    await switchTo("sB");
    await switchTo("sA");
    expect(textarea().value).toBe("A's message");
    await act(async () => settle.resolve(ok()));
    expect(textarea().value).toBe("");
    expect(sendButton().textContent).toMatch(/Sent/);
  });

  it("same-session RECONNECT (store reloaded, session unchanged), success: clears and shows Sent as usual", async () => {
    render(<MessageInput />);
    await sendInA();
    act(() => useArtifactStore.getState().reset());
    await act(async () => settle.resolve(ok()));
    expect(textarea().value).toBe("");
    expect(sendButton().textContent).toMatch(/Sent/);
  });

  it("same-session RECONNECT, failure: the ordinary 'Send failed' toast, draft kept for retry", async () => {
    render(<MessageInput />);
    await sendInA();
    act(() => useArtifactStore.getState().reset());
    await act(async () => settle.reject(new TypeError("Failed to fetch")));
    expect(textarea().value).toBe("A's message");
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["Send failed"]);
  });

  it("UNMOUNT mid-send, remount on the same session, success: the remounted composer drops the sent text", async () => {
    const first = render(<MessageInput />);
    await sendInA();
    first.unmount(); // flushes A's draft ("A's message") to storage
    render(<MessageInput />);
    expect(textarea().value).toBe("A's message");
    await act(async () => settle.resolve(ok()));
    expect(textarea().value).toBe("");
    expect(sessionStorage.getItem(DRAFT("sA"))).toBeNull();
  });

  it("the synchronous double-submit guard still holds (one POST for two rapid sends)", async () => {
    render(<MessageInput />);
    fireEvent.change(textarea(), { target: { value: "once" } });
    fireEvent.click(sendButton());
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => settle.resolve(ok()));
  });
});
