/**
 * #344 — pre-send classification. A LIVE coordinator that holds the exact lease
 * and provably never invoked `send` must be able to release its own attempt,
 * even after the durable `sending` transition. Everything else — a crash, a
 * replay, a wrong lease, a generic operator cancellation, or any invocation of
 * `send` — must stay blocking until reconciliation or explicit operator action.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withSessionFlushLock } from "../../store/session-records.js";
import {
  ReviewPostJournal, ReviewPostJournalError, reviewPostDigest, type ReviewPostIdentity,
} from "../../store/review-post-journal.js";
import type { DurableReviewPostStore } from "../durable-review-post.js";
import { executeDurableReviewPost, ReviewPostNotSentError, ReviewPostUnknownError } from "../durable-review-post.js";

const target = "https://github.com/acme/widget/pull/12";
const payload = { body: "Reviewed", event: "COMMENT" as const, comments: [] };
const identity: ReviewPostIdentity = {
  target, event: "COMMENT", payloadDigest: reviewPostDigest(payload), authorizationDigest: "b".repeat(64),
};
const result = { id: 7, htmlUrl: `${target}#pullrequestreview-7`, state: "COMMENTED" as const };

let fx: GlobalStoreFixture;
let sessionDir: string;
let journal: ReviewPostJournal;

beforeEach(() => {
  fx = withGlobalStore("dp-unsent-");
  sessionDir = path.join(fx.dir, ".deeppairing", "sessions", "s");
  fs.mkdirSync(sessionDir, { recursive: true });
  journal = new ReviewPostJournal(fx.dir, "s");
});
afterEach(() => { fx.dispose(); });

/** Astra's independently executed reproduction, as a regression test. */
it("a real held flush lock during the sending transition releases the unsent attempt", async () => {
  const store = fx.track(new FileStore(fx.dir, "s"));
  let sends = 0;
  let reads = 0;
  const error = await executeDurableReviewPost({
    store: journal, identity, payload, repost: false,
    reauthorize: () => {
      reads++;
      // Only the SECOND read — the one after the durable sending transition —
      // meets a lock a cooperating writer is holding.
      if (reads < 2) return identity;
      return withSessionFlushLock(path.join(sessionDir, ".flush.lock"), () => {
        store.getReviewPostState();
        return identity;
      });
    },
    send: async () => { sends++; return result; },
  }).then(() => null, (err: unknown) => err);

  expect(error).toBeInstanceOf(ReviewPostNotSentError);
  expect((error as ReviewPostNotSentError).reservationReleased).toBe(true);
  expect((error as { cause?: { code?: string } }).cause?.code).toBe("ELOCKED");
  expect(reads).toBe(2);
  expect(sends).toBe(0);
  // Durable outcome: definitely unsent, with provenance an operator can read.
  const [operation] = new ReviewPostJournal(fx.dir, "s").list();
  expect(operation).toMatchObject({ state: "failed", unsentRelease: { priorState: "sending" } });
  expect(operation!.result).toBeUndefined();
  // No test-owned lock is left behind for the next writer.
  expect(fs.existsSync(path.join(sessionDir, ".flush.lock"))).toBe(false);
  expect(fs.existsSync(journal.claimPath)).toBe(false);
});

it("retry after a released pre-send failure needs no repost and sends exactly once", async () => {
  let sends = 0;
  let reads = 0;
  // Authorization is withdrawn while the durable sending transition is in
  // flight — the window that used to strand the attempt in `sending`.
  await expect(executeDurableReviewPost({
    store: journal, identity, payload, repost: false,
    reauthorize: () => ++reads < 2 ? identity : { ...identity, authorizationDigest: "c".repeat(64) },
    send: async () => { sends++; return result; },
  })).rejects.toBeInstanceOf(ReviewPostNotSentError);
  expect(journal.list()).toMatchObject([{ state: "failed", unsentRelease: { priorState: "sending" } }]);
  // A fresh process re-reads the same durable journal and is not blocked, and
  // needs no repost authorization: nothing was ever posted to that PR.
  await expect(executeDurableReviewPost({
    store: new ReviewPostJournal(fx.dir, "s"), identity, payload, repost: false,
    reauthorize: () => identity, send: async () => { sends++; return result; },
  })).resolves.toMatchObject({ receipt: "recorded", result });
  expect(sends).toBe(1);
  expect(journal.list().map(op => op.state)).toEqual(["failed", "succeeded"]);
});

