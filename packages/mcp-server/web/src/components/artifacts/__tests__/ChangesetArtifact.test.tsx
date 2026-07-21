import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Comment } from "@deeppairing/shared";
import { ChangesetArtifact } from "../ChangesetArtifact";
import { useArtifactStore } from "../../../stores/artifact";
import { useOverlayStore } from "../../../stores/overlay";

/** A 3-file changeset (middleware.ts, session.ts, session.test.ts). */
function changeset(overrides: Partial<Artifact["content"]> = {}, artifactOverrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_cs",
    sessionId: "s1",
    type: "changeset",
    version: 1,
    parentId: null,
    title: "Move TTL refresh into middleware",
    status: "draft",
    content: {
      summary: "Centralize the sliding-window refresh",
      risks: ["touches auth"],
      files: [
        {
          path: "auth/middleware.ts",
          changeType: "modified",
          stats: { additions: 2, deletions: 1 },
          hunks: [{
            header: "@@ -24,3 +24,4 @@",
            lines: [
              { kind: "ctx", content: "const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
              { kind: "del", content: "const s = await store.get(sid);", oldLine: 26 },
              { kind: "add", content: "const s = await store.getAndTouch(sid);", newLine: 26 },
              { kind: "add", content: "if (!s || s.expiresAt < Date.now()) return res.status(401).end();", newLine: 27 },
            ],
          }],
        },
        {
          path: "auth/session.ts",
          changeType: "modified",
          hunks: [{ lines: [{ kind: "add", content: "expiresAt: number;", newLine: 12 }] }],
        },
        {
          path: "auth/session.test.ts",
          changeType: "added",
          hunks: [{ lines: [{ kind: "add", content: "test('touch refreshes', () => {});", newLine: 1 }] }],
        },
      ],
      reviewState: { "auth/middleware.ts": "reviewed" },
      ...overrides,
    },
    agentReasoning: null,
    createdAt: "2026-04-17T10:00:00.000Z",
    updatedAt: "2026-04-17T10:00:00.000Z",
    ...artifactOverrides,
  };
}

function comment(over: Partial<Comment> & { target: Comment["target"] }): Comment {
  return {
    id: "cmt_x",
    sessionId: "s1",
    parentCommentId: null,
    author: "human",
    content: "c",
    acknowledged: false,
    createdAt: "2026-04-17T10:01:00.000Z",
    ...over,
  } as Comment;
}

function seed(artifact: Artifact, comments: Comment[] = [], extraArtifacts: Artifact[] = []) {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(artifact);
  for (const a of extraArtifacts) useArtifactStore.getState().addArtifact(a);
  for (const c of comments) useArtifactStore.getState().addComment(c);
  // Focus the changeset so its keyboard map is live.
  useArtifactStore.setState({ selectedArtifactId: artifact.id });
}

/** Subscribe to the store so optimistic content updates re-render (mirrors
 *  ArtifactPanel passing the live store artifact). */
function Harness({ id }: { id: string }) {
  const art = useArtifactStore((s) => s.artifacts.find((a) => a.id === id));
  return art ? <ChangesetArtifact artifact={art} /> : null;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useArtifactStore.getState().reset();
  useOverlayStore.setState({ count: 0 });
});

describe("ChangesetArtifact — per-file disposition (#175)", () => {
  it("rail shows a disposition chip per file (✓ ok / ↻ changes / — review)", () => {
    const art = changeset({ reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "needs_changes" } });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    expect(within(screen.getByTitle("modified auth/middleware.ts")).getByText("✓ ok")).toBeInTheDocument();
    expect(within(screen.getByTitle("modified auth/session.ts")).getByText("↻ changes")).toBeInTheDocument();
    expect(within(screen.getByTitle("added auth/session.test.ts")).getByText("— review")).toBeInTheDocument();
  });

  it("'Looks right' POSTs the reviewed disposition", async () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    await userEvent.click(screen.getByTestId("looks-right"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/artifacts/art_cs/changeset-review"),
        expect.objectContaining({ method: "POST", body: expect.stringContaining('"state":"reviewed"') }),
      ),
    );
  });

  it("'Needs changes' POSTs needs_changes and reveals the reason box", async () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    render(<Harness id="art_cs" />);
    await userEvent.click(screen.getByTestId("needs-changes"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/artifacts/art_cs/changeset-review"),
        expect.objectContaining({ method: "POST", body: expect.stringContaining('"state":"needs_changes"') }),
      ),
    );
    expect(await screen.findByTestId("needs-box")).toBeInTheDocument();
  });
});

