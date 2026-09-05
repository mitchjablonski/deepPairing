import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReviewPostJournal, reviewPostDigest, type ReviewPostIdentity } from "../../store/review-post-journal.js";
import { writeJsonAtomic } from "../../store/atomic-write.js";
import { executeDurableReviewPost, ReviewPostNotSentError, ReviewPostUnknownError } from "../durable-review-post.js";

const target = "https://github.com/acme/widget/pull/12";
const payload = { body: "Reviewed", event: "COMMENT" as const, comments: [] };
const identity: ReviewPostIdentity = {
  target, event: "COMMENT", payloadDigest: reviewPostDigest(payload), authorizationDigest: "b".repeat(64),
};
const result = { id: 7, htmlUrl: `${target}#pullrequestreview-7`, state: "COMMENTED" as const };
let root: string;
let store: ReviewPostJournal;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-durable-post-"));
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions", "s"), { recursive: true });
  store = new ReviewPostJournal(root, "s");
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it("two concurrent callers cause one actual send", async () => {
  let sends = 0;
  const send = async () => { sends++; return result; };
  const outcomes = await Promise.allSettled([0, 1].map(() => executeDurableReviewPost({
    store, identity, payload, repost: false, reauthorize: () => identity, send,
  })));
  expect(sends).toBe(1);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(store.list()[0].state).toBe("succeeded");
});

it("cannot disguise an unbound approval as a legacy comment in the journal", async () => {
  const approval = { ...payload, event: "APPROVE" as const };
  await expect(executeDurableReviewPost({
    store, identity: { ...identity, payloadDigest: reviewPostDigest(approval) }, payload: approval,
    repost: false, reauthorize: () => identity, send: async () => result,
  })).rejects.toThrow(/does not match/);
  expect(store.list()).toEqual([]);
});

it("rechecks local authorization after reservation and never sends a changed verdict/payload", async () => {
  let sends = 0;
  await expect(executeDurableReviewPost({
    store, identity, payload, repost: false,
    reauthorize: () => ({ ...identity, authorizationDigest: "c".repeat(64) }),
    send: async () => { sends++; return result; },
  })).rejects.toBeInstanceOf(ReviewPostNotSentError);
  expect(sends).toBe(0);
  expect(store.list()[0].state).toBe("failed");
});

it("remote acceptance followed by a lost response blocks retry after restart, even with repost", async () => {
  let sends = 0;
  await expect(executeDurableReviewPost({
    store, identity, payload, repost: false, reauthorize: () => identity,
    send: async () => { sends++; throw new Error("response lost after acceptance"); },
  })).rejects.toBeInstanceOf(ReviewPostUnknownError);
  const fresh = new ReviewPostJournal(root, "s");
  expect(fresh.list()[0].state).toBe("unknown");
  await expect(executeDurableReviewPost({
    store: fresh, identity, payload, repost: true, reauthorize: () => identity,
    send: async () => { sends++; return result; },
  })).rejects.toThrow(/unknown/);
  expect(sends).toBe(1);
});

it("refuses a verdict changed while the durable sending response is in flight", async () => {
  let release!: () => void;
  let entered!: () => void;
  const transitionEntered = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  let current = identity;
  let sends = 0;
  const deferredStore = {
    reserve: store.reserve.bind(store),
    markSending: async (...args: Parameters<typeof store.markSending>) => {
      store.markSending(...args);
      entered();
      await response;
    },
    failBeforeSending: store.failBeforeSending.bind(store),
    markUnknown: store.markUnknown.bind(store),
    succeed: store.succeed.bind(store),
  };
  const pending = executeDurableReviewPost({
    store: deferredStore, identity, payload, repost: false, reauthorize: () => current,
    send: async () => { sends++; return result; },
  });
  const refused = expect(pending).rejects.toBeInstanceOf(ReviewPostNotSentError);
  await transitionEntered;
  current = { ...identity, authorizationDigest: "e".repeat(64) };
  release();
  await refused;
  expect(sends).toBe(0);
  // Sending is durable; no automatic rollback can safely re-arm another caller.
  expect(store.list()[0].state).toBe("sending");
  expect(() => store.reserve(identity, true)).toThrow(/sending/);
});

it("returns the known remote success with an unconfirmed receipt if the local stamp fails", async () => {
  let writes = 0;
  const faulty = new ReviewPostJournal(root, "s", (file, value) => {
    if (++writes >= 3) throw new Error("disk full");
    writeJsonAtomic(file, value);
  });
  const posted = await executeDurableReviewPost({
    store: faulty, identity, payload, repost: false, reauthorize: () => identity, send: async () => result,
  });
  expect(posted.result).toEqual(result);
  expect(posted.receipt).toBe("unconfirmed");
  expect(store.list()[0].state).toBe("sending");
  expect(() => store.reserve(identity, true)).toThrow(/sending/);
});

it("does not publish a caller's payload mutation during an awaited gate", async () => {
  const mutable = { ...payload };
  let sentBody = "";
  await executeDurableReviewPost({
    store, identity, payload: mutable, repost: false,
    reauthorize: async () => { mutable.body = "Never authorized"; return identity; },
    send: async (_target, frozen) => { sentBody = frozen.body; return result; },
  });
  expect(sentBody).toMatch(/^Reviewed\n\n<!-- deepPairing-review-operation:[0-9a-f-]+ -->$/);
});

it("invalid success response remains unknown and is never reported as a posted review", async () => {
  await expect(executeDurableReviewPost({
    store, identity, payload, repost: false, reauthorize: () => identity,
    send: async () => ({ ...result, id: 0 }),
  })).rejects.toBeInstanceOf(ReviewPostUnknownError);
  expect(store.list()[0].state).toBe("unknown");
});
