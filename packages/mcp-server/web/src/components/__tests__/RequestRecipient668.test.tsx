import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RequestComposerBanner } from "../RequestComposerBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

/** #668 item 2 — "Ask Claude for something" says which agent gets the request. */
const sessions = [
  { sessionId: "sess-auth-0001", title: "Auth refactor", live: true },
  { sessionId: "sess-bill-0002", title: "Billing migration", live: true },
];

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ agentFilter: "all" } as any);
  useConnectionStore.setState({ sessionId: "sess-auth-0001", activeSessions: sessions, connected: true, agentActivityAt: null } as any);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const open = () => fireEvent.click(screen.getByTestId("request-composer-trigger"));

describe("#668 item 2 — the request composer names its recipient", () => {
  it("names the tab's agent when more than one agent is around", () => {
    render(<RequestComposerBanner />);
    open();
    expect(screen.getByTestId("request-recipient")).toHaveTextContent("to the agent in Auth refactor");
    expect(screen.getByRole("textbox", { name: "Your request to the agent in Auth refactor" })).toBeInTheDocument();
    expect(screen.queryByTestId("request-recipient-mismatch")).toBeNull();
  });

  it("keeps the generic wording with a single agent", () => {
    useConnectionStore.setState({ activeSessions: [sessions[0]] } as any);
    render(<RequestComposerBanner />);
    open();
    expect(screen.queryByTestId("request-recipient")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Your request to Claude" })).toBeInTheDocument();
  });

  it("when the filter shows another agent, says where requests go and offers an explicit Switch", () => {
    const switchSession = vi.fn();
    useConnectionStore.setState({ switchSession } as any);
    useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
    render(<RequestComposerBanner />);
    // Collapsed: no extra standing row.
    expect(screen.queryByTestId("request-recipient-mismatch")).toBeNull();
    open();
    expect(screen.getByTestId("request-recipient-mismatch")).toHaveTextContent(
      "Viewing Billing migration · requests go to Auth refactor",
    );
    expect(switchSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Billing migration" }));
    expect(switchSession).toHaveBeenCalledWith("sess-bill-0002");
  });

  it("Switch is disabled for an agent missing from the catalog", () => {
    useConnectionStore.setState({ activeSessions: [sessions[0]] } as any);
    useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
    render(<RequestComposerBanner />);
    open();
    expect(screen.getByTestId("request-recipient-mismatch")).toHaveTextContent(
      "Viewing session …ill-0002 · requests go to Auth refactor",
    );
    expect(screen.getByRole("button", { name: /Switch to session/ })).toBeDisabled();
  });
});

describe("Sol (#671) — mounted routing: recipient, draft and X-Session-Id agree", () => {
  const okRequest = (text: string) => new Response(JSON.stringify({ request: { id: `req_${text}`, text, intent: "explain", createdAt: new Date().toISOString() } }), { status: 200, headers: { "Content-Type": "application/json" } });
  const posts = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter(([u, init]: any[]) => String(u).includes("/api/requests") && init?.method === "POST") as any[];
  const box = () => screen.getByRole("textbox") as HTMLInputElement;
  const bind = (sid: string | null) => act(() => { useConnectionStore.setState({ sessionId: sid } as any); });

  it("A → B → A: each send carries the displayed recipient's session id", async () => {
    const fetchMock = vi.fn(async (_u: any, init: any) => okRequest(JSON.parse(init?.body ?? "{}").text ?? "x"));
    vi.stubGlobal("fetch", fetchMock);
    render(<RequestComposerBanner />);
    open();
    expect(screen.getByTestId("request-recipient")).toHaveTextContent("Auth refactor");
    fireEvent.change(box(), { target: { value: "for auth" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send request" })); });

    bind("sess-bill-0002");
    if (!screen.queryByRole("textbox")) open();
    expect(screen.getByTestId("request-recipient")).toHaveTextContent("Billing migration");
    fireEvent.change(box(), { target: { value: "for billing" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send request" })); });

    bind("sess-auth-0001");
    if (!screen.queryByRole("textbox")) open();
    expect(screen.getByTestId("request-recipient")).toHaveTextContent("Auth refactor");
    fireEvent.change(box(), { target: { value: "auth again" } });
    await act(async () => { fireEvent.keyDown(box(), { key: "Enter" }); });

    const sent = posts(fetchMock).map(([, init]) => [JSON.parse(init.body).text, init.headers["X-Session-Id"]]);
    expect(sent).toEqual([
      ["for auth", "sess-auth-0001"],
      ["for billing", "sess-bill-0002"],
      ["auth again", "sess-auth-0001"],
    ]);
  });

  it("an in-flight send that completes after a Switch keeps its origin and leaves B's draft alone", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RequestComposerBanner />);
    open();
    fireEvent.change(box(), { target: { value: "slow for auth" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send request" })); });
    expect(posts(fetchMock)[0]![1].headers["X-Session-Id"]).toBe("sess-auth-0001");

    bind("sess-bill-0002");
    if (!screen.queryByRole("textbox")) open();
    fireEvent.change(box(), { target: { value: "billing draft" } });
    await act(async () => { resolve(okRequest("slow for auth")); await new Promise((r) => setTimeout(r, 0)); });

    expect(screen.getByTestId("request-recipient")).toHaveTextContent("Billing migration");
    expect(box().value).toBe("billing draft");
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it("no bound session with several agents: Enter and Send make zero writes and keep the text", async () => {
    const fetchMock = vi.fn(async () => okRequest("x"));
    vi.stubGlobal("fetch", fetchMock);
    useConnectionStore.setState({ sessionId: null } as any);
    render(<RequestComposerBanner />);
    open();
    expect(screen.getByTestId("request-recipient-ambiguous")).toBeInTheDocument();
    fireEvent.change(box(), { target: { value: "who gets this?" } });
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    await act(async () => { fireEvent.keyDown(box(), { key: "Enter" }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send request" })); });
    expect(posts(fetchMock)).toHaveLength(0);
    expect(box().value).toBe("who gets this?");
  });
});
