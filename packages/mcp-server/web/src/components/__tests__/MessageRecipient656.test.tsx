import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "../MessageInput";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";

const sessions = [
  { sessionId: "sess-auth-0001", title: "Auth refactor", live: true },
  { sessionId: "sess-bill-0002", title: "Billing migration", live: true },
];

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.setState({ agentFilter: "all" } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({ sessionId: "sess-auth-0001", activeSessions: sessions, connected: true } as any);
});

describe("#656 item 1 — the message box names its recipient", () => {
  it("names the tab's agent when more than one agent is around", () => {
    render(<MessageInput />);
    expect(screen.getByRole("textbox", { name: "Message the agent in Auth refactor" })).toBeInTheDocument();
    expect(screen.queryByTestId("message-recipient-mismatch")).toBeNull();
  });

  it("keeps the generic wording with a single agent", () => {
    useConnectionStore.setState({ activeSessions: [sessions[0]] } as any);
    render(<MessageInput />);
    expect(screen.getByRole("textbox", { name: "Message the agent" })).toBeInTheDocument();
  });

  it("when the filter shows another agent, says where messages go and offers an explicit Switch", () => {
    const switchSession = vi.fn();
    useConnectionStore.setState({ switchSession } as any);
    useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
    render(<MessageInput />);
    expect(screen.getByTestId("message-recipient-mismatch")).toHaveTextContent(
      "Viewing Billing migration · messages go to Auth refactor",
    );
    // Nothing switched on its own.
    expect(switchSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Billing migration" }));
    expect(switchSession).toHaveBeenCalledWith("sess-bill-0002");
  });

  it("no mismatch line when the filter is on the tab's own agent", () => {
    useArtifactStore.setState({ agentFilter: "sess-auth-0001" } as any);
    render(<MessageInput />);
    expect(screen.queryByTestId("message-recipient-mismatch")).toBeNull();
  });

  it("Sol P2: a retained filter on an agent missing from the catalog still shows the mismatch; Switch is disabled", () => {
    const switchSession = vi.fn();
    useConnectionStore.setState({ switchSession, activeSessions: [sessions[0]] } as any); // B not registered yet
    useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
    render(<MessageInput />);
    expect(screen.getByTestId("message-recipient-mismatch")).toHaveTextContent(
      "Viewing session …ill-0002 · messages go to Auth refactor",
    );
    const sw = screen.getByRole("button", { name: /switch to session …ill-0002/i });
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(switchSession).not.toHaveBeenCalled();
  });

  it("Sol P2: a partial catalog holding only the filtered agent still names the bound recipient (short id)", () => {
    useConnectionStore.setState({ activeSessions: [sessions[1]] } as any); // bound A missing
    useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
    render(<MessageInput />);
    expect(screen.getByTestId("message-recipient-mismatch")).toHaveTextContent(
      "Viewing Billing migration · messages go to session …uth-0001",
    );
    expect(screen.getByRole("textbox", { name: "Message the agent in session …uth-0001" })).toBeInTheDocument();
  });

  it("Sol P2: duplicate titles are disambiguated by short id", () => {
    useConnectionStore.setState({ activeSessions: [
      { sessionId: "sess-pair-0001", title: "Pair", live: true },
      { sessionId: "sess-pair-0002", title: "Pair", live: true },
    ], sessionId: "sess-pair-0001" } as any);
    useArtifactStore.setState({ agentFilter: "sess-pair-0002" } as any);
    render(<MessageInput />);
    expect(screen.getByTestId("message-recipient-mismatch")).toHaveTextContent(
      "Viewing Pair (air-0002) · messages go to Pair (air-0001)",
    );
  });

  it("Sol P2: while viewing another agent, Send still posts to the BOUND session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "c1" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
      render(<MessageInput />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "please check the 401 path" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Send/ })); });
      const post = fetchMock.mock.calls.find(([u, init]: any[]) => String(u).includes("/api/comments") && init?.method === "POST") as any;
      expect(post).toBeTruthy();
      expect(post[1].headers["X-Session-Id"]).toBe("sess-auth-0001");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Sol P2: replay hides the composer, so no mismatch line or Switch renders", () => {
    useArtifactStore.setState({ agentFilter: "sess-bill-0002" } as any);
    useReplayStore.setState({ active: true } as any);
    render(<MessageInput />);
    expect(screen.queryByTestId("message-recipient-mismatch")).toBeNull();
    expect(screen.queryByRole("button", { name: /switch to/i })).toBeNull();
  });
});

