import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalkMeThroughButton, buildWalkMeThroughRequest } from "../WalkMeThrough";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { useToastStore } from "../../stores/toast";

/**
 * O2 (#230) — the "Walk me through this" affordance: a NEW ENTRY POINT to the
 * existing request pipe. A click emits a scoped "explain"-intent request (which
 * present_explainer serves) — the CTA the round-10 review found missing for the
 * INITIAL explainer invocation.
 */

function lastRequestPost(): any {
  const calls = (globalThis.fetch as any).mock.calls.filter(([u]: any[]) =>
    String(u).includes("/api/requests"),
  );
  const [, init] = calls[calls.length - 1];
  return JSON.parse(init.body);
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, activeSessions: [{ sessionId: "s1", live: true }] } as any);
  useReplayStore.setState({ active: false } as any);
  useToastStore.setState({ toasts: [] } as any);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ request: { id: "req_1", text: "x", intent: "explain", createdAt: new Date().toISOString() } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  useArtifactStore.getState().reset();
  useToastStore.setState({ toasts: [] } as any);
});

describe("buildWalkMeThroughRequest", () => {
  it("file scope names the file + asks for a present_explainer scoped to it", () => {
    const t = buildWalkMeThroughRequest({ kind: "file", filePath: "auth/middleware.ts" });
    expect(t).toContain("auth/middleware.ts");
    expect(t).toContain("present_explainer");
    expect(t.toLowerCase()).toContain("walk me through");
    expect(t).toContain("scoped to this file");
  });

  it("hunk scope carries the line range", () => {
    const t = buildWalkMeThroughRequest({ kind: "hunk", filePath: "a.ts", lineStart: 24, lineEnd: 30 });
    expect(t).toContain("a.ts");
    expect(t).toContain("24–30");
    expect(t).toContain("present_explainer");
  });

  it("needs-eyes scope quotes the item + folds in the why + linked-artifact target", () => {
    const withRef = buildWalkMeThroughRequest({
      kind: "needs-eyes",
      what: "The expiry check",
      why: "changes the auth path",
      hasArtifactRef: true,
    });
    expect(withRef).toContain('"The expiry check"');
    expect(withRef).toContain("changes the auth path");
    expect(withRef).toContain("the linked artifact");
    expect(withRef).toContain("present_explainer");

    const noRef = buildWalkMeThroughRequest({ kind: "needs-eyes", what: "X" });
    expect(noRef).toContain("scoped to this");
  });
});

describe("WalkMeThroughButton", () => {
  it("POSTs a well-formed scoped explain request on click", async () => {
    const text = buildWalkMeThroughRequest({ kind: "file", filePath: "auth/middleware.ts" });
    render(<WalkMeThroughButton requestText={text} ariaLabel="how auth/middleware.ts works" />);
    await userEvent.click(screen.getByTestId("walk-me-through"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/requests"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = lastRequestPost();
    expect(body.intent).toBe("explain");
    expect(body.text).toBe(text);
    expect(body.text).toContain("present_explainer");
  });

  it("shows a sent confirmation after submit", async () => {
    render(
      <WalkMeThroughButton
        requestText={buildWalkMeThroughRequest({ kind: "file", filePath: "a.ts" })}
        ariaLabel="how a.ts works"
      />,
    );
    await userEvent.click(screen.getByTestId("walk-me-through"));
    expect(await screen.findByText(/Claude will explain/i)).toBeInTheDocument();
  });

  it("is withheld during replay (no accidental request onto a historical session)", () => {
    useReplayStore.setState({ active: true } as any);
    render(
      <WalkMeThroughButton
        requestText={buildWalkMeThroughRequest({ kind: "file", filePath: "a.ts" })}
        ariaLabel="how a.ts works"
      />,
    );
    expect(screen.queryByTestId("walk-me-through")).not.toBeInTheDocument();
  });
});
