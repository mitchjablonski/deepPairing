import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommentThread } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";
import type { Comment } from "@deeppairing/shared";

/**
 * #160 — the comment-side secret-warning consumer. The daemon scans every
 * comment body at create time (FileStore.addComment) and persists a
 * labels-only `secretWarnings` field on the comment; this chip is the UI
 * surface — a small inline ⚠ next to the author, reusing the
 * SecretWarningBanner's amber tokens (NOT a second banner: a comment is a
 * small surface, the banner belongs to the artifact).
 *
 * The fixture secret is AWS's documented EXAMPLE key — never a real
 * credential. Assertions are on the chip's fixed text + labels only.
 */
const FAKE_SECRET = "AKIAIOSFODNN7EXAMPLE";

const mkComment = (over: Partial<Comment> = {}): Comment =>
  ({
    id: "cmt_1",
    sessionId: "s1",
    target: { artifactId: "art_1" },
    parentCommentId: null,
    author: "human",
    content: `I pasted my key ${FAKE_SECRET} — is that a problem?`,
    answeredByCommentId: null,
    acknowledged: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  }) as Comment;

const flagged = () =>
  mkComment({
    secretWarnings: [{ pattern: "AKIA", label: "AWS access key id", line: 1 }],
  });

beforeEach(() => {
  useArtifactStore.getState().reset();
});

describe("#160 — inline secret chip on flagged comments", () => {
  it("renders the ⚠ chip (with the kind in its title) when the scanner flagged the comment", () => {
    render(<CommentThread artifactId="art_1" comments={[flagged()]} />);
    const chip = screen.getByTestId("comment-secret-chip");
    expect(chip).toHaveTextContent(/possible secret/i);
    expect(chip).toHaveAttribute("title", expect.stringContaining("AWS access key id"));
    expect(chip).toHaveAttribute("title", expect.stringContaining("line 1"));
  });

  it("renders NO chip on a clean comment", () => {
    render(
      <CommentThread
        artifactId="art_1"
        comments={[mkComment({ content: "looks good, ship it", secretWarnings: undefined })]}
      />,
    );
    expect(screen.queryByTestId("comment-secret-chip")).toBeNull();
    expect(screen.queryByText(/possible secret/i)).toBeNull();
  });

  it("NEVER echoes the matched secret value into the chip (text or title)", () => {
    render(<CommentThread artifactId="art_1" comments={[flagged()]} />);
    const chip = screen.getByTestId("comment-secret-chip");
    expect(chip.textContent).not.toContain(FAKE_SECRET);
    expect(chip.getAttribute("title")).not.toContain(FAKE_SECRET);
  });

  it("survives a reload: a plain-JSON comment (WS/state hydration shape) still shows the chip", () => {
    const fromDisk = JSON.parse(JSON.stringify(flagged())) as Comment;
    render(<CommentThread artifactId="art_1" comments={[fromDisk]} />);
    expect(screen.getByTestId("comment-secret-chip")).toHaveTextContent(/possible secret/i);
  });
});
