import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Request } from "@deeppairing/shared";
import { RequestComposerBanner } from "../RequestComposerBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

/**
 * G1 (#198b) — the request composer banner: presets, submit, served/unserved
 * pips, and the no-agent-live resume-prompt.
 */

function seedRequests(requests: Request[]): void {
  useArtifactStore.setState({ requests } as any);
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, activeSessions: [{ sessionId: "s1", live: true }] } as any);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ request: { id: "req_srv", text: "the auth", intent: "explain", createdAt: new Date().toISOString() } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }),
  ));
});
afterEach(() => {
  vi.unstubAllGlobals();
  useArtifactStore.getState().reset();
});

describe("RequestComposerBanner (#198b)", () => {
  it("is hidden until connected", () => {
    useConnectionStore.setState({ connected: false } as any);
    const { container } = render(<RequestComposerBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the three intent presets", () => {
    render(<RequestComposerBanner />);
    expect(screen.getByRole("button", { name: /Explain how…/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Plan…$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Status\?/ })).toBeInTheDocument();
  });

  it("picking a preset opens the composer and submitting POSTs the text + intent", async () => {
    render(<RequestComposerBanner />);
    await userEvent.click(screen.getByRole("button", { name: /Explain how…/ }));
    const input = await screen.findByLabelText(/Your request to Claude/i);
    await userEvent.clear(input);
    await userEvent.type(input, "the session middleware");
    await userEvent.click(screen.getByRole("button", { name: /Send request/i }));

    await waitFor(() => {
      const fetchMock = (globalThis.fetch as any);
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/requests"), expect.anything());
    });
    const call = (globalThis.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes("/api/requests"));
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ text: "the session middleware", intent: "explain" });
  });

  it("shows a served vs unserved pip, and a served pip is clickable to jump to the artifact", async () => {
    const selectArtifact = vi.fn();
    useArtifactStore.setState({ selectArtifact } as any);
    seedRequests([
      { id: "req_1", text: "explain auth", intent: "explain", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "req_2", text: "plan cache", intent: "plan", createdAt: "2026-08-01T00:01:00.000Z", servedByArtifactId: "art_x" },
    ]);
    render(<RequestComposerBanner />);
    const pips = screen.getByTestId("request-pips");
    const unserved = within(pips).getByText(/explain/).closest("button")!;
    const served = within(pips).getByText(/plan/).closest("button")!;
    expect(unserved).toHaveAttribute("data-served", "false");
    expect(served).toHaveAttribute("data-served", "true");
    await userEvent.click(served);
    expect(selectArtifact).toHaveBeenCalledWith("art_x");
  });

  it("when NO agent is live and a request is pending, offers a resume prompt", () => {
    useConnectionStore.setState({ connected: true, activeSessions: [] } as any);
    seedRequests([{ id: "req_1", text: "explain auth", intent: "explain", createdAt: "2026-08-01T00:00:00.000Z" }]);
    render(<RequestComposerBanner />);
    expect(screen.getByTestId("request-resume-prompt")).toBeInTheDocument();
  });

  it("no resume prompt while an agent is live (it'll pick the request up via check_feedback)", () => {
    seedRequests([{ id: "req_1", text: "explain auth", intent: "explain", createdAt: "2026-08-01T00:00:00.000Z" }]);
    render(<RequestComposerBanner />);
    expect(screen.queryByTestId("request-resume-prompt")).not.toBeInTheDocument();
  });
});
