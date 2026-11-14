import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("textbox", { name: "Message Auth refactor's agent" })).toBeInTheDocument();
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
});
