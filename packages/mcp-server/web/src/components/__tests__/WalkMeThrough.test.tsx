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
  it("file scope asks about THIS FILE'S CHANGES, never a whole-file tour", () => {
    const t = buildWalkMeThroughRequest({ kind: "file", filePath: "auth/middleware.ts" });
    expect(t).toContain("auth/middleware.ts");
    expect(t).toContain("present_explainer");
    expect(t.toLowerCase()).toContain("walk me through");
    // P2 review (judgment call) — the button lives in a CHANGESET file header,
    // so "how <path> works … how the pieces fit together" licensed a tour of a
    // 2000-line file of which six lines changed: the round-10 failure, re-entered
    // through the file door.
    expect(t).toContain("changes to auth/middleware.ts in this changeset");
    expect(t).toContain("scoped to this file's changes");
    expect(t).not.toMatch(/how auth\/middleware\.ts works/);
  });

  it("hunk scope carries the line range + forbids the whole-file tour", () => {
    const t = buildWalkMeThroughRequest({ kind: "hunk", filePath: "a.ts", lineStart: 24, lineEnd: 30, side: "new" });
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

/**
 * P2 review F1/F2 — a diff has TWO coordinate systems and only one of them
 * matches the file on disk. Handing the agent a bare range under an
 * "authoritative" clause is how it opens the working tree at pre-change numbers
 * and confidently explains unrelated code.
 */
describe("P2 review F1/F2 — old-side and mixed hunks say so, in prose AND data", () => {
  const delOnly = { kind: "hunk", filePath: "a.ts", lineStart: 8, lineEnd: 9, side: "old", removedLineCount: 2 } as const;

  it("F1 pure deletion: side=old + the lines-are-gone warning in the text", () => {
    const t = buildWalkMeThroughRequest(delOnly);
    expect(t).toContain("2 lines removed from a.ts");
    expect(t).toContain("PRE-change lines 8–9");
    expect(t).toMatch(/NO LONGER EXIST in the working tree/);
    expect(t).toMatch(/read them from the changeset diff, not from disk/);
    expect(buildWalkMeThroughScope(delOnly)).toEqual({
      filePath: "a.ts", lineStart: 8, lineEnd: 9, side: "old", removedLineCount: 2,
    });
  });

  it("F1 DELETED file: the ask names the removal of the file itself", () => {
    const t = buildWalkMeThroughRequest({ ...delOnly, fileRemoved: true });
    expect(t).toContain("a.ts, which this changeset DELETES");
    expect(t).toContain("(nor does the file)");
    expect(buildWalkMeThroughScope({ ...delOnly, fileRemoved: true }).fileRemoved).toBe(true);
  });

  it("F1 add-only hunk stays side:new and says the numbers are post-change", () => {
    const t = buildWalkMeThroughRequest({ kind: "hunk", filePath: "a.ts", lineStart: 4, lineEnd: 6, side: "new" });
    expect(t).toContain("(post-change line numbers)");
    expect(t).not.toMatch(/NO LONGER EXIST/);
    expect(buildWalkMeThroughScope({ kind: "hunk", filePath: "a.ts", lineStart: 4, lineEnd: 6, side: "new" }).side).toBe("new");
  });

  it("F2 mixed hunk: the removed lines are named, though they fall outside the new-side range", () => {
    const mixed = {
      kind: "hunk", filePath: "a.ts", lineStart: 10, lineEnd: 11, side: "new",
      oldStart: 11, oldEnd: 14, removedLineCount: 4,
    } as const;
    const t = buildWalkMeThroughRequest(mixed);
    expect(t).toContain("at lines 10–11");
    expect(t).toContain("also removes 4 lines (PRE-change lines 11–14)");
    expect(t).toMatch(/read those from the diff and cover them too/);
    expect(buildWalkMeThroughScope(mixed)).toEqual({
      filePath: "a.ts", lineStart: 10, lineEnd: 11, side: "new", oldStart: 11, oldEnd: 14, removedLineCount: 4,
    });
  });
});

describe("buildWalkMeThroughScope — P2 fix 3 (scope as DATA, not prose)", () => {
  it("file → filePath (+ the artifact it was fired from)", () => {
    expect(buildWalkMeThroughScope({ kind: "file", filePath: "a.ts", artifactId: "cs_1" })).toEqual({
      filePath: "a.ts",
      artifactId: "cs_1",
    });
  });

  it("hunk → filePath + the real line range + the side", () => {
    expect(
      buildWalkMeThroughScope({ kind: "hunk", filePath: "a.ts", lineStart: 24, lineEnd: 30, side: "new", artifactId: "cs_1" }),
    ).toEqual({ filePath: "a.ts", lineStart: 24, lineEnd: 30, side: "new", artifactId: "cs_1" });
  });

  /**
   * P2 review F6 — the item scopes to what it POINTS AT, but `itemRef` anchors
   * into the DEBRIEF: dropping the debrief id left the anchor pointing into an
   * artifact the scope never named.
   */
  it("needs-eyes → the LINKED artifact, the item anchor, AND the debrief it was flagged in", () => {
    expect(
      buildWalkMeThroughScope({
        kind: "needs-eyes",
        what: "X",
        artifactRef: "cs_42",
        artifactId: "debrief_1",
        itemRef: "debrief:needs-your-eyes:2",
      }),
    ).toEqual({ artifactId: "cs_42", sourceArtifactId: "debrief_1", itemRef: "debrief:needs-your-eyes:2" });
    // The prose names both too.
    const t = buildWalkMeThroughRequest({
      kind: "needs-eyes", what: "X", artifactRef: "cs_42", artifactId: "debrief_1",
    });
    expect(t).toContain("the linked artifact cs_42 (flagged for me in debrief debrief_1)");
  });

  it("needs-eyes with NO linked artifact scopes to the debrief itself (no phantom sourceArtifactId)", () => {
    expect(
      buildWalkMeThroughScope({ kind: "needs-eyes", what: "X", artifactId: "debrief_1", itemRef: "debrief:needs-your-eyes:0" }),
    ).toEqual({ artifactId: "debrief_1", itemRef: "debrief:needs-your-eyes:0" });
  });

  it("omits what it doesn't know (no invented fields)", () => {
    expect(buildWalkMeThroughScope({ kind: "needs-eyes", what: "X" })).toEqual({});
    expect(buildWalkMeThroughScope({ kind: "file", filePath: "a.ts" })).toEqual({ filePath: "a.ts" });
  });
});

describe("hunkLineRange — P2 fix 1 (+ review F1/F2/F7)", () => {
  it("uses the NEW-side numbers when the hunk has any, and marks the side", () => {
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
      // F2 — the one deleted line rides as the pre-change envelope.
    ).toEqual({ lineStart: 25, lineEnd: 28, side: "new", oldStart: 26, oldEnd: 26, removedLineCount: 1 });
  });

  it("F2 — a mostly-deletion hunk carries the removed envelope the new range excludes", () => {
    expect(
      hunkLineRange({
        lines: [
          { kind: "ctx", content: "", oldLine: 10, newLine: 10 },
          { kind: "del", content: "", oldLine: 11 },
          { kind: "del", content: "", oldLine: 12 },
          { kind: "del", content: "", oldLine: 13 },
          { kind: "del", content: "", oldLine: 14 },
          { kind: "ctx", content: "", oldLine: 15, newLine: 11 },
        ],
      }),
    ).toEqual({ lineStart: 10, lineEnd: 11, side: "new", oldStart: 11, oldEnd: 14, removedLineCount: 4 });
  });

  it("F1 — a pure-deletion hunk returns OLD-side numbers, explicitly marked", () => {
    expect(
      hunkLineRange({ lines: [{ kind: "del", content: "", oldLine: 8 }, { kind: "del", content: "", oldLine: 9 }] }),
    ).toEqual({ lineStart: 8, lineEnd: 9, side: "old", removedLineCount: 2 });
  });

  it("returns null when the agent supplied no line numbers (affordance withheld, never a bogus range)", () => {
    expect(hunkLineRange({ lines: [{ kind: "ctx", content: "x" }] })).toBeNull();
    expect(hunkLineRange({ lines: [] })).toBeNull();
  });

  it("F7 — non-positive / non-integer numbers are not line numbers: withheld, never a 0-range 400", () => {
    expect(hunkLineRange({ lines: [{ kind: "add", content: "", newLine: 0 }] })).toBeNull();
    expect(hunkLineRange({ lines: [{ kind: "del", content: "", oldLine: -3 }] })).toBeNull();
    expect(hunkLineRange({ lines: [{ kind: "add", content: "", newLine: 1.5 }] })).toBeNull();
    // A real number alongside a junk one still yields the real range.
    expect(
      hunkLineRange({ lines: [{ kind: "add", content: "", newLine: 0 }, { kind: "add", content: "", newLine: 7 }] }),
    ).toEqual({ lineStart: 7, lineEnd: 7, side: "new" });
  });
});

describe("walkMeThroughLabel — P2 fix 4 (honest, per-grain label)", () => {
  it("names the grain instead of the ambiguous 'Walk me through this'", () => {
    expect(walkMeThroughLabel({ kind: "file", filePath: "a.ts" })).toBe("Explain this file's changes");
    expect(walkMeThroughLabel({ kind: "hunk", filePath: "a.ts", lineStart: 1, lineEnd: 2, side: "new" })).toBe("Explain this hunk");
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
        target={{ kind: "hunk", filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 28, side: "new", artifactId: "cs_1" }}
      />,
    );
    const btn = screen.getByTestId("walk-me-through-hunk");
    expect(btn).toHaveAttribute("data-walk-grain", "hunk");
    expect(btn).toHaveTextContent("Explain this hunk");
    await userEvent.click(btn);
    await waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0));
    const body = lastRequestPost();
    expect(body.text).toContain("25–28");
    expect(body.scope).toEqual({ filePath: "auth/middleware.ts", lineStart: 25, lineEnd: 28, side: "new", artifactId: "cs_1" });
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

  it("clears the sent-state timer when unmounted", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<WalkMeThroughButton target={{ kind: "file", filePath: "a.ts" }} />);
    await userEvent.click(screen.getByTestId("walk-me-through-file"));
    await screen.findByText(/posting in the sidebar/i);
    const sentTimerIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2500);
    expect(sentTimerIndex).toBeGreaterThanOrEqual(0);
    const sentTimer = timeoutSpy.mock.results[sentTimerIndex]?.value;

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(sentTimer);
  });

  it("does not schedule sent-state work when the request resolves after unmount", async () => {
    let resolveRequest!: (response: Response) => void;
    const pendingRequest = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pendingRequest));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { unmount } = render(<WalkMeThroughButton target={{ kind: "file", filePath: "late.ts" }} />);

    await userEvent.click(screen.getByTestId("walk-me-through-file"));
    unmount();
    timeoutSpy.mockClear();
    resolveRequest(new Response(JSON.stringify({
      request: { id: "req_late", text: "x", intent: "explain", createdAt: new Date().toISOString() },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 2500)).toBe(false);
    expect(useToastStore.getState().toasts).toHaveLength(0);
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
