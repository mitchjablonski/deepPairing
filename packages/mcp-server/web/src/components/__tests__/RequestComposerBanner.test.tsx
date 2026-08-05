import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Request } from "@deeppairing/shared";
import { RequestComposerBanner } from "../RequestComposerBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useToastStore } from "../../stores/toast";

/**
 * G1 (#198b) — the request composer banner: presets, submit, served/unserved
 * pips, and the no-agent-live resume-prompt.
 *
 * #204 (H3) — the row now COLLAPSES to a single trigger (banner fold, M3); submit
 * fires a liveness-branched toast (M2); the resume bridge also appears when a
 * live agent has gone IDLE (UX3); the preset EXAMPLE stays visible as helper text
 * even after the template prefills the input (L3).
 */

function seedRequests(requests: Request[]): void {
  useArtifactStore.setState({ requests } as any);
}

/** Open the collapsed composer via its trigger (defaults to the Explain preset). */
async function openComposer(): Promise<void> {
  await userEvent.click(screen.getByTestId("request-composer-trigger"));
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, activeSessions: [{ sessionId: "s1", live: true }], agentActivityAt: null } as any);
  useToastStore.setState({ toasts: [] } as any);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ request: { id: "req_srv", text: "the auth", intent: "explain", createdAt: new Date().toISOString() } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }),
  ));
});
afterEach(() => {
  vi.unstubAllGlobals();
  useArtifactStore.getState().reset();
  useToastStore.setState({ toasts: [] } as any);
});

describe("RequestComposerBanner (#198b / #204)", () => {
  it("is hidden until connected", () => {
    useConnectionStore.setState({ connected: false } as any);
    const { container } = render(<RequestComposerBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("#204 M3 — collapses to a single trigger; presets appear only once expanded", async () => {
    render(<RequestComposerBanner />);
    // Collapsed: the trigger is present, the preset chips are NOT.
    expect(screen.getByTestId("request-composer-trigger")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Plan…$/ })).not.toBeInTheDocument();
    // Expanded: all three presets render.
    await openComposer();
    expect(screen.getByRole("button", { name: /Explain how…/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Plan…$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Status\?/ })).toBeInTheDocument();
  });

  it("picking a preset opens the composer and submitting POSTs the text + intent", async () => {
    render(<RequestComposerBanner />);
    await openComposer();
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

  it("#204 L3 — the preset example stays visible as helper text after the template prefills", async () => {
    render(<RequestComposerBanner />);
    await openComposer();
    // The Explain template ("Explain how ") fills the input; the example must
    // still be readable below it.
    const input = await screen.findByLabelText(/Your request to Claude/i);
    expect((input as HTMLInputElement).value).toBe("Explain how ");
    expect(screen.getByTestId("request-example-hint")).toHaveTextContent("the auth middleware works");
    // Switching preset switches the example too.
    await userEvent.click(screen.getByRole("button", { name: /^Plan…$/ }));
    expect(screen.getByTestId("request-example-hint")).toHaveTextContent("the rate-limiter before building");
  });

  it("#204 M2 — a LIVE agent gets a 'Sent to Claude' success toast on submit", async () => {
    render(<RequestComposerBanner />);
    await openComposer();
    const input = await screen.findByLabelText(/Your request to Claude/i);
    await userEvent.clear(input);
    await userEvent.type(input, "the router");
    await userEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => /Sent to Claude/i.test(t.title))).toBe(true);
    });
  });

  it("#204 M2 — no live agent gets a 'Saved' toast with a Copy resume prompt action", async () => {
    useConnectionStore.setState({ connected: true, activeSessions: [] } as any);
    render(<RequestComposerBanner />);
    await openComposer();
    const input = await screen.findByLabelText(/Your request to Claude/i);
    await userEvent.clear(input);
    await userEvent.type(input, "the router");
    await userEvent.click(screen.getByRole("button", { name: /Send request/i }));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      const saved = toasts.find((t) => /Saved/i.test(t.title));
      expect(saved).toBeDefined();
      expect(saved!.action?.label).toMatch(/Copy resume prompt/i);
    });
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

  it("no resume prompt while an agent is live and actively polling", () => {
    // agentActivityAt now → recently active → NOT idle.
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: true }], agentActivityAt: Date.now() } as any);
    seedRequests([{ id: "req_1", text: "explain auth", intent: "explain", createdAt: "2026-08-01T00:00:00.000Z" }]);
    render(<RequestComposerBanner />);
    expect(screen.queryByTestId("request-resume-prompt")).not.toBeInTheDocument();
  });

  it("#204 UX3 — a LIVE session we've seen poll but has gone idle surfaces the resume bridge", () => {
    // Live session, but last activity was long ago (well past the 90s window).
    useConnectionStore.setState({
      activeSessions: [{ sessionId: "s1", live: true }],
      agentActivityAt: Date.now() - 5 * 60_000,
    } as any);
    seedRequests([{ id: "req_1", text: "explain auth", intent: "explain", createdAt: "2026-08-01T00:00:00.000Z" }]);
    render(<RequestComposerBanner />);
    expect(screen.getByTestId("request-resume-prompt")).toBeInTheDocument();
  });

  it("#204 UX3 — a never-polled live session is NOT treated as idle (no premature nag)", () => {
    // agentActivityAt null → no positive evidence of staleness → no bridge.
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: true }], agentActivityAt: null } as any);
    seedRequests([{ id: "req_1", text: "explain auth", intent: "explain", createdAt: "2026-08-01T00:00:00.000Z" }]);
    render(<RequestComposerBanner />);
    expect(screen.queryByTestId("request-resume-prompt")).not.toBeInTheDocument();
  });
});
