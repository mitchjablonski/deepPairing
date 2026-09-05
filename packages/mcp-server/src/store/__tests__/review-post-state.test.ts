import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../file-store.js";
import { SessionReviewConflictError } from "../session-records.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { executeDurableReviewPost } from "../../github/durable-review-post.js";
import { reviewPostDigest } from "../review-post-journal.js";

let fx: GlobalStoreFixture;
beforeEach(() => { fx = withGlobalStore("dp-review-post-state-"); });
afterEach(() => fx.dispose());
const open = () => fx.track(new FileStore(fx.dir, "review"));
const file = (name = "artifacts.json") => path.join(fx.dir, ".deeppairing", "sessions", "review", name);

function seed(approved = false) {
  const store = open();
  store.createArtifact({ id: "a", type: "research", title: "Original", content: { summary: "Reviewed text" } });
  if (approved) store.updateArtifactStatus("a", "approved", "ui_approve_button");
  store.forceFlush();
  return store;
}

describe("posting-specific fresh authorization state", () => {
  it.each(["{broken", "{}", '[{"reviewId":1}]'])("refuses corrupt or invalid posting history: %s", bytes => {
    const store = seed(true);
    fs.writeFileSync(file("posted-reviews.json"), bytes);
    expect(() => store.getReviewPostState()).toThrow(/history is unreadable or invalid/);
    expect(fs.readFileSync(file("posted-reviews.json"), "utf8")).toBe(bytes);
  });

  it("does not send if legacy history becomes corrupt after reservation", async () => {
    const store = seed(true);
    const journal = store.reviewPosts;
    const payload = { event: "COMMENT" as const, body: "Reviewed", comments: [] };
    const identity = {
      target: "https://github.com/acme/widgets/pull/42", event: payload.event,
      payloadDigest: reviewPostDigest(payload), authorizationDigest: "a".repeat(64),
    };
    let sends = 0;
    await expect(executeDurableReviewPost({
      store: {
        reserve: (value, repost) => {
          const lease = journal.reserve(value, repost);
          fs.writeFileSync(file("posted-reviews.json"), "{broken");
          return lease;
        },
        markSending: (lease, value) => journal.markSending(lease, value),
        failBeforeSending: lease => journal.failBeforeSending(lease),
        markUnknown: lease => journal.markUnknown(lease),
        succeed: (lease, result) => journal.succeed(lease, result),
      },
      payload, identity, repost: false,
      reauthorize: () => { store.getReviewPostState(); return identity; },
      send: async () => { sends++; throw new Error("Must not send"); },
    })).rejects.toThrow(/did not start its POST/);
    expect(sends).toBe(0);
    expect(journal.list()[0]!.state).toBe("failed");
  });

  it("observes external revocation without an artifact mutation or a helpful forceFlush", () => {
    seed(true);
    const stale = open();
    const external = open();
    external.updateArtifactStatus("a", "obsolete", "agent_obsolete");
    external.forceFlush();
    const bytes = fs.readFileSync(file(), "utf8");
    expect(stale.getFullState().artifacts[0]!.status).toBe("approved");
    expect(stale.getReviewPostState().artifacts[0]!.status).toBe("obsolete");
    stale.forceFlush();
    expect(stale.getReviewPostState().artifacts[0]!.status).toBe("obsolete");
    stale.addComment({ id: "c", artifactId: "a", author: "human", content: "Unrelated pending comment" });
    expect(stale.getReviewPostState().artifacts[0]!.status).toBe("obsolete");
    expect(fs.existsSync(file("comments.json"))).toBe(false);
    stale.forceFlush();
    expect(stale.getReviewPostState().artifacts[0]!.status).toBe("obsolete");
    expect(stale.getFullState().artifacts[0]!.status).toBe("approved");
    expect(fs.readFileSync(file(), "utf8")).toBe(bytes);
  });

  it("honors external record deletion even with an unrelated local artifact delta", () => {
    seed(true);
    const stale = open();
    stale.renameArtifact("a", "Pending local title");
    fs.writeFileSync(file(), "[]");
    expect(stale.getReviewPostState().artifacts).toEqual([]);
    expect(stale.getFullState().artifacts[0]!.title).toBe("Pending local title");
    expect(fs.readFileSync(file(), "utf8")).toBe("[]");
  });

  it("reads equal-size external verdict bytes even when mtime moves backwards", () => {
    seed(true);
    const stale = open();
    const before = fs.statSync(file());
    const bytes = fs.readFileSync(file(), "utf8").replace('"status": "approved"', '"status": "rejected"');
    fs.writeFileSync(file(), bytes);
    fs.utimesSync(file(), before.atime, new Date(before.mtimeMs - 60_000));
    expect(fs.statSync(file()).size).toBe(before.size);
    expect(stale.getReviewPostState().artifacts[0]!.status).toBe("rejected");
  });

  it("projects a pending local approval without persisting it", () => {
    seed();
    const local = open();
    const before = fs.readFileSync(file(), "utf8");
    const mtime = fs.statSync(file()).mtimeMs;
    local.updateArtifactStatus("a", "approved", "ui_approve_button");
    expect(local.getReviewPostState()).toMatchObject({ sessionId: "review", artifacts: [{ id: "a", status: "approved" }], postedReviews: [] });
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
    expect(fs.statSync(file()).mtimeMs).toBe(mtime);
    local.forceFlush();
    expect(open().getArtifacts()[0]!.status).toBe("approved");
  });

  it("preserves pending metadata and does not import remote fields into the live cache or its delta", () => {
    seed(true);
    const local = open();
    const external = open();
    local.renameArtifact("a", "Local title");
    external.updateArtifactStatus("a", "obsolete", "agent_obsolete");
    external.forceFlush();
    const before = fs.readFileSync(file(), "utf8");
    expect(local.getReviewPostState().artifacts[0]).toMatchObject({ title: "Local title", status: "obsolete" });
    expect(local.getArtifacts()[0]).toMatchObject({ title: "Local title", status: "approved" });
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
    local.forceFlush();
    expect(open().getArtifacts()[0]).toMatchObject({ title: "Local title", status: "obsolete" });
  });

  it.each(["rejected", "obsolete", "superseded", "retracted"] as const)(
    "does not overwrite a concurrent persisted %s with a pending approval", (status) => {
      seed();
      const local = open();
      const external = open();
      local.updateArtifactStatus("a", "approved", "ui_approve_button");
      external.updateArtifactStatus("a", status, status === "rejected" ? "ui_reject_button" : status === "obsolete" ? "agent_obsolete" : status === "superseded" ? "agent_supersede" : "agent_retract");
      external.forceFlush();
      const before = fs.readFileSync(file(), "utf8");
      expect(() => local.getReviewPostState()).toThrow(SessionReviewConflictError);
      expect(() => local.getReviewPostState()).toThrow(SessionReviewConflictError);
      expect(() => local.forceFlush()).toThrow(SessionReviewConflictError);
      expect(fs.readFileSync(file(), "utf8")).toBe(before);
    },
  );

  it.each([false, true])("fences content/verdict conflict without flushing (contentPersisted=%s)", (contentPersisted) => {
    seed();
    const contentWriter = open();
    const reviewer = open();
    contentWriter.getArtifacts()[0]!.content = { summary: "Unreviewed replacement" };
    contentWriter.getArtifacts()[0]!.version = 2;
    contentWriter.renameArtifact("a", "Changed proposal");
    reviewer.updateArtifactStatus("a", "approved", "ui_approve_button");
    const persisted = contentPersisted ? contentWriter : reviewer;
    const pending = contentPersisted ? reviewer : contentWriter;
    persisted.forceFlush();
    const before = fs.readFileSync(file(), "utf8");
    expect(() => pending.getReviewPostState()).toThrow(SessionReviewConflictError);
    expect(() => pending.getFullState()).toThrow(SessionReviewConflictError);
    expect(() => pending.forceFlush()).toThrow(SessionReviewConflictError);
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
  });

  it.each(["{", "{}", "null", "[null]", '[{"id":"a"}]'])("rejects malformed persisted artifacts: %s", (bytes) => {
    seed(true);
    const stale = open();
    fs.writeFileSync(file(), bytes);
    expect(() => stale.getReviewPostState()).toThrow();
    expect(fs.readFileSync(file(), "utf8")).toBe(bytes);
    expect(fs.existsSync(file(".flush.lock"))).toBe(false);
  });

  it("rejects duplicate persisted IDs rather than selecting whichever record is last", () => {
    seed(true);
    const stale = open();
    const [artifact] = JSON.parse(fs.readFileSync(file(), "utf8"));
    const bytes = JSON.stringify([artifact, { ...artifact, status: "obsolete" }]);
    fs.writeFileSync(file(), bytes);
    expect(() => stale.getReviewPostState()).toThrow(/duplicate/i);
    expect(fs.readFileSync(file(), "utf8")).toBe(bytes);
  });

  it("returns detached nested artifacts and freshly read detached posting history", () => {
    seed(true);
    const stale = open();
    const external = open();
    external.recordPostedReview({ pr: "42", prNumber: 42, event: "APPROVE", reviewId: 123, url: "https://github.com/acme/repo/pull/42#pullrequestreview-123", postedAt: "2026-01-01T00:00:00Z", commentCount: 0 });
    const snapshot = stale.getReviewPostState();
    snapshot.artifacts[0]!.content.summary = "Caller mutation";
    snapshot.artifacts[0]!.status = "obsolete";
    snapshot.postedReviews[0]!.reviewId = 456;
    snapshot.artifacts.push({ ...snapshot.artifacts[0]!, id: "injected" });
    expect(stale.getArtifacts()[0]!.content.summary).toBe("Reviewed text");
    const again = stale.getReviewPostState();
    expect(again.artifacts).toHaveLength(1);
    expect(again.artifacts[0]).toMatchObject({ status: "approved", content: { summary: "Reviewed text" } });
    expect(again.postedReviews[0]!.reviewId).toBe(123);
  });

  it("fails closed on lock contention without stealing the owner's claim", () => {
    seed(true);
    const stale = open();
    fs.writeFileSync(file(".flush.lock"), "other writer owns this");
    const before = fs.readFileSync(file(), "utf8");
    expect(() => stale.getReviewPostState()).toThrow(/lock busy/i);
    expect(fs.readFileSync(file(".flush.lock"), "utf8")).toBe("other writer owns this");
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
    fs.unlinkSync(file(".flush.lock"));
    expect(stale.getReviewPostState().artifacts[0]!.status).toBe("approved");
  });

  it("refuses a disposed writer", () => {
    const store = seed(true);
    store.dispose();
    expect(() => store.getReviewPostState()).toThrow(/disposed/i);
    expect(fs.existsSync(file(".flush.lock"))).toBe(false);
  });

  it("refuses a missing previously observed nonempty collection", () => {
    seed(true);
    const stale = open();
    fs.unlinkSync(file());
    expect(() => stale.getReviewPostState()).toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });

  it("refuses a missing previously observed empty collection", () => {
    open();
    fs.writeFileSync(file(), "[]");
    const stale = open();
    fs.unlinkSync(file());
    expect(() => stale.getReviewPostState()).toThrow();
  });

  it("allows a never-persisted collection with a pending local approval without creating files", () => {
    const local = open();
    local.createArtifact({ id: "a", type: "research", title: "New", content: {} });
    local.updateArtifactStatus("a", "approved", "ui_approve_button");
    expect(fs.existsSync(file())).toBe(false);
    expect(local.getReviewPostState().artifacts[0]!.status).toBe("approved");
    expect(fs.existsSync(file())).toBe(false);
  });

  it("refuses independently added same-ID proposals instead of projecting local approval onto a collision", () => {
    const local = open();
    const external = open();
    local.createArtifact({ id: "collision", type: "research", title: "Local", content: { summary: "Local reviewed proposal" } });
    local.updateArtifactStatus("collision", "approved", "ui_approve_button");
    external.createArtifact({ id: "collision", type: "research", title: "External", content: { summary: "External unreviewed proposal" } });
    external.forceFlush();
    const before = fs.readFileSync(file(), "utf8");
    expect(() => local.getReviewPostState()).toThrow(SessionReviewConflictError);
    expect(() => local.forceFlush()).toThrow(SessionReviewConflictError);
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
  });
});