it("an ambiguous markSending response releases only the exact leased attempt", async () => {
  let sends = 0;
  const ambiguous: DurableReviewPostStore = {
    ...bind(journal),
    // The durable write lands; the caller never learns that (a dropped daemon
    // response). It still knows it never invoked send.
    markSending: (lease, id) => { journal.markSending(lease, id); throw new Error("daemon response lost"); },
  };
  await expect(executeDurableReviewPost({
    store: ambiguous, identity, payload, repost: false, reauthorize: () => identity,
    send: async () => { sends++; return result; },
  })).rejects.toBeInstanceOf(ReviewPostNotSentError);
  expect(sends).toBe(0);
  expect(journal.list()).toMatchObject([{ state: "failed", unsentRelease: { priorState: "sending" } }]);
});

it("a markSending that never persisted releases the still-reserved attempt", async () => {
  let sends = 0;
  const busy: DurableReviewPostStore = {
    ...bind(journal),
    // A contended journal claim: the transition threw without ever committing,
    // so the operation is still `reserved` and no POST was invoked.
    markSending: () => { throw new ReviewPostJournalError("busy", "Review-post state is locked"); },
  };
  await expect(executeDurableReviewPost({
    store: busy, identity, payload, repost: false, reauthorize: () => identity,
    send: async () => { sends++; return result; },
  })).rejects.toBeInstanceOf(ReviewPostNotSentError);
  expect(sends).toBe(0);
  expect(journal.list()).toMatchObject([{ state: "failed", unsentRelease: { priorState: "reserved" } }]);
});

it("a corrupt journal in the pre-send window stays blocking and is never rewritten", async () => {
  let sends = 0;
  let reads = 0;
  const corrupt = '{"version":1,"operations":';
  const error = await executeDurableReviewPost({
    store: journal, identity, payload, repost: false,
    reauthorize: () => {
      if (++reads >= 2) { fs.writeFileSync(journal.journalPath, corrupt); throw new Error("authorization unreadable"); }
      return identity;
    },
    send: async () => { sends++; return result; },
  }).then(() => null, (err: unknown) => err);

  expect(error).toBeInstanceOf(ReviewPostNotSentError);
  // Fail-closed: the coordinator could not durably record the release.
  expect((error as ReviewPostNotSentError).reservationReleased).toBe(false);
  expect(sends).toBe(0);
  expect(fs.readFileSync(journal.journalPath, "utf8")).toBe(corrupt);
  expect(() => journal.reserve(identity, true)).toThrow(ReviewPostJournalError);
  expect(fs.existsSync(journal.claimPath)).toBe(false);
});

it("any invocation of send routes to unknown, never to the unsent release", async () => {
  const released = vi.fn();
  const store: DurableReviewPostStore = { ...bind(journal), releaseUnsent: released };
  for (const send of [
    async () => { throw new Error("timeout after the request left"); },
    async () => ({ ...result, id: 0 }), // malformed response
  ]) {
    const fresh = new ReviewPostJournal(fx.dir, "s");
    await expect(executeDurableReviewPost({
      store: { ...store, ...bind(fresh), releaseUnsent: released }, identity, payload,
      repost: true, reauthorize: () => identity, send,
    })).rejects.toBeInstanceOf(ReviewPostUnknownError);
    expect(fresh.list().at(-1)!.state).toBe("unknown");
    expect(released).not.toHaveBeenCalled();
    // Uncertainty keeps blocking; only an operator acknowledgement clears it.
    expect(() => fresh.reserve(identity, true)).toThrow(/unknown/);
    fresh.acknowledgeUnknown(fresh.list().at(-1)!.id,
      reviewPostDigest(fresh.list().at(-1)!), true, true);
  }
});

