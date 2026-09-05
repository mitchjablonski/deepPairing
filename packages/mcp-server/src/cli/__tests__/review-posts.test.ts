import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewPostsCommand } from "../review-posts.js";
import { ReviewPostJournal } from "../../store/review-post-journal.js";

let root: string;
let journal: ReviewPostJournal;
const identity = { target: "https://github.com/acme/widget/pull/1", event: "COMMENT" as const,
  payloadDigest: "a".repeat(64), authorizationDigest: "b".repeat(64) };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-post-operator-"));
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions", "s"), { recursive: true });
  journal = new ReviewPostJournal(root, "s");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("lists durable status without exposing fencing or authorization fingerprints", () => {
  const lease = journal.reserve(identity);
  const text = reviewPostsCommand(root, ["s"]);
  expect(JSON.parse(text)).toMatchObject([{ id: lease.operationId, state: "reserved" }]);
  expect(text).not.toContain(lease.token);
  expect(text).not.toContain("tokenDigest");
  expect(text).not.toContain(identity.authorizationDigest);
});

it("explicit reserved cancellation fences the old caller", () => {
  const lease = journal.reserve(identity);
  expect(reviewPostsCommand(root, ["s", "cancel-reserved", lease.operationId])).toContain("Cancelled");
  expect(() => journal.markSending(lease, identity)).toThrow();
  expect(journal.list()[0].state).toBe("failed");
});

it("refuses cancellation of a possibly sent operation and preserves uncertainty", () => {
  const lease = journal.reserve(identity);
  journal.markSending(lease, identity);
  expect(() => reviewPostsCommand(root, ["s", "cancel-reserved", lease.operationId])).toThrow(/cannot be cancelled/);
  expect(journal.list()[0].state).toBe("sending");
});

it.each([[], ["s", "force"], ["s", "cancel-reserved"], ["s", "list", "extra"], ["../outside"]].map(args => [args]))(
  "rejects invalid operator arguments %j", args => {
    expect(() => reviewPostsCommand(root, args)).toThrow();
  },
);