describe("ChangesetArtifact — derived whole-changeset action (#175)", () => {
  it("all files look right → Approve changeset", () => {
    const art = changeset({ reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" } });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    expect(screen.getByTestId("approve-changeset")).toBeInTheDocument();
    expect(screen.queryByTestId("send-back")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approve-all")).not.toBeInTheDocument();
  });

  it("any file flagged → Send back N (no Approve)", () => {
    const art = changeset({ reviewState: { "auth/middleware.ts": "needs_changes", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" } });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    const sendBack = screen.getByTestId("send-back");
    expect(sendBack).toHaveTextContent("Send back 1 file");
    expect(screen.queryByTestId("approve-changeset")).not.toBeInTheDocument();
    expect(screen.queryByTestId("approve-all")).not.toBeInTheDocument();
  });

  it("fresh / partial with nothing flagged → the Approve all N files fast path", () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    expect(screen.getByTestId("approve-all")).toHaveTextContent("Approve all 3 files");
    expect(screen.queryByTestId("approve-changeset")).not.toBeInTheDocument();
    expect(screen.queryByTestId("send-back")).not.toBeInTheDocument();
  });
});

describe("ChangesetArtifact — send-back wire shape (#175 / #187 hazard)", () => {
  it("Send back calls updateArtifactStatus('revised', <files+reasons>) — an exact string, never an event", async () => {
    const art = changeset({
      reviewState: { "auth/middleware.ts": "needs_changes", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" },
      reviewReasons: { "auth/middleware.ts": "keep the login TTL bump" },
    });
    seed(art);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ updateArtifactStatus: updateStatus });
    render(<ChangesetArtifact artifact={art} />);

    await userEvent.click(screen.getByTestId("send-back"));
    await waitFor(() => expect(updateStatus).toHaveBeenCalledTimes(1));
    const [id, status, feedback, concept] = updateStatus.mock.calls[0]!;
    expect(id).toBe("art_cs");
    expect(status).toBe("revised");
    expect(typeof feedback).toBe("string");
    expect(feedback).toContain("auth/middleware.ts");
    expect(feedback).toContain("keep the login TTL bump");
    // The accepted files never travel in the send-back.
    expect(feedback).not.toContain("auth/session.test.ts");
    expect(concept).toBeUndefined();
  });
});

describe("ChangesetArtifact — approve-all fast path + confirm-countdown (#175)", () => {
  it("reaching all-look-right ARMS the confirm-countdown (never a silent commit)", async () => {
    // One file left pending; marking it flips to all-look-right.
    const art = changeset({ reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "reviewed" } });
    seed(art);
    render(<Harness id="art_cs" />);
    // session.test.ts is the pending one — select it, then mark it look-right.
    await userEvent.click(screen.getByTitle("added auth/session.test.ts"));
    await userEvent.click(screen.getByTestId("looks-right"));
    expect(await screen.findByTestId("approve-countdown")).toBeInTheDocument();
  });

  it("the countdown auto-commits approve at zero, then advances to the next pending artifact", async () => {
    vi.useFakeTimers();
    const other = { ...changeset({}, { id: "art_next", type: "research", title: "Later" }) } as Artifact;
    (other as any).content = { summary: "s", findings: [] };
    const art = changeset({ reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" } });
    seed(art, [], [other]);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const selectArtifact = vi.fn();
    useArtifactStore.setState({ updateArtifactStatus: updateStatus, selectArtifact });
    render(<ChangesetArtifact artifact={art} />);

    // Explicit approve arms the countdown (all look right on mount → no auto-arm).
    act(() => { fireEvent.click(screen.getByTestId("approve-changeset")); });
    expect(screen.getByTestId("approve-countdown")).toBeInTheDocument();
    // Advance past the 3s window → auto-commit (async act flushes runWhole's await).
    await act(async () => { vi.advanceTimersByTime(3000); await Promise.resolve(); });
    expect(updateStatus).toHaveBeenCalledWith("art_cs", "approved", undefined, undefined);
    // Auto-advance to the next pending draft (AFTER the verdict posts).
    expect(selectArtifact).toHaveBeenCalledWith("art_next");
  });

  it("Hold cancels the armed countdown without committing", () => {
    vi.useFakeTimers();
    const art = changeset({ reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" } });
    seed(art);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ updateArtifactStatus: updateStatus });
    render(<ChangesetArtifact artifact={art} />);
    act(() => { fireEvent.click(screen.getByTestId("approve-changeset")); });
    act(() => { fireEvent.click(screen.getByTestId("hold-approve")); });
    expect(screen.queryByTestId("approve-countdown")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("ChangesetArtifact — keyboard, scoped to focus (#175 / #187 hazard)", () => {
  it("'a' marks the active file reviewed (exact 'reviewed') and auto-advances to the next file", () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    const setReview = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ setChangesetFileReview: setReview });
    render(<ChangesetArtifact artifact={art} />);
    // File 0 (middleware) is active — its diff line shows.
    expect(screen.getByText(/getAndTouch/)).toBeInTheDocument();
    act(() => { fireEvent.keyDown(document.body, { key: "a" }); });
    // Exact dispatched value — path + the STRING "reviewed", never an event.
    expect(setReview).toHaveBeenCalledWith("art_cs", "auth/middleware.ts", "reviewed");
    // Auto-advanced to file 1 (session.ts).
    expect(screen.getByText(/expiresAt: number;/)).toBeInTheDocument();
  });

  it("'j' / 'k' move between files without touching disposition", () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    act(() => { fireEvent.keyDown(document.body, { key: "j" }); });
    expect(screen.getByText(/expiresAt: number;/)).toBeInTheDocument();
    act(() => { fireEvent.keyDown(document.body, { key: "k" }); });
    expect(screen.getByText(/getAndTouch/)).toBeInTheDocument();
  });

  it("'Enter' fires the derived action (send-back when a file is flagged)", async () => {
    const art = changeset({
      reviewState: { "auth/middleware.ts": "needs_changes", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" },
      reviewReasons: { "auth/middleware.ts": "fix it" },
    });
    seed(art);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ updateArtifactStatus: updateStatus });
    render(<ChangesetArtifact artifact={art} />);
    act(() => { fireEvent.keyDown(document.body, { key: "Enter" }); });
    await waitFor(() => expect(updateStatus).toHaveBeenCalledWith("art_cs", "revised", expect.stringContaining("auth/middleware.ts"), undefined));
  });

  it("the keys are DEAD when the changeset is not the focused artifact", () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    useArtifactStore.setState({ selectedArtifactId: "some-other-artifact" });
    const setReview = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ setChangesetFileReview: setReview });
    render(<ChangesetArtifact artifact={art} />);
    act(() => { fireEvent.keyDown(document.body, { key: "a" }); });
    expect(setReview).not.toHaveBeenCalled();
  });

  it("the keys are DEAD while ANY overlay is open (e.g. the ? cheat-sheet) — no write behind the modal", () => {
    const art = changeset({
      reviewState: { "auth/middleware.ts": "needs_changes", "auth/session.ts": "reviewed", "auth/session.test.ts": "reviewed" },
      reviewReasons: { "auth/middleware.ts": "fix it" },
    });
    seed(art); // focused changeset
    const setReview = vi.fn().mockResolvedValue(undefined);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    useArtifactStore.setState({ setChangesetFileReview: setReview, updateArtifactStatus: updateStatus });
    render(<ChangesetArtifact artifact={art} />);
    // An overlay is present over the focused draft changeset.
    act(() => { useOverlayStore.setState({ count: 1 }); });
    act(() => { fireEvent.keyDown(document.body, { key: "a" }); });
    act(() => { fireEvent.keyDown(document.body, { key: "Enter" }); });
    // Neither the disposition nor the send-back fired behind the modal.
    expect(setReview).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    // With the overlay closed, the same keys act again.
    act(() => { useOverlayStore.setState({ count: 0 }); });
    act(() => { fireEvent.keyDown(document.body, { key: "a" }); });
    expect(setReview).toHaveBeenCalled();
  });
});

describe("ChangesetArtifact — Review all toggle (#175)", () => {
  it("stacks every file's diff in one scroll", async () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    // File-by-file: only the active file's diff is mounted.
    expect(screen.queryByText(/touch refreshes/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Review all/ }));
    // All three files' diffs are now present.
    expect(screen.getByText(/getAndTouch/)).toBeInTheDocument();
    expect(screen.getByText(/expiresAt: number;/)).toBeInTheDocument();
    expect(screen.getByText(/touch refreshes/)).toBeInTheDocument();
  });
});

describe("ChangesetArtifact — comments still thread (#171 regression guard)", () => {
  it("renders a per-file line comment thread + a cross-file card", () => {
    const art = changeset();
    seed(art, [
      comment({ id: "cmt_line", content: "double check here", target: { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 27 } }),
      comment({ id: "cmt_xf", content: "keep these in sync", target: { artifactId: "art_cs", anchors: [
        { filePath: "auth/middleware.ts", lineStart: 26 },
        { filePath: "auth/session.ts", lineStart: 12 },
      ] } }),
    ]);
    render(<ChangesetArtifact artifact={art} />);
    expect(screen.getByText("double check here")).toBeInTheDocument();
    expect(screen.getByText("CROSS-FILE COMMENT")).toBeInTheDocument();
  });
});
