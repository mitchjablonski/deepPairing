import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDecisionsModal } from "../ProjectDecisionsModal";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";

/**
 * #469 — end-to-end through the REAL openSessionReplay (fetch is the only
 * fake): every way the historical-session load can fail must surface an alert
 * in the modal, keep it open, and never leak an unhandled rejection.
 */
const DECISION = {
  decisionId: "d1", sessionId: "s_gone", sessionTitle: "Cache work",
  artifactId: "a1", artifactTitle: "Which cache?", artifactMissing: false,
  context: "Which cache should we use?", optionCount: 2, resolved: true,
  chosenOptionId: "o1", chosenOptionTitle: "Redis", reasoning: "lowest latency",
  createdAt: "2026-07-01T10:00:00Z",
};

function stubFetch(sessionResponse: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
    if (url.includes("/api/decisions")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ decisions: [DECISION], failedSessions: [] }) });
    }
    if (url.includes("/api/sessions/")) return sessionResponse();
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }));
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  useArtifactStore.getState().reset();
  useReplayStore.setState({ active: false, exiting: false, sessionId: null, events: [], cursor: "" });
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllGlobals();
});

describe("ProjectDecisionsModal × real openSessionReplay failures (#469)", () => {
  it.each([
    ["HTTP 404", () => Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "not found" }) }), /HTTP 404/],
    ["a network rejection", () => Promise.reject(new TypeError("Failed to fetch")), /couldn't reach the deepPairing server/i],
    ["a non-JSON body", () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }), /unreadable response/i],
    ["a JSON null body", () => Promise.resolve({ ok: true, status: 200, json: async () => null }), /unreadable response/i],
  ])("surfaces %s as an alert and keeps the modal", async (_label, sessionResponse, message) => {
    const onClose = vi.fn();
    stubFetch(sessionResponse);
    render(<ProjectDecisionsModal onClose={onClose} />);
    await userEvent.click(await screen.findByText("Which cache should we use?"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Which cache should we use?")).toBeInTheDocument();
    expect(useReplayStore.getState().active).toBe(false);
    // Give any stray rejection a macrotask to surface.
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });

  it("Retry after the server recovers opens the session and closes the modal", async () => {
    const onClose = vi.fn();
    let fail = true;
    stubFetch(() => fail
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ sessionId: "s_gone", artifacts: [], comments: [], decisions: [] }) }));
    render(<ProjectDecisionsModal onClose={onClose} />);
    await userEvent.click(await screen.findByText("Which cache should we use?"));
    await screen.findByRole("alert");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(useReplayStore.getState().sessionId).toBe("s_gone");
  });
});
