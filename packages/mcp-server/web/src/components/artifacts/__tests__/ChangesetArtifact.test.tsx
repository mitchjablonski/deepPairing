import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Comment } from "@deeppairing/shared";
import { ChangesetArtifact } from "../ChangesetArtifact";
import { useArtifactStore } from "../../../stores/artifact";

/** A 3-file changeset. reviewState defaults to file0 reviewed only (→ 2 left). */
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

/** Seed the store so useChainComments returns our comments. */
function seed(artifact: Artifact, comments: Comment[] = []) {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(artifact);
  for (const c of comments) useArtifactStore.getState().addComment(c);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  useArtifactStore.getState().reset();
});

describe("ChangesetArtifact — file rail state", () => {
  it("renders M/A marks and per-file states (✓ reviewed / ●n comments / — untouched)", () => {
    const art = changeset();
    // A line comment on file 2 (not reviewed) → it should read as ●1.
    seed(art, [comment({ id: "cmt_s", content: "why here?", target: { artifactId: "art_cs", filePath: "auth/session.ts", lineStart: 12 } })]);
    render(<ChangesetArtifact artifact={art} />);

    // Rail rows are buttons titled "<changeType> <path>".
    const reviewedRow = screen.getByTitle("modified auth/middleware.ts");
    expect(within(reviewedRow).getByText("✓")).toBeInTheDocument();

    const commentedRow = screen.getByTitle("modified auth/session.ts");
    expect(within(commentedRow).getByText("●1")).toBeInTheDocument();

    const untouchedRow = screen.getByTitle("added auth/session.test.ts");
    expect(within(untouchedRow).getByText("—")).toBeInTheDocument();
    // The added file carries an "A" mark.
    expect(within(untouchedRow).getByText("A")).toBeInTheDocument();
  });

  it("switches the active file when a rail row is clicked", async () => {
    const art = changeset();
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    // File 0 is active initially — its diff line is shown.
    expect(screen.getByText(/getAndTouch/)).toBeInTheDocument();
    await userEvent.click(screen.getByTitle("added auth/session.test.ts"));
    expect(screen.getByText(/touch refreshes/)).toBeInTheDocument();
  });
});

describe("ChangesetArtifact — approval gating", () => {
  it("disables Approve until every file is reviewed-or-skipped, showing the count left", () => {
    seed(changeset()); // only file0 reviewed → 2 left
    render(<ChangesetArtifact artifact={changeset()} />);
    const approve = screen.getByRole("button", { name: /Approve changeset/ });
    expect(approve).toBeDisabled();
    expect(approve).toHaveTextContent("Approve changeset (2 files left)");
  });

  it("enables Approve once all files are reviewed or skipped", () => {
    const art = changeset({ reviewState: { "auth/middleware.ts": "reviewed", "auth/session.ts": "skipped", "auth/session.test.ts": "reviewed" } });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    const approve = screen.getByRole("button", { name: /Approve changeset/ });
    expect(approve).toBeEnabled();
    expect(approve).toHaveTextContent(/^Approve changeset$/);
  });

  it("clicking 'File looks right' POSTs to the changeset-review route", async () => {
    const art = changeset({ reviewState: {} });
    seed(art);
    render(<ChangesetArtifact artifact={art} />);
    await userEvent.click(screen.getByRole("button", { name: /File looks right/ }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/artifacts/art_cs/changeset-review"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"state":"reviewed"'),
        }),
      ),
    );
  });
});

describe("ChangesetArtifact — comments", () => {
  it("renders a per-file line comment thread on the active file", () => {
    const art = changeset();
    seed(art, [comment({ id: "cmt_line", content: "double check here", target: { artifactId: "art_cs", filePath: "auth/middleware.ts", lineStart: 27 } })]);
    render(<ChangesetArtifact artifact={art} />);
    expect(screen.getByText("double check here")).toBeInTheDocument();
  });

  it("renders a cross-file comment card in the rail and a chip at the anchor line", () => {
    const art = changeset();
    seed(art, [comment({
      id: "cmt_xf",
      content: "TTL constant and the middleware check must stay in sync.",
      target: { artifactId: "art_cs", anchors: [
        { filePath: "auth/middleware.ts", lineStart: 26 },
        { filePath: "auth/session.ts", lineStart: 12 },
      ] },
    })]);
    render(<ChangesetArtifact artifact={art} />);
    // Rail card.
    expect(screen.getByText("CROSS-FILE COMMENT")).toBeInTheDocument();
    expect(screen.getByText(/must stay in sync/)).toBeInTheDocument();
    // Chip on the active file's anchor line (middleware.ts:26).
    expect(screen.getByText(/cross-file/)).toBeInTheDocument();
  });
});
