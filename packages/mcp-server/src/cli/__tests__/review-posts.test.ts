import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it.each(["sending", "unknown"] as const)("operator acknowledgement preserves %s evidence and still requires repost", state => {
  const lease = journal.reserve(identity);
  journal.markSending(lease, identity);
  if (state === "unknown") journal.markUnknown(lease);
  const [{ operationDigest }] = JSON.parse(reviewPostsCommand(root, ["s"]));
  expect(() => journal.reserve(identity, true)).toThrow();
  expect(() => reviewPostsCommand(root, ["s", "acknowledge-unknown", lease.operationId, operationDigest])).toThrow();
  expect(() => journal.acknowledgeUnknown(lease.operationId, operationDigest, false, true)).toThrow();
  expect(() => journal.acknowledgeUnknown(lease.operationId, operationDigest, true, false)).toThrow();
  const output = reviewPostsCommand(root, ["s", "acknowledge-unknown", lease.operationId, operationDigest,
    "--all-writers-stopped", "--accept-duplicate-risk"]);
  expect(output).toContain("does NOT prove");
  expect(journal.list()[0]).toMatchObject({ id: lease.operationId, state: "abandoned",
    operatorAcknowledgement: { priorState: state, operationDigest } });
  expect(() => journal.markSending(lease, identity)).toThrow();
  expect(() => journal.markUnknown(lease)).toThrow();
  expect(() => journal.reserve(identity)).toThrow(/repost/);
  const next = journal.reserve(identity, true);
  expect(next.operationId).not.toBe(lease.operationId);
  expect(new ReviewPostJournal(root, "s").list()).toHaveLength(2);
});

it("cannot acknowledge a reserved or changed operation from stale inspection", () => {
  const lease = journal.reserve(identity);
  const [{ operationDigest }] = JSON.parse(reviewPostsCommand(root, ["s"]));
  expect(() => journal.acknowledgeUnknown(lease.operationId, operationDigest, true, true)).toThrow();
  journal.markSending(lease, identity);
  expect(() => journal.acknowledgeUnknown(lease.operationId, operationDigest, true, true)).toThrow(/changed/);
  expect(journal.list()[0].state).toBe("sending");
});

it.each(["review-post-operations.json", "posted-reviews.json"])("inspection explains corrupt %s without dumping or clearing it", filename => {
  journal.reserve(identity);
  const file = path.join(path.dirname(journal.journalPath), filename);
  const secretBytes = '{"private-token":"do-not-print-this"';
  fs.writeFileSync(file, secretBytes);
  const output = reviewPostsCommand(root, ["s", "list"]);
  expect(JSON.parse(output)).toMatchObject({ blocked: true });
  expect(output).toContain(file.replaceAll("\\", "\\\\"));
  expect(output).not.toContain("do-not-print-this");
  expect(reviewPostsCommand(root, ["s", "inspect"])).not.toContain("private-token");
  expect(fs.readFileSync(file, "utf8")).toBe(secretBytes);
  expect(() => journal.reserve(identity, true)).toThrow();
});

it("claim release requires explicit offline coordination and the unchanged inspected digest", () => {
  const lease = journal.reserve(identity);
  const before = fs.readFileSync(journal.journalPath, "utf8");
  fs.writeFileSync(journal.claimPath, "secret-owner-token");
  const output = reviewPostsCommand(root, ["s", "inspect"]);
  expect(output).not.toContain("secret-owner-token");
  const digest = JSON.parse(output).claim.digest;
  expect(() => reviewPostsCommand(root, ["s", "release-claim", digest])).toThrow();
  expect(() => journal.releaseClaim(digest, false)).toThrow();
  fs.writeFileSync(journal.claimPath, "replacement-owner-token");
  expect(() => journal.releaseClaim(digest, true)).toThrow(/changed/);
  expect(fs.readFileSync(journal.claimPath, "utf8")).toBe("replacement-owner-token");
  const replacementDigest = JSON.parse(reviewPostsCommand(root, ["s", "inspect"])).claim.digest;
  expect(reviewPostsCommand(root, ["s", "release-claim", replacementDigest, "--all-writers-stopped"])).toContain("Journal/history unchanged");
  expect(fs.existsSync(journal.claimPath)).toBe(false);
  expect(fs.readFileSync(journal.journalPath, "utf8")).toBe(before);
  journal.cancelReserved(lease.operationId);
  expect(journal.list()[0].state).toBe("failed");
});

it("inspection refuses oversized history before reading its bytes", () => {
  const fd = fs.openSync(journal.journalPath, "w");
  fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1);
  fs.closeSync(fd);
  const read = vi.spyOn(fs, "readSync");
  try {
    const output = JSON.parse(reviewPostsCommand(root, ["s", "inspect"]));
    expect(output.journal).toMatchObject({ valid: false, bytes: 8 * 1024 * 1024 + 1 });
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
  expect(fs.statSync(journal.journalPath).size).toBe(8 * 1024 * 1024 + 1);
});

it("oversized claims cannot be inspected into release permission", () => {
  fs.writeFileSync(journal.claimPath, "x".repeat(4097));
  const output = JSON.parse(reviewPostsCommand(root, ["s", "inspect"]));
  expect(output.claim.bytes).toBe(4097);
  expect(output.claim.digest).toBeUndefined();
  expect(() => journal.releaseClaim("a".repeat(64), true)).toThrow();
  expect(fs.statSync(journal.claimPath).size).toBe(4097);
});

it.each([[], ["s", "force"], ["s", "cancel-reserved"], ["s", "list", "extra"], ["../outside"]].map(args => [args]))(
  "rejects invalid operator arguments %j", args => {
    expect(() => reviewPostsCommand(root, args)).toThrow();
  },
);
