import { describe, expect, it } from "vitest";
import type { Comment } from "@deeppairing/shared";
import { deriveCommentState } from "../../../web/src/lib/pageReviewQueue.js";
import { effectiveHumanResolution } from "../comment-resolution.js";

const earlier = "2026-01-01T00:00:00.000Z";
const stamp = "2026-01-02T00:00:00.000Z";
const later = "2026-01-03T00:00:00.000Z";
const root: Comment = {
  id: "root", sessionId: "s1", target: { artifactId: "page" }, parentCommentId: null,
  author: "human", content: "Review", createdAt: earlier, acknowledged: false, humanResolvedAt: stamp,
};
const human = (createdAt: string): Comment => ({ ...root, id: "reply", createdAt, parentCommentId: root.id });
const agent = (createdAt: string): Comment => ({ ...human(createdAt), author: "agent" });
const revision = { artifactId: "v2", version: 2 };

describe("effective human resolution matches the review queue", () => {
  const cases: [string, Partial<Comment>, Comment[], string | undefined, boolean][] = [
    ["human reply ties the resolution", {}, [human(stamp)], undefined, true],
    ["human reply follows the resolution", {}, [human(later)], undefined, false],
    ["agent reply precedes the resolution", {}, [agent(earlier)], undefined, true],
    ["agent reply ties the resolution", {}, [agent(stamp)], undefined, false],
    ["agent reply follows the resolution", {}, [agent(later)], undefined, false],
    ["reply timestamp falls back to root", { createdAt: stamp }, [agent("")], undefined, false],
    ["missing linked answer uses the root time", { createdAt: stamp, answeredByCommentId: "gone" }, [], undefined, false],
    ["revision stamp ties the resolution", { addressedIn: { ...revision, at: stamp } }, [], earlier, false],
    ["revision creation supplies a missing stamp", { addressedIn: revision }, [], later, false],
    ["missing revision time falls back to root", { createdAt: stamp, addressedIn: revision }, [], undefined, false],
    ["root postdates a legacy resolve stamp", { createdAt: later }, [], undefined, false],
  ];

  it.each(cases)("%s", (_label, patch, replies, revisionAt, resolved) => {
    const comment = { ...root, ...patch };
    const revisions = revisionAt ? [{ id: revision.artifactId, createdAt: revisionAt }] : [];
    const effective = effectiveHumanResolution([comment, ...replies], revisions)(comment);
    const displayed = deriveCommentState(comment, replies, false, { revisionAt: () => revisionAt });
    expect(displayed.kind === "addressed" && displayed.via === "resolved").toBe(resolved);
    expect(effective).toBe(resolved ? stamp : undefined);
  });
});
