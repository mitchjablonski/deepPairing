import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
