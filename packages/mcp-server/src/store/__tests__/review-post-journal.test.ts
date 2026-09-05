import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../atomic-write.js";
import {
  canonicalReviewTarget, reviewPostDigest, ReviewPostJournal,
  type ReviewPostIdentity,
} from "../review-post-journal.js";

let root: string;
const sid = "posting-test";
const target = "https://github.com/acme/widget/pull/12";
const identity: ReviewPostIdentity = {
  target, event: "COMMENT", payloadDigest: "a".repeat(64), authorizationDigest: "b".repeat(64),
};
const result = { id: 7, htmlUrl: `${target}#pullrequestreview-7`, state: "COMMENTED" as const };
const journal = () => new ReviewPostJournal(root, sid);
function worker(mode = "reserve"): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/review-post-worker.ts", import.meta.url));
  return fork(fixture, [root, sid, mode], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
}
function receive(child: ChildProcess): Promise<{ type: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Review-post worker did not answer")), 25_000);
    const onMessage = (value: unknown) => finish(undefined, value as { type: string; reason?: string });
    const onError = (err: Error) => finish(err);
    const onExit = () => finish(new Error("Review-post worker exited before answering"));
    const finish = (err?: Error, value?: { type: string; reason?: string }) => {
      clearTimeout(timer);
      child.off("message", onMessage); child.off("error", onError); child.off("exit", onExit);
      if (err) reject(err); else resolve(value!);
    };
    child.once("message", onMessage); child.once("error", onError); child.once("exit", onExit);
  });
}
function stopWorker(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", () => resolve()); child.kill("SIGKILL");
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-post-journal-"));
  fs.mkdirSync(path.join(root, ".deeppairing", "sessions", sid), { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("durable review-post journal", () => {
  it("canonicalizes identity without resolving bare refs or foreign hosts", () => {
    expect(canonicalReviewTarget("https://github.com/Acme/Widget/pull/12")).toBe(target);
    expect(canonicalReviewTarget("12")).toBeNull();
    expect(canonicalReviewTarget("https://github.example.com/acme/widget/pull/12")).toBeNull();
    expect(() => journal().reserve({ ...identity, target: "https://github.com/ACME/widget/pull/12" })).toThrow();
    expect(reviewPostDigest({ a: 1, b: 2 })).toBe(reviewPostDigest({ b: 2, a: 1 }));
    expect(reviewPostDigest([1, 2])).not.toBe(reviewPostDigest([2, 1]));
  });

  it("reserves once across independent readers and blocks different payload/event/SHA even with repost", () => {
    journal().reserve(identity);
    expect(() => journal().reserve(identity)).toThrow(/reserved/);
    expect(() => journal().reserve({ ...identity, event: "APPROVE", reviewedHeadSha: "c".repeat(40), payloadDigest: "d".repeat(64) }, true)).toThrow(/reserved/);
    expect(() => journal().reserve({ ...identity, target: target.replace("12", "13") })).not.toThrow();
  });

  it("refuses unknown-head approvals at the journal boundary", () => {
    expect(() => journal().reserve({ ...identity, event: "APPROVE" })).toThrow();
    expect(journal().list()).toEqual([]);
  });

  it("keeps success duplicate-blocking across restart without a legacy mirror", () => {
    const lease = journal().reserve(identity);
    journal().markSending(lease, identity);
    journal().succeed(lease, result);
    expect(journal().list()[0].result).toEqual(result);
    expect(() => journal().reserve(identity)).toThrow(/already posted/);
    expect(() => journal().reserve(identity, true)).not.toThrow();
  });

  it("fences retries and changed payloads before entering sending", () => {
    const lease = journal().reserve(identity);
    expect(() => journal().markSending({ ...lease, token: "wrong" }, identity)).toThrow(/another caller/);
    expect(() => journal().markSending(lease, { ...identity, payloadDigest: "d".repeat(64) })).toThrow(/changed/);
    expect(journal().list()[0].state).toBe("reserved");
    journal().markSending(lease, identity);
    expect(() => journal().markSending(lease, identity)).toThrow(/already have been sent/);
  });

  it("allows known-not-sent failure but never changes sending/unknown into a retryable failure", () => {
    const cancelled = journal().reserve(identity);
    journal().failBeforeSending(cancelled);
    expect(() => journal().markSending(cancelled, identity)).toThrow();
    const sent = journal().reserve(identity);
    journal().markSending(sent, identity);
    expect(() => journal().failBeforeSending(sent)).toThrow(/possibly sent/);
    journal().markUnknown(sent);
    expect(() => journal().failBeforeSending(sent)).toThrow(/possibly sent/);
    expect(() => journal().reserve(identity, true)).toThrow(/unknown/);
  });

  it("treats process death after sending as unresolved even without an unknown stamp", () => {
    const lease = journal().reserve(identity);
    journal().markSending(lease, identity);
    expect(() => journal().reserve(identity, true)).toThrow(/sending/);
  });

  it("a failed success stamp leaves sending durable and never rearms a POST", () => {
    let writes = 0;
    const faulty = new ReviewPostJournal(root, sid, (filePath, value) => {
      if (++writes === 3) throw new Error("disk full");
      writeJsonAtomic(filePath, value);
    });
    const lease = faulty.reserve(identity);
    faulty.markSending(lease, identity);
    expect(() => faulty.succeed(lease, result)).toThrow("disk full");
    expect(journal().list()[0].state).toBe("sending");
    expect(() => journal().reserve(identity, true)).toThrow(/sending/);
    expect(fs.existsSync(journal().claimPath)).toBe(false);
  });

  it("explicit cancellation fences a lost reservation token without cancelling possible sends", () => {
    const lease = journal().reserve(identity);
    journal().cancelReserved(lease.operationId);
    expect(() => journal().markSending(lease, identity)).toThrow();
    const next = journal().reserve(identity);
    journal().markSending(next, identity);
    expect(() => journal().cancelReserved(next.operationId)).toThrow(/possibly sent/);
  });

  it("reconciliation checks the target, event, and reviewed commit without needing a crashed caller's token", () => {
    const approval = { ...identity, event: "APPROVE" as const, reviewedHeadSha: "c".repeat(40) };
    const lease = journal().reserve(approval);
    journal().markSending(lease, approval);
    const approved = { ...result, state: "APPROVED" as const, commitId: approval.reviewedHeadSha };
    expect(() => journal().reconcileSucceeded(lease.operationId, approval, { ...approved, commitId: "d".repeat(40) })).toThrow();
    expect(() => journal().reconcileSucceeded(lease.operationId, identity, approved)).toThrow();
    journal().reconcileSucceeded(lease.operationId, approval, approved);
    expect(journal().list()[0].state).toBe("succeeded");
  });

  it("validates remote success identity; malformed response leaves a possibly sent operation", () => {
    const lease = journal().reserve(identity);
    journal().markSending(lease, identity);
    expect(() => journal().succeed(lease, { ...result, id: 0 })).toThrow();
    expect(() => journal().succeed(lease, { ...result, htmlUrl: "https://evil.example/review" })).toThrow();
    expect(() => journal().succeed(lease, { ...result, state: "APPROVED" })).toThrow();
    expect(journal().list()[0].state).toBe("sending");
    journal().markUnknown(lease);
    journal().succeed(lease, result);
    journal().succeed(lease, result); // safe idempotent completion, not another POST
    expect(() => journal().succeed(lease, { ...result, id: 8, htmlUrl: `${target}#pullrequestreview-8` })).toThrow();
  });

  it.each(["{broken", "[]", "{}", '{"version":1,"operations":[null]}'])("fails closed on invalid journal bytes %s", raw => {
    fs.writeFileSync(journal().journalPath, raw);
    expect(() => journal().reserve(identity, true)).toThrow(/invalid/);
    expect(fs.readFileSync(journal().journalPath, "utf8")).toBe(raw);
    expect(fs.existsSync(journal().claimPath)).toBe(false);
  });

  it("detects deletion of an adopted journal instead of treating it as a never-posted session", () => {
    journal().reserve(identity);
    fs.unlinkSync(journal().journalPath);
    expect(() => journal().reserve(identity, true)).toThrow(/invalid/);
  });

  it("refuses corrupt legacy history even when explicitly reposting", () => {
    const legacy = path.join(path.dirname(journal().journalPath), "posted-reviews.json");
    fs.writeFileSync(legacy, '[{"pr":"12","prNumber":13}]');
    expect(() => journal().reserve(identity, true)).toThrow(/history/);
    expect(fs.existsSync(journal().journalPath)).toBe(false);
  });

  it("honors valid legacy duplicate history and canonical case", () => {
    const legacy = path.join(path.dirname(journal().journalPath), "posted-reviews.json");
    fs.writeFileSync(legacy, JSON.stringify([{
      pr: "12", prNumber: 12, owner: "ACME", repo: "WIDGET", event: "COMMENT",
      reviewId: 3, url: `${target}#pullrequestreview-3`, postedAt: new Date().toISOString(), commentCount: 0,
    }]));
    expect(() => journal().reserve(identity)).toThrow(/already posted/);
    expect(() => journal().reserve(identity, true)).not.toThrow();
  });

  it("does not steal an old/dead-looking claim or delete its contents", () => {
    const lock = journal().claimPath;
    fs.writeFileSync(lock, "dead owner from another PID namespace");
    fs.utimesSync(lock, new Date(0), new Date(0));
    expect(() => journal().reserve(identity)).toThrow(/locked/);
    expect(fs.readFileSync(lock, "utf8")).toBe("dead owner from another PID namespace");
    expect(fs.existsSync(journal().journalPath)).toBe(false);
  });

  it("rejects path traversal without making session directories", () => {
    expect(() => new ReviewPostJournal(root, "../outside")).toThrow(/Invalid session/);
    expect(() => new ReviewPostJournal(root, "")).toThrow(/Invalid session/);
    expect(() => new ReviewPostJournal(root, "missing").reserve(identity)).toThrow();
    expect(fs.existsSync(path.join(root, ".deeppairing", "sessions", "missing"))).toBe(false);
  });

  it("two real processes racing reserve produce only one durable operation", async () => {
    const children = [worker(), worker()];
    try {
      await Promise.all(children.map(receive)); // both have imported, barrier is ready
      const outcomes = children.map(receive);
      children.forEach(child => child.send(identity));
      const results = await Promise.all(outcomes);
      expect(results.filter(r => r.type === "reserved")).toHaveLength(1);
      expect(results.filter(r => r.type === "refused")).toHaveLength(1);
      expect(journal().list()).toHaveLength(1);
    } finally {
      await Promise.all(children.map(stopWorker));
    }
  }, 60_000);

  it("a real process killed inside the critical section leaves a non-stealable claim", async () => {
    const child = worker("hold");
    try {
      expect((await receive(child)).type).toBe("ready");
      const claimed = receive(child);
      child.send(identity);
      expect((await claimed).type).toBe("claimed");
      await stopWorker(child);
      expect(fs.existsSync(journal().claimPath)).toBe(true);
      expect(() => journal().reserve(identity, true)).toThrow(/locked/);
    } finally { await stopWorker(child); }
  }, 60_000);
});