it("a wrong, forged, or replayed lease cannot release an attempt", () => {
  const lease = journal.reserve(identity, false);
  journal.markSending(lease, identity);
  for (const forged of [{ ...lease, token: crypto.randomUUID() },
    { operationId: crypto.randomUUID(), token: lease.token }]) {
    expect(() => journal.releaseUnsent(forged)).toThrow(ReviewPostJournalError);
  }
  expect(journal.list()[0]!.state).toBe("sending");
  journal.releaseUnsent(lease);
  expect(journal.list()[0]).toMatchObject({ state: "failed", unsentRelease: { priorState: "sending" } });
  // Replay of the same transition, and any resurrection of the released attempt.
  expect(() => journal.releaseUnsent(lease)).toThrow(/unsent/i);
  expect(() => journal.markSending(lease, identity)).toThrow(ReviewPostJournalError);
  expect(() => journal.markUnknown(lease)).toThrow(ReviewPostJournalError);
  expect(() => journal.succeed(lease, result)).toThrow(ReviewPostJournalError);
  expect(journal.list()[0]).toMatchObject({ state: "failed" });
});

it("a crash after the sending transition is not releasable and stays blocking", () => {
  journal.markSending(journal.reserve(identity, false), identity); // lease is lost with the process
  const restarted = new ReviewPostJournal(fx.dir, "s");
  const [operation] = restarted.list();
  expect(operation).toMatchObject({ state: "sending" });
  expect(operation!.unsentRelease).toBeUndefined();
  // Neither a fresh post nor the operator cancel door may reclassify it.
  expect(() => restarted.reserve(identity, true)).toThrow(/sending/);
  expect(() => restarted.cancelReserved(operation!.id)).toThrow(/possibly sent/);
  restarted.acknowledgeUnknown(operation!.id, reviewPostDigest(operation!), true, true);
  expect(restarted.list()[0]).toMatchObject({ state: "abandoned" });
});

it("the reserved-only doors keep their existing narrow contract", () => {
  const lease = journal.reserve(identity, false);
  journal.failBeforeSending(lease); // still the strict pre-transition door
  expect(journal.list()[0]!.unsentRelease).toBeUndefined();
  const second = journal.reserve(identity, true);
  journal.markSending(second, identity);
  expect(() => journal.failBeforeSending(second)).toThrow(/possibly sent/);
  expect(journal.list()[1]!.state).toBe("sending");
});

it("refuses an incomplete durable store before reserving anything", async () => {
  // The failure paths are best-effort, so a missing method would otherwise be
  // swallowed and silently disable a door — the drift that let two obsolete
  // expectations keep passing behind incomplete fakes (#344 review).
  for (const missing of ["reserve", "markSending", "failBeforeSending", "releaseUnsent",
    "markUnknown", "succeed"] as const) {
    let sends = 0;
    const partial = { ...bind(journal) };
    delete (partial as Record<string, unknown>)[missing];
    await expect(executeDurableReviewPost({
      store: partial as DurableReviewPostStore, identity, payload, repost: false,
      reauthorize: () => identity, send: async () => { sends++; return result; },
    })).rejects.toThrow(new RegExp(`missing ${missing}\\(\\)`));
    expect(sends).toBe(0);
    // Nothing was reserved, so no operation is left needing recovery.
    expect(journal.list()).toEqual([]);
  }
});

function bind(target: ReviewPostJournal): DurableReviewPostStore {
  return {
    reserve: target.reserve.bind(target), markSending: target.markSending.bind(target),
    failBeforeSending: target.failBeforeSending.bind(target), releaseUnsent: target.releaseUnsent.bind(target),
    markUnknown: target.markUnknown.bind(target), succeed: target.succeed.bind(target),
  };
}
