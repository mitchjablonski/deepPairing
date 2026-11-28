import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../../App";
import { ReviewEndedBanner } from "../ReviewEndedBanner";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

afterEach(() => {
  useConnectionStore.setState({ reviewEnded: null });
  vi.unstubAllGlobals();
});

describe("#711 gate 4 — ReviewEndedBanner", () => {
  it("renders nothing while the review is open", () => {
    useConnectionStore.setState({ reviewEnded: null });
    const { container } = render(<ReviewEndedBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("says the review ended and is read-only", () => {
    useConnectionStore.setState({ reviewEnded: { endedAt: "2026-11-28T10:00:00.000Z", code: "session_ended" } });
    render(<ReviewEndedBanner />);
    const banner = screen.getByTestId("review-ended-banner");
    expect(banner.getAttribute("data-code")).toBe("session_ended");
    expect(banner.textContent).toMatch(/Review ended/);
    expect(banner.textContent).toMatch(/read-only/);
  });

  it("names an unverifiable End marker distinctly", () => {
    useConnectionStore.setState({ reviewEnded: { code: "session_marker_invalid" } });
    render(<ReviewEndedBanner />);
    expect(screen.getByTestId("review-ended-banner").textContent).toMatch(/can't be verified/);
  });

  it("is mounted by App when the bound review has ended, and absent otherwise", () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
    ));
    useArtifactStore.getState().reset();
    useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", reviewEnded: null } as any);
    const { unmount } = render(<App />);
    expect(screen.queryByTestId("review-ended-banner")).not.toBeInTheDocument();
    unmount();
    useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", reviewEnded: { endedAt: "2026-11-28T10:00:00.000Z", code: "session_ended" } } as any);
    render(<App />);
    expect(screen.getByTestId("review-ended-banner").textContent).toMatch(/Review ended/);
  });
});
