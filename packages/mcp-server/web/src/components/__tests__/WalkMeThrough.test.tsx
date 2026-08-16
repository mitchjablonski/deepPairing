import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WalkMeThroughButton,
  buildWalkMeThroughRequest,
  buildWalkMeThroughScope,
  walkMeThroughLabel,
  hunkLineRange,
} from "../WalkMeThrough";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { useToastStore } from "../../stores/toast";

/**
 * O2 (#230) — the "Walk me through this" affordance: a NEW ENTRY POINT to the
 * existing request pipe. A click emits a scoped "explain"-intent request (which
 * present_explainer serves) — the CTA the round-10 review found missing for the
 * INITIAL explainer invocation.
 *
 * P2 (round-11) — the truth-up, pinned here: the HUNK grain is reachable and
 * carries a real line range; a needs-your-eyes ref TRAVELS (id, not boolean);
 * every click sends `source` + `scope` as DATA alongside the prose; and the
 * label names the grain instead of the ambiguous "Walk me through this".
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

  it("hunk scope carries the line range + forbids the whole-file tour", () => {
    const t = buildWalkMeThroughRequest({ kind: "hunk", filePath: "a.ts", lineStart: 24, lineEnd: 30 });
    expect(t).toContain("a.ts");
    expect(t).toContain("24–30");
    expect(t).toContain("present_explainer");
    // P2 — the guidance promises hunk grain ("not a whole-file tour"); the
    // emitted ask now says the same thing, so the two can't disagree.
    expect(t).toMatch(/not a whole-file tour/i);
  });

  it("needs-eyes scope quotes the item, folds in the why, and NAMES the linked artifact", () => {
    const withRef = buildWalkMeThroughRequest({
      kind: "needs-eyes",
      what: "The expiry check",
      why: "changes the auth path",
      artifactRef: "cs_42",
    });
    expect(withRef).toContain('"The expiry check"');
    expect(withRef).toContain("changes the auth path");
    expect(withRef).toContain("present_explainer");
    // P2 fix 2 — the REF TRAVELS. Pre-P2 this said "the linked artifact" while
    // only a boolean ever crossed the wire, so the agent was told a link exists
    // without being told WHAT it links to.
    expect(withRef).toContain("the linked artifact cs_42");

    const noRef = buildWalkMeThroughRequest({ kind: "needs-eyes", what: "X" });
    expect(noRef).toContain("scoped to this");
    expect(noRef).not.toContain("linked artifact");
  });
});

describe("buildWalkMeThroughScope — P2 fix 3 (scope as DATA, not prose)", () => {
  it("file → filePath (+ the artifact it was fired from)", () => {
    expect(buildWalkMeThroughScope({ kind: "file", filePath: "a.ts", artifactId: "cs_1" })).toEqual({
      filePath: "a.ts",
      artifactId: "cs_1",
    });
  });

  it("hunk → filePath + the real line range", () => {
    expect(
      buildWalkMeThroughScope({ kind: "hunk", filePath: "a.ts", lineStart: 24, lineEnd: 30, artifactId: "cs_1" }),
    ).toEqual({ filePath: "a.ts", lineStart: 24, lineEnd: 30, artifactId: "cs_1" });
  });

  it("needs-eyes → the LINKED artifact (not the debrief) + the item anchor", () => {
    expect(
      buildWalkMeThroughScope({
        kind: "needs-eyes",
        what: "X",
        artifactRef: "cs_42",
        artifactId: "debrief_1",
        itemRef: "debrief:needs-your-eyes:2",
      }),
    ).toEqual({ artifactId: "cs_42", itemRef: "debrief:needs-your-eyes:2" });
  });

  it("omits what it doesn't know (no invented fields)", () => {
    expect(buildWalkMeThroughScope({ kind: "needs-eyes", what: "X" })).toEqual({});
    expect(buildWalkMeThroughScope({ kind: "file", filePath: "a.ts" })).toEqual({ filePath: "a.ts" });
  });
});

describe("hunkLineRange — P2 fix 1", () => {
  it("uses the NEW-side numbers when the hunk has any", () => {
    expect(
      hunkLineRange({
        lines: [
          { kind: "ctx", content: "", oldLine: 25, newLine: 25 },
          { kind: "del", content: "", oldLine: 26 },
          { kind: "add", content: "", newLine: 26 },
          { kind: "add", content: "", newLine: 27 },
          { kind: "ctx", content: "", oldLine: 27, newLine: 28 },
        ],
      }),
    ).toEqual({ lineStart: 25, lineEnd: 28 });
  });

  it("falls back to OLD-side numbers for a pure-deletion hunk", () => {
    expect(
      hunkLineRange({ lines: [{ kind: "del", content: "", oldLine: 8 }, { kind: "del", content: "", oldLine: 9 }] }),
    ).toEqual({ lineStart: 8, lineEnd: 9 });
  });

  it("returns null when the agent supplied no line numbers (affordance withheld, never a bogus range)", () => {
    expect(hunkLineRange({ lines: [{ kind: "ctx", content: "x" }] })).toBeNull();
    expect(hunkLineRange({ lines: [] })).toBeNull();
  });
});

describe("walkMeThroughLabel — P2 fix 4 (honest, per-grain label)", () => {
  it("names the grain instead of the ambiguous 'Walk me through this'", () => {
    expect(walkMeThroughLabel({ kind: "file", filePath: "a.ts" })).toBe("Explain this file");
    expect(walkMeThroughLabel({ kind: "hunk", filePath: "a.ts", lineStart: 1, lineEnd: 2 })).toBe("Explain this hunk");
    expect(walkMeThroughLabel({ kind: "needs-eyes", what: "X" })).toBe("Explain this");
  });
});

describe("WalkMeThroughButton", () => {
  it("POSTs a well-formed scoped explain request — prose AND data — on click", async () => {
    render(<WalkMeThroughButton target={{ kind: "file", filePath: "auth/middleware.ts", artifactId: "cs_1" }} />);
    await userEvent.click(screen.getByTestId("walk-me-through-file"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/requests"),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = lastRequestPost();
    expect(body.intent).toBe("explain");
    expect(body.text).toContain("auth/middleware.ts");
    expect(body.text).toContain("present_explainer");
    // P2 fix 3 — the request is no longer byte-indistinguishable from a
    // hand-typed composer request.
    expect(body.source).toBe("walk_me_through");
    expect(body.scope).toEqual({ filePath: "auth/middleware.ts", artifactId: "cs_1" });
  });

  it("hunk grain emits kind:hunk with the line range in BOTH the text and the scope", async () => {
    render(
      <WalkMeThroughButton
        target={{ kind: "hunk", filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 28, artifactId: "cs_1" }}
      />,
    );
    const btn = screen.getByTestId("walk-me-through-hunk");
    expect(btn).toHaveAttribute("data-walk-grain", "hunk");
    expect(btn).toHaveTextContent("Explain this hunk");
    await userEvent.click(btn);
    await waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0));
    const body = lastRequestPost();
    expect(body.text).toContain("25–28");
    expect(body.scope).toEqual({ filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 28, artifactId: "cs_1" });
  });

  it("the sent confirmation NAMES THE DESTINATION (round-11 UX MED)", async () => {
    render(<WalkMeThroughButton target={{ kind: "file", filePath: "a.ts" }} />);
    await userEvent.click(screen.getByTestId("walk-me-through-file"));
    expect(await screen.findByText(/posting in the sidebar/i)).toBeInTheDocument();
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.title).toMatch(/Sent to Claude/i);
    expect(toast.body).toMatch(/explainer in the sidebar/i);
  });

  it("queued (no agent live) confirmation also names where the answer lands", async () => {
    useConnectionStore.setState({ connected: true, activeSessions: [] } as any);
    render(<WalkMeThroughButton target={{ kind: "file", filePath: "a.ts" }} />);
    await userEvent.click(screen.getByTestId("walk-me-through-file"));
    await waitFor(() => expect(useToastStore.getState().toasts.length).toBeGreaterThan(0));
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.body).toMatch(/sidebar/i);
  });

  it("reads as an ACTION, not file metadata: UI font, keyboard-reachable, no wrap", () => {
    render(<WalkMeThroughButton target={{ kind: "file", filePath: "deep/nested/path/to/auth/middleware.ts" }} />);
    const btn = screen.getByTestId("walk-me-through-file");
    // font-sans + nowrap — it used to inherit font-mono from the file-path
    // header and push it onto a second row on a deep path.
    expect(btn.className).toContain("font-sans");
    expect(btn.className).toContain("whitespace-nowrap");
    expect(btn.className).toContain("shrink-0");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("aria-label", expect.stringContaining("Explain this file"));
  });

  it("is withheld during replay (no accidental request onto a historical session)", () => {
    useReplayStore.setState({ active: true } as any);
    render(<WalkMeThroughButton target={{ kind: "file", filePath: "a.ts" }} />);
    expect(screen.queryByTestId("walk-me-through-file")).not.toBeInTheDocument();
  });
});
