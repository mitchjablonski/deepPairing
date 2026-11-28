/**
 * #679/#680 — `deeppairing present page` through the authenticated daemon
 * route: the same presentPage() handler as MCP (gate, contained file read),
 * request-ID receipts, the measured body cap, and the file watch.
 *
 * Fakes, not mocks: the real createDaemon factory and routes, a real FileStore
 * on a temp project, real files and symlinks, and a fake directory watcher the
 * test fires (the factory's `pageWatch` seam).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PAGE_HTML_MAX_BYTES, readFileWatch } from "@deeppairing/shared";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";
import { STANDALONE_PAGE_MAX_BODY_BYTES } from "../../http/guards.js";
import { projectHashOf } from "../../project-root.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { FileStore } from "../../store/file-store.js";
import { reviseStandalonePage } from "../standalone-revise-page.js";
import { provePageRevisionFeedback } from "../../store/page-revision-feedback.js";
import { deriveCommentState } from "../../../web/src/lib/pageReviewQueue.js";

const b64 = (html: string | Buffer) => Buffer.from(html).toString("base64");
const page = (html: string, extra: Record<string, unknown> = {}) => ({ title: "Replay backend", htmlBase64: b64(html), ...extra });
const anchored = { htmlAnchor: { kind: "element" as const, locator: "p", quote: "First draft" } };

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fixture() {
  const fx = withGlobalStore("dp-cli-page-");
  const root = fx.dir;
  const sessionId = createStandaloneSessionId(root);
  const daemons: Daemon[] = [];
  const watchers: Array<{ dir: string; fire: (name: string) => void; closed: boolean }> = [];
  const start = () => {
    const daemon = createDaemon({
      projectRoot: root, authToken: "test-token", log: () => {},
      exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
      pageWatch: {
        watch: (dir, listener) => {
          const w = { dir, closed: false, fire: (name: string) => { if (!w.closed) listener("change", name); } };
          watchers.push(w);
          return { close: () => { w.closed = true; } };
        },
        pollIntervalMs: 0, quietMs: 20, minIntervalMs: 0,
      },
    });
    daemons.push(daemon);
    return daemon;
  };
  const request = (daemon: Daemon, route: string, body: object, opts: { authenticated?: boolean; session?: string; raw?: string } = {}) =>
    daemon.app.request(`http://localhost/api/internal/sessions/${opts.session ?? sessionId}/${route}`, {
      method: "POST",
      headers: {
        Host: "localhost", "Content-Type": "application/json", "X-Project-Hash": projectHashOf(root),
        ...(opts.authenticated === false ? {} : { Authorization: "Bearer test-token" }),
      },
      body: opts.raw ?? JSON.stringify({ expectedProjectRoot: root, ...body }),
    });
  const open = async (daemon: Daemon, session = sessionId) =>
    expect((await request(daemon, "open-review", { mode: "open" }, { session })).status).toBe(200);
  const present = (daemon: Daemon, operationId: string, args: object, session = sessionId) =>
    request(daemon, "present-page", { operationId, args }, { session });
  const revise = (daemon: Daemon, operationId: string, artifactId: string, html: string,
    reason = "Clarify the procedure", ackCommentIds?: string[]) =>
    request(daemon, "revise-page", { operationId, artifactId, htmlBase64: b64(html), reason, ackCommentIds });
  const verdict = (daemon: Daemon, artifactId: string, status: string, feedback = "Stale feedback") =>
    daemon.app.request(`http://localhost/api/artifacts/${artifactId}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Project-Hash": projectHashOf(root), "X-Session-Id": sessionId,
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ status, feedback, concept: "Stale concept" }),
    });
  return {
    root, sessionId, watchers, start, request, open, present, revise, verdict,
    dispose: () => {
      for (const daemon of daemons) {
        for (const store of daemon.sessions.values()) store.dispose();
        daemon.dispose();
      }
      fx.dispose();
    },
  };
}

describe("standalone page verdict and notes", () => {
  it("keeps equal-text notes distinct and restores the exact verdict reason after restart", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const artifactId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const reason = "Clarify this ordering";
      store.addComment({ id: "cmt_ordinary", artifactId, author: "human", content: reason });
      expect((await f.verdict(daemon, artifactId, "revised", reason)).status).toBe(200);
      const read = (active: Daemon) => f.request(active, "read-page-feedback", { artifactId });
      const first = await (await read(daemon)).json();
      expect(first).toMatchObject({
        artifact: { id: artifactId, status: "revised" },
        verdict: { status: "revised", at: expect.any(String), commentId: expect.any(String), reason },
        notes: [{ id: "cmt_ordinary", content: reason }], comments: [], omittedNotes: 0, omittedComments: 0,
      });
      expect(first.verdict.commentId).not.toBe("cmt_ordinary");
      expect(store.getComment(first.verdict.commentId)?.verdictFeedback).toBe(true);
      expect(store.getUnacknowledgedComments()).toHaveLength(2);
      store.dispose();
      daemon.dispose();

      const restarted = f.start();
      expect((await f.request(restarted, "open-review", { mode: "resume" })).status).toBe(200);
      expect(await (await read(restarted)).json()).toEqual(first);
      expect(await (await read(restarted)).json()).toEqual(first);

      // A later action with no owned pointer must not reuse an older reason.
      const reloaded = restarted.sessions.get(f.sessionId)!;
      const other = await (await f.present(restarted, randomUUID(), page("<p>Other page</p>"))).json();
      reloaded.addComment({ id: "cmt_other_page", artifactId: other.structuredContent.artifactId, author: "human", content: "Other reason" });
      for (const feedbackCommentId of ["cmt_missing", "cmt_other_page", undefined]) {
        reloaded.updateArtifactStatus(artifactId, "revised", "ui_revise_button", { feedbackCommentId });
        const unattributed = await (await read(restarted)).json();
        expect(unattributed.verdict).toEqual({ status: "revised", at: expect.any(String) });
        expect(unattributed.notes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "cmt_ordinary", content: reason })]));
        expect(unattributed.notes).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "cmt_other_page" })]));
      }
      reloaded.updateArtifactStatus(artifactId, "approved", "unspecified");
      expect(await (await read(restarted)).json()).not.toHaveProperty("verdict");
    } finally {
      f.dispose();
    }
  });

  it("reserves an unfilled verdict ID after restart and leaves an unmarked legacy note unattributed", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const artifactId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const staleWriter = new FileStore(f.root, f.sessionId);
      const id = "cmt_dangling_verdict";
      const ordinary = { id, artifactId, author: "human" as const, content: "Ordinary feedback" };
      try {
        store.updateArtifactStatus(artifactId, "revised", "ui_revise_button", { feedbackCommentId: id });
        store.forceFlush();
        store.dispose();
        daemon.dispose();
        const resumed = f.start();
        expect((await f.request(resumed, "open-review", { mode: "resume" })).status).toBe(200);

        const refused = await f.request(resumed, "comments", ordinary);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ code: "validation_error" });
        const resumedStore = resumed.sessions.get(f.sessionId)!;
        expect(resumedStore.getComment(id)).toBeUndefined();
        const dangling = await (await f.request(resumed, "read-page-feedback", { artifactId })).json();
        expect(dangling.verdict).toEqual({ status: "revised", at: expect.any(String) });

        // The old store has no reservation in its view. Its ordinary note
        // stays readable, without filling the newer store's verdict link.
        expect(staleWriter.addComment(ordinary).verdictFeedback).toBeUndefined();
        staleWriter.forceFlush();
        resumedStore.dispose();
        resumed.dispose();
        const reloaded = f.start();
        expect((await f.request(reloaded, "open-review", { mode: "resume" })).status).toBe(200);
        const read = await (await f.request(reloaded, "read-page-feedback", { artifactId })).json();
        expect(read.verdict).toEqual(dangling.verdict);
        expect(read.notes).toMatchObject([{ id, content: ordinary.content }]);
      } finally {
        staleWriter.dispose();
      }
    } finally {
      f.dispose();
    }
  });

  it("keeps a conflicted verdict note unattributed after the daemon reloads", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const artifactId = source.structuredContent.artifactId as string;
      const writer = new FileStore(f.root, f.sessionId);
      try {
        const changed = writer.getArtifacts().find((a) => a.id === artifactId)!;
        changed.content = { ...changed.content, html: "<p>Changed elsewhere</p>" };
        writer.renameArtifact(artifactId, changed.title);
        writer.forceFlush();
      } finally {
        writer.dispose();
      }
      const reason = "This text belongs to the old draft.";
      const verdict = await f.verdict(daemon, artifactId, "revised", reason);
      expect(verdict.status).toBe(409);
      expect(await verdict.json()).toMatchObject({ code: "session_review_conflict" });
      daemon.sessions.get(f.sessionId)!.dispose();
      daemon.dispose();
      const restarted = f.start();
      expect((await f.request(restarted, "open-review", { mode: "resume" })).status).toBe(200);
      const result = await (await f.request(restarted, "read-page-feedback", { artifactId })).json();
      expect(result).toMatchObject({ artifact: { status: "draft" }, notes: [{ content: reason }] });
      expect(result).not.toHaveProperty("verdict");
    } finally {
      f.dispose();
    }
  });

  it("bounds both lanes after the verdict and truncates a single oversized reason on a UTF-8 boundary", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const artifactId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      for (let i = 0; i < 52; i++) {
        store.addComment({
          id: `cmt_${i}`, artifactId, author: "human", content: `Note ${i}`,
          ...(i % 2 === 0 ? { target: anchored } : {}),
        });
      }
      expect((await f.verdict(daemon, artifactId, "rejected", "Prefer a simpler approach.")).status).toBe(200);
      const read = () => f.request(daemon, "read-page-feedback", { artifactId });
      const bounded = await (await read()).json();
      expect(bounded.verdict.reason).toBe("Prefer a simpler approach.");
      expect(bounded.notes.length + bounded.comments.length).toBe(49);
      expect(bounded.notes.length + bounded.omittedNotes).toBe(26);
      expect(bounded.comments.length + bounded.omittedComments).toBe(26);
      const oversized = '🙂"\\'.repeat(18_000);
      store.updateArtifactStatus(artifactId, "rejected", "ui_reject_button", { feedbackCommentId: "cmt_oversized_reason" });
      store.addComment({ id: "cmt_oversized_reason", artifactId, author: "human", content: oversized, verdictFeedback: true });
      const raw = await (await read()).text();
      const clipped = JSON.parse(raw);
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(64 * 1024);
      expect(clipped.verdict).toMatchObject({ commentId: "cmt_oversized_reason", reasonTruncated: true });
      expect(oversized.startsWith(clipped.verdict.reason)).toBe(true);
      expect(Buffer.from(clipped.verdict.reason, "utf8").toString("utf8")).toBe(clipped.verdict.reason);
      expect(clipped.omittedComments).toBeGreaterThan(0);
      expect(clipped.omittedNotes).toBeGreaterThan(0);
    } finally {
      f.dispose();
    }
  });
});

describe("authenticated standalone page revision", () => {
  it("advances addressedIn when a later revision re-addresses a reopened thread, never rolling it back", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const first = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const v1 = first.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
      store.addComment({ id: "cmt_root", artifactId: v1, author: "human", content: "Clarify the intro", target: anchored });
      await tick();
      const v2Op = randomUUID();
      const second = await (await f.revise(daemon, v2Op, v1, "<p>Second draft</p>", "Read feedback", ["cmt_root"])).json();
      const v2 = second.structuredContent.artifactId as string;
      const v2Row = store.getArtifacts().find((a) => a.id === v2)!;
      expect(store.getComment("cmt_root")?.addressedIn).toEqual({ artifactId: v2, version: 2, at: v2Row.createdAt });
      await tick();
      store.addComment({
        id: "cmt_reply", artifactId: v2, author: "human", content: "Still unclear", parentCommentId: "cmt_root",
        target: { artifactId: v1 },
      });
      const state = () => deriveCommentState(store.getComment("cmt_root")!, [store.getComment("cmt_reply")!], false);
      expect(state()).toMatchObject({ kind: "open", reopened: true });
      await tick();
      const v3Op = randomUUID();
      const third = await (await f.revise(daemon, v3Op, v2, "<p>Third draft</p>", "Read feedback", ["cmt_root"])).json();
      const v3 = third.structuredContent.artifactId as string;
      const v3Row = store.getArtifacts().find((a) => a.id === v3)!;
      const v3Stamp = { artifactId: v3, version: 3, at: v3Row.createdAt };
      expect(store.getComment("cmt_root")?.addressedIn).toEqual(v3Stamp);
      expect(state()).toEqual({ kind: "addressed", via: "revision", version: 3 });
      const diskStamp = () => JSON.parse(fs.readFileSync(path.join(f.root, ".deeppairing", "sessions", f.sessionId, "comments.json"), "utf8"))
        .find((c: { id: string }) => c.id === "cmt_root").addressedIn;
      expect(diskStamp()).toEqual(v3Stamp);
      // Same-receipt retry is idempotent.
      expect(await (await f.revise(daemon, v3Op, v2, "<p>Third draft</p>", "Read feedback", ["cmt_root"])).json())
        .toMatchObject({ structuredContent: { artifactId: v3, replayed: true } });
      const prove = (parentId: string) => provePageRevisionFeedback(store.getArtifacts(), store.getComments(), f.sessionId, parentId, ["cmt_root"])!;
      store.acknowledgePageRevisionFeedback(v2, prove(v2), () => {});
      expect(store.getComment("cmt_root")?.addressedIn).toEqual(v3Stamp);
      // Replay and recovery of the OLDER v2 receipt never roll the stamp back.
      expect(await (await f.revise(daemon, v2Op, v1, "<p>Second draft</p>", "Read feedback", ["cmt_root"])).json())
        .toMatchObject({ structuredContent: { artifactId: v2, replayed: true } });
      store.acknowledgePageRevisionFeedback(v1, prove(v1), () => {});
      expect(store.getComment("cmt_root")?.addressedIn).toEqual(v3Stamp);
      expect(diskStamp()).toEqual(v3Stamp);
      expect(state()).toEqual({ kind: "addressed", via: "revision", version: 3 });
    } finally {
      f.dispose();
    }
  });

  it("acknowledges only selected ordinary comments from the exact direct lineage", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const first = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const ancestorId = first.structuredContent.artifactId as string;
      const next = await (await f.revise(daemon, randomUUID(), ancestorId, "<p>Second draft</p>")).json();
      const parentId = next.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      store.createArtifact({
        id: "art_sibling", parentId: ancestorId, version: 2, type: "page",
        title: "Sibling", content: { title: "Sibling", html: "<p>Sibling branch</p>" },
      });
      const add = (id: string, artifactId: string, intent?: "comment" | "question" | "suggestion", target: Record<string, unknown> = anchored) =>
        store.addComment({ id, artifactId, author: "human", content: `Private words for ${id}`, target, intent });
      const description = "Redis Streams";
      const reason = "The team cannot operate it.";
      store.recordRejectedApproach({ description, reason, sourceArtifactId: ancestorId, origin: "page_rule_out", sourceAnchor: anchored.htmlAnchor });
      store.addComment({ id: "cmt_old", artifactId: ancestorId, author: "human", content: reason, target: anchored, ruleOut: { description } });
      add("cmt_current", parentId, "comment");
      add("cmt_left_pending", ancestorId);
      add("cmt_sibling", "art_sibling", "question");
      add("cmt_question", parentId, "question");
      add("cmt_suggestion", parentId, "suggestion");
      add("cmt_unanchored", parentId, undefined, {});
      store.addComment({ id: "cmt_agent", artifactId: parentId, author: "agent", content: "Agent", target: anchored });
      const html = "<p>Third draft</p>";
      const revise = (operation: string, ids: string[]) => f.revise(daemon, operation, parentId, html, "Read feedback", ids);
      for (const invalid of ["cmt_sibling", "cmt_question", "cmt_suggestion", "cmt_unanchored", "cmt_agent", "cmt_unknown"]) {
        const refusal = await (await revise(randomUUID(), ["cmt_old", invalid])).json();
        expect(refusal).toMatchObject({
          isError: true, structuredContent: { code: "validation_error" },
        });
        const message = refusal.content[0].text;
        expect(message).toContain(JSON.stringify(invalid));
        expect(message).not.toContain("Private words");
        if (invalid === "cmt_question") expect(message).toContain("Answer it in the revised page");
        else if (invalid === "cmt_suggestion") expect(message).toContain("Use its separate review flow");
        else expect(message).toContain("is ineligible");
        if (invalid === "cmt_sibling") expect(message).not.toContain("is a question");
      }
      expect((await revise(randomUUID(), ["cmt_old", "cmt_old"])).status).toBe(400);
      expect((await revise(randomUUID(), Array.from({ length: 51 }, (_, index) => `cmt_${index}`))).status).toBe(400);
      expect(store.getArtifacts()).toHaveLength(3);
      expect(store.getComment("cmt_old")?.acknowledged).toBe(false);
      expect(await (await f.revise(daemon, randomUUID(), parentId, "<p>Use Redis Streams</p>", "Read feedback", ["cmt_old"])).json())
        .toMatchObject({ isError: true, structuredContent: { code: "rejected_approach_blocked", reason } });
      expect(store.getComment("cmt_old")?.acknowledged).toBe(false);
      const memory = store.getSessionMemory();
      const operation = randomUUID();
      const success = await (await revise(operation, ["cmt_old", "cmt_current"])).json();
      expect(success).toMatchObject({
        structuredContent: {
          acknowledgedCommentIds: ["cmt_current", "cmt_old"], version: 3,
          acknowledgementNote: "Acknowledgement leaves the rule-out status unchanged.",
        },
      });
      // A replay returns the stored receipt; lint warnings ride only the fresh result (#714 gap 6).
      const { warnings: _freshWarnings, ...stored } = success.structuredContent;
      const replayed = await (await revise(operation, ["cmt_current", "cmt_old"])).json();
      expect(replayed).toMatchObject({ structuredContent: { ...stored, replayed: true } });
      expect(replayed.structuredContent.warnings).toBeUndefined();
      expect(await (await revise(operation, ["cmt_old"])).json()).toMatchObject({
        isError: true, structuredContent: { code: "standalone_operation_conflict" },
      });
      expect(store.getComments().filter((c) => c.author === "human" && c.acknowledged).map((c) => c.id).sort())
        .toEqual(["cmt_current", "cmt_old"]);
      expect(store.getSessionMemory()).toEqual(memory);
      expect(store.getComment("cmt_old")?.ruleOut).toEqual({ description });
      // #714 gap 7 — each acknowledged comment names the revision that addressed it.
      const revised = store.getArtifacts().find((a) => a.id === success.structuredContent.artifactId)!;
      const addressedIn = { artifactId: revised.id, version: 3, at: revised.createdAt };
      expect(store.getComment("cmt_old")?.addressedIn).toEqual(addressedIn);
      expect(store.getComment("cmt_current")?.addressedIn).toEqual(addressedIn);
      expect(store.getComment("cmt_left_pending")?.addressedIn).toBeUndefined();
      expect(store.getArtifacts()).toHaveLength(4);
      const disk = JSON.parse(fs.readFileSync(path.join(f.root, ".deeppairing", "sessions", f.sessionId, "comments.json"), "utf8"));
      expect(disk).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "cmt_old", acknowledged: true, addressedIn }),
        expect.objectContaining({ id: "cmt_left_pending", acknowledged: false }),
      ]));
    } finally {
      f.dispose();
    }
  });

  it.each(["removed", "duplicated"])("refuses a %s durable ID from a stale warm store without creating a successor", async (change) => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const first = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = first.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const id = "cmt_removed";
      store.addComment({ id, artifactId: parentId, author: "human", content: "Clarify", target: anchored });
      store.forceFlush();
      const file = path.join(f.root, ".deeppairing", "sessions", f.sessionId, "comments.json");
      const disk = JSON.parse(fs.readFileSync(file, "utf8"));
      const modified = JSON.stringify(change === "removed" ? [] : [disk[0], disk[0]]);
      fs.writeFileSync(file, modified);
      // An unrelated dirty row would cause the generic flush to rewrite the
      // collection and collapse the duplicate before it could be diagnosed.
      store.addComment({ id: "cmt_buffered", artifactId: parentId, author: "human", content: "Unrelated", target: anchored });
      expect(store.getComment(id)?.acknowledged).toBe(false);
      const response = await f.revise(daemon, randomUUID(), parentId, "<p>Second draft</p>", "Read feedback", [id]);
      if (change === "removed") {
        expect(await response.json()).toMatchObject({ isError: true, structuredContent: { code: "session_review_conflict" } });
      } else {
        expect(response.status).toBe(500);
        expect(() => store.forceFlush()).toThrow();
      }
      expect(store.getArtifacts()).toMatchObject([{ id: parentId, status: "draft" }]);
      expect(fs.readFileSync(file, "utf8")).toBe(modified);
    } finally {
      f.dispose();
    }
  });

  it("fails closed on missing, cyclical, gapped and foreign lineage", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const first = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = first.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const id = "cmt_lineage";
      store.addComment({ id, artifactId: parentId, author: "human", content: "Clarify", target: anchored });
      const [root] = store.getArtifacts();
      expect(provePageRevisionFeedback([root!], store.getComments(), f.sessionId, parentId, [id])).toBeDefined();
      for (const artifacts of [[{ ...root!, parentId: "missing", version: 2 }],
        [{ ...root!, parentId, version: 2 }], [{ ...root!, version: 2 }],
        [{ ...root!, sessionId: "other" }], [root!, root!]]) {
        expect(provePageRevisionFeedback(artifacts, store.getComments(), f.sessionId, parentId, [id])).toBeUndefined();
      }
    } finally {
      f.dispose();
    }
  });

  it.each(["version", "acknowledgement", "receipt"])("recovers an interruption at %s using the exact original preparation", async (phase) => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const first = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = first.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const commentId = "cmt_ack_recovery";
      store.addComment({ id: commentId, artifactId: parentId, author: "human", content: "Clarify", target: anchored });
      const operation = randomUUID();
      const dir = path.join(f.root, ".deeppairing", "sessions", f.sessionId);
      const receipt = path.join(dir, `revise-page-${operation}.json`);
      const comments = path.join(dir, "comments.json");
      // Newly posted input starts in memory. Verify it is already on disk
      // before the first artifact flush can persist the successor.
      const flush = store.forceFlush.bind(store);
      const failVersion = phase === "version" ? vi.spyOn(store, "forceFlush").mockImplementationOnce((selection) => {
        expect(JSON.parse(fs.readFileSync(comments, "utf8"))).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: commentId, acknowledged: false }),
        ]));
        flush(selection);
        throw new Error("Interrupted after version flush");
      }) : undefined;
      const rename = fs.renameSync.bind(fs);
      const failWrite = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (phase === "acknowledgement" && to === comments &&
          JSON.parse(fs.readFileSync(from, "utf8")).some((row: { id: string; acknowledged: boolean }) => row.id === commentId && row.acknowledged)) {
          throw new Error("Comments write interrupted");
        }
        if (phase === "receipt" && to === receipt && JSON.parse(fs.readFileSync(from, "utf8")).committed) {
          throw new Error("Receipt write interrupted");
        }
        rename(from, to);
      });
      const revise = (active: Daemon) => f.revise(active, operation, parentId, "<p>Second draft</p>", "Read feedback", [commentId]);
      try {
        expect((await revise(daemon)).status).toBe(500);
      } finally {
        failWrite.mockRestore();
        failVersion?.mockRestore();
      }
      const child = store.getArtifacts().find((row) => row.parentId === parentId)!;
      expect(child).toBeDefined();
      expect(JSON.parse(fs.readFileSync(path.join(dir, "artifacts.json"), "utf8"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: child.id, parentId }),
      ]));
      if (phase === "version") expect(store.getPreflightTrace(child.id)).toBeNull();
      else expect(store.getPreflightTrace(child.id)).toMatchObject({ decision: "admitted" });
      expect(store.getCommentsForArtifact(parentId).filter((row) => row.author === "agent")).toHaveLength(phase === "version" ? 0 : 1);
      expect(store.getComment(commentId)?.acknowledged).toBe(phase === "receipt");
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).not.toHaveProperty("committed");
      if (phase === "acknowledgement") {
        const original = fs.readFileSync(comments, "utf8");
        const rows = JSON.parse(original);
        const duplicate = JSON.stringify([...rows, rows.find((row: { id: string }) => row.id === commentId)]);
        fs.writeFileSync(comments, duplicate);
        store.addComment({ id: "cmt_new_buffered", artifactId: parentId, author: "human", content: "Unrelated", target: anchored });
        expect((await revise(daemon)).status).toBe(500);
        expect(() => store.forceFlush()).toThrow();
        expect(fs.readFileSync(comments, "utf8")).toBe(duplicate);
        expect(store.getComment(commentId)?.acknowledged).toBe(false);
        fs.writeFileSync(comments, original);
      }
      store.dispose();
      daemon.dispose();
      const restarted = f.start();
      expect((await f.request(restarted, "open-review", { mode: "resume" })).status).toBe(200);
      expect(await (await revise(restarted)).json()).toMatchObject({
        structuredContent: { artifactId: child.id, acknowledgedCommentIds: [commentId], replayed: true },
      });
      expect(restarted.sessions.get(f.sessionId)?.getComment(commentId)?.acknowledged).toBe(true);
      expect(restarted.sessions.get(f.sessionId)?.getArtifacts()).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });

  it("refuses stale companion verdicts and replays legacy committed pages with a changed parent status", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = source.structuredContent.artifactId as string;
      const operation = randomUUID();
      const html = "<p>Updated draft</p>";
      const revision = await (await f.revise(daemon, operation, parentId, html)).json();
      const successorId = revision.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const memory = store.getSessionMemory();
      for (const status of ["approved", "revised", "rejected", "obsolete"]) {
        const response = await f.verdict(daemon, parentId, status);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "parent_superseded", successorId, successorVersion: 2 });
      }
      expect(store.getSessionMemory()).toEqual(memory);
      expect(store.getCommentsForArtifact(parentId)).toMatchObject([{ author: "agent" }]);
      expect(store.getArtifacts()).toMatchObject([{ id: parentId, status: "superseded" }, { id: successorId, status: "draft" }]);
      expect(() => store.updateArtifactStatus(parentId, "approved", "ui_approve_button")).toThrow("already replaced");

      // Emulate the on-disk status left by an older daemon's stale verdict.
      store.updateArtifactStatus(parentId, "approved");
      store.forceFlush();
      store.dispose();
      daemon.dispose();
      const reopened = f.start();
      expect((await f.request(reopened, "open-review", { mode: "resume" })).status).toBe(200);
      expect(await (await f.revise(reopened, operation, parentId, html)).json()).toMatchObject({
        structuredContent: { artifactId: successorId, parentArtifactId: parentId, replayed: true },
      });
      expect(reopened.sessions.get(f.sessionId)!.getArtifacts()).toMatchObject([
        { id: parentId, status: "approved" }, { id: successorId, status: "draft" },
      ]);
    } finally {
      f.dispose();
    }
  });

  it("refuses a companion reject if the page was revised during its ledger preview", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const memory = store.getSessionMemory();
      const successorId = "art_preview_successor";
      vi.spyOn(store, "previewReviewConflict").mockImplementationOnce(() => {
        // The verdict route awaits its preview. Land the revision before
        // that continuation, using the real guarded artifact writer.
        store.createArtifact({
          id: successorId, parentId, type: "page", version: 2, requireUnsupersededParent: true,
          title: "Updated page", content: { title: "Updated page", html: "<p>Updated draft</p>" },
        });
        store.updateArtifactStatus(parentId, "superseded", "agent_supersede");
        return null;
      });
      const response = await f.verdict(daemon, parentId, "rejected");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "parent_superseded", successorId });
      expect(store.getSessionMemory()).toEqual(memory);
      expect(store.getCommentsForArtifact(parentId)).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it.each([["draft", "revised"], ["approved", "approved"]] as const)(
    "does not complete an interrupted revision from %s over a later %s verdict", async (before, after) => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      if (before === "approved") store.updateArtifactStatus(parentId, before, "ui_approve_button");
      const operation = randomUUID();
      const html = "<p>Updated draft</p>";
      const flush = store.forceFlush.bind(store);
      vi.spyOn(store, "forceFlush").mockImplementationOnce(() => {
        flush();
        throw new Error("Interrupted after version write");
      });
      expect((await f.revise(daemon, operation, parentId, html)).status).toBe(500);
      const dismiss = await f.verdict(daemon, parentId, "obsolete");
      expect(dismiss.status).toBe(409);
      expect(await dismiss.json()).toMatchObject({ code: "parent_superseded", successorVersion: 2 });
      expect(store.getArtifacts()[0]).toMatchObject({ id: parentId, status: "superseded" });
      store.updateArtifactStatus(parentId, after);
      store.forceFlush();
      expect((await f.revise(daemon, operation, parentId, html)).status).toBe(500);
      expect(store.getArtifacts()[0]).toMatchObject({ id: parentId, status: after });
      expect(store.getCommentsForArtifact(parentId)).toHaveLength(0);
      const receipt = path.join(f.root, ".deeppairing", "sessions", f.sessionId, `revise-page-${operation}.json`);
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).not.toHaveProperty("committed");
    } finally {
      f.dispose();
    }
  });

  it("revises one exact inline page under concurrent calls and replays the original operation", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const parentArtifactId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      store.addComment({ id: "cmt_live_feedback", artifactId: parentArtifactId, author: "human", content: "What is the replay procedure?" });
      const first = randomUUID();
      const second = randomUUID();
      const html = "<p>Updated replay procedure</p>";
      const results = await Promise.all([first, second].map(async (id) => (await f.revise(daemon, id, parentArtifactId, html)).json()));
      const winnerIndex = results.findIndex((result) => !result.isError);
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      const winner = results[winnerIndex];
      const operation = [first, second][winnerIndex]!;
      const artifactId = winner.structuredContent.artifactId as string;
      expect(winner.structuredContent).toMatchObject({ parentArtifactId, artifactId, version: 2, status: "draft" });
      const stale = { isError: true, structuredContent: { code: "parent_superseded", currentArtifactId: artifactId, currentVersion: 2 } };
      expect(results[1 - winnerIndex]).toMatchObject(stale);
      expect(await (await f.revise(daemon, randomUUID(), parentArtifactId, html)).json()).toMatchObject(stale);
      expect(await (await f.revise(daemon, operation, parentArtifactId, html)).json()).toMatchObject({
        structuredContent: { artifactId, parentArtifactId, version: 2, replayed: true },
      });
      for (const changed of [[parentArtifactId, "<p>Different input</p>", "Clarify the procedure"],
        [parentArtifactId, html, "Changed reason"], [artifactId, html, "Clarify the procedure"]] as const) {
        expect(await (await f.revise(daemon, operation, ...changed)).json()).toMatchObject({
          isError: true, structuredContent: { code: "standalone_operation_conflict" },
        });
      }
      expect(store.getArtifacts()).toMatchObject([
        { id: parentArtifactId, status: "superseded" }, { id: artifactId, parentId: parentArtifactId, content: { html } },
      ]);
      expect(store.getCommentsForArtifact(parentArtifactId)).toMatchObject([
        { id: "cmt_live_feedback", acknowledged: false },
        { author: "agent", content: `Superseded by ${artifactId}: Clarify the procedure` },
      ]);
      const nextOperation = randomUUID();
      const next = await Promise.all([1, 2].map(async () =>
        (await f.revise(daemon, nextOperation, artifactId, "<p>Final replay procedure</p>")).json()));
      const latest = next[0].structuredContent.artifactId as string;
      expect(next).toMatchObject([
        { structuredContent: { artifactId: latest, version: 3 } },
        { structuredContent: { artifactId: latest, version: 3 } },
      ]);
      expect(next.filter((result) => result.structuredContent.replayed === true)).toHaveLength(1);
      expect(store.getArtifacts()).toHaveLength(3);
      expect(daemon.activeSessions.size).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it.each([0, 1, 2])("recovers interruption at flush phase %s without writing another child or note", async (interruptOn) => {
    const f = fixture();
    try {
      const first = f.start();
      await f.open(first);
      const source = await (await f.present(first, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = source.structuredContent.artifactId as string;
      const store = first.sessions.get(f.sessionId)!;
      const operation = randomUUID();
      const html = "<p>Updated draft</p>";
      const flush = store.forceFlush.bind(store);
      let flushes = 0;
      const interruption = vi.spyOn(store, "forceFlush").mockImplementation(() => {
        if (interruptOn === 0) throw new Error("Artifact write failed");
        flush();
        if (++flushes === interruptOn) throw new Error("Interrupted after durable write");
      });
      try {
        expect((await f.revise(first, operation, parentId, html)).status).toBe(500);
      } finally {
        interruption.mockRestore();
      }
      const receiptFile = path.join(f.root, ".deeppairing", "sessions", f.sessionId, `revise-page-${operation}.json`);
      expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).not.toHaveProperty("committed");
      expect(store.getCommentsForArtifact(parentId)).toHaveLength(interruptOn === 2 ? 1 : 0);
      const childId = store.getArtifacts().find((artifact) => artifact.parentId === parentId)?.id;
      expect(childId).toBeTruthy();
      store.dispose();
      first.dispose();

      const restarted = f.start();
      expect((await f.revise(restarted, operation, parentId, html)).status).toBe(404);
      expect((await f.request(restarted, "open-review", { mode: "resume" })).status).toBe(200);
      const replay = await (await f.revise(restarted, operation, parentId, html)).json();
      expect(replay).toMatchObject({ structuredContent: { artifactId: childId, parentArtifactId: parentId, version: 2 } });
      expect(replay.structuredContent.replayed).toBe(interruptOn === 0 ? undefined : true);
      expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toMatchObject({ committed: true });
      const reopened = restarted.sessions.get(f.sessionId)!;
      expect(reopened.getArtifacts()).toHaveLength(2);
      expect(reopened.getCommentsForArtifact(parentId)).toMatchObject([{ content: `Superseded by ${childId}: Clarify the procedure` }]);
    } finally {
      f.dispose();
    }
  });

  it("applies the shared rejection gate and rejects file-backed parents", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>Use an existing file</p>"))).json();
      fs.writeFileSync(path.join(f.root, "watched.html"), "<p>File backed</p>");
      const watched = await (await f.present(daemon, randomUUID(), { path: "watched.html", title: "Watched" })).json();
      const store = daemon.sessions.get(f.sessionId)!;
      const reason = "No team to maintain this queue.";
      store.recordRejectedApproach({ description: "Redis Streams", concept: "Redis Streams", reason });
      const result = await (await f.revise(daemon, randomUUID(), source.structuredContent.artifactId, "<p>Use Redis Streams for replay.</p>")).json();
      expect(result).toMatchObject({ isError: true, structuredContent: { code: "rejected_approach_blocked", reason } });
      const fileRefusal = await (await f.revise(daemon, randomUUID(), watched.structuredContent.artifactId, "<p>Changed</p>")).json();
      expect(fileRefusal.content[0].text).toContain("save changes to its source file");
      expect(store.getArtifacts()).toHaveLength(2);
      expect(store.getComments()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it("requires the bearer and refuses oversized or non-UTF-8 inline bytes", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const artifactId = source.structuredContent.artifactId as string;
      const body = { artifactId, operationId: randomUUID(), reason: "Clarify", htmlBase64: b64("<p>Updated</p>") };
      expect((await f.request(daemon, "revise-page", body, { authenticated: false })).status).toBe(401);
      expect((await f.request(daemon, "revise-page", { ...body, expectedProjectRoot: path.dirname(f.root) })).status).toBe(403);
      expect((await f.request(daemon, "revise-page", { ...body, htmlBase64: b64(Buffer.from([0xff])) })).status).toBe(400);
      const oversized = "<p>" + "x".repeat(PAGE_HTML_MAX_BYTES - 6) + "</p>";
      expect((await f.revise(daemon, body.operationId, artifactId, oversized)).status).toBe(413);
      expect(daemon.sessions.get(f.sessionId)!.getArtifacts()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("inherits page metadata in the gate and refuses metadata changed during preflight", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const metadata = { summary: "A short look at archival replay.", concept: "Redis Streams" };
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>", metadata))).json();
      const artifactId = source.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      const getMemory = store.getSessionMemory.bind(store);
      vi.spyOn(store, "getSessionMemory").mockImplementationOnce(() => {
        store.renameArtifact(artifactId, "Renamed replay");
        return getMemory();
      });
      const html = "<p>Updated draft</p>";
      const operation = randomUUID();
      expect(await (await f.revise(daemon, operation, artifactId, html)).json()).toMatchObject({
        isError: true, structuredContent: { code: "session_review_conflict" },
      });
      expect(store.getArtifacts()).toHaveLength(1);
      const revised = await (await f.revise(daemon, operation, artifactId, html)).json();
      const revisedId = revised.structuredContent.artifactId as string;
      expect(store.getArtifacts().find((a) => a.id === revisedId)).toMatchObject({
        title: "Renamed replay", content: { ...metadata, concept: { name: metadata.concept }, html },
      });
      const reason = "Nobody can operate Redis Streams.";
      store.recordRejectedApproach({ description: "Redis Streams", concept: "Redis Streams", reason });
      expect(await (await f.revise(daemon, randomUUID(), revisedId, "<p>Neutral text</p>")).json()).toMatchObject({
        isError: true, structuredContent: { code: "rejected_approach_blocked", reason },
      });
      expect(store.getArtifacts()).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });

  it("binds a request ID even when the parsed target is missing", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const operation = randomUUID();
      const html = "<p>Updated draft</p>";
      expect(await (await f.revise(daemon, operation, "art_missing", html)).json()).toMatchObject({
        isError: true, structuredContent: { code: "artifact_not_in_session" },
      });
      expect(await (await f.revise(daemon, operation, source.structuredContent.artifactId, html)).json()).toMatchObject({
        isError: true, structuredContent: { code: "standalone_operation_conflict" },
      });
      expect(daemon.sessions.get(f.sessionId)!.getArtifacts()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("recovers the original preflight trace and broadcasts the durable note once", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const source = await (await f.present(daemon, randomUUID(), page("<p>First draft</p>"))).json();
      const store = daemon.sessions.get(f.sessionId)!;
      const operation = randomUUID();
      const artifactId = source.structuredContent.artifactId as string;
      const args = { artifactId, html: "<p>Updated draft</p>", reason: "Clarify the procedure" };
      const broadcast = vi.fn();
      const traceWrite = vi.spyOn(store, "recordPreflightTrace").mockImplementationOnce(() => {
        throw new Error("Interrupted before trace write");
      });
      const revise = () => reviseStandalonePage(f.root, store, operation, args, broadcast);
      await expect(revise()).rejects.toThrow("Interrupted before trace write");
      expect(broadcast).not.toHaveBeenCalled();
      const receiptFile = path.join(f.root, ".deeppairing", "sessions", f.sessionId, `revise-page-${operation}.json`);
      const prepared = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      expect(prepared).toMatchObject({ trace: { toolName: "revise_artifact", decision: "admitted" } });
      expect(prepared).not.toHaveProperty("committed");
      const note = store.getCommentsForArtifact(artifactId)[0];
      expect(note).toMatchObject({ author: "agent" });
      const readMemory = vi.spyOn(store, "getSessionMemory");
      expect(await revise()).toMatchObject({ structuredContent: { artifactId: prepared.trace.artifactId, replayed: true } });
      expect(store.getPreflightTrace(prepared.trace.artifactId)).toEqual(prepared.trace);
      expect(traceWrite).toHaveBeenLastCalledWith(prepared.trace.artifactId, prepared.trace);
      expect(readMemory).not.toHaveBeenCalled();
      expect(broadcast).toHaveBeenCalledWith({ type: "comment_added", comment: note });
      const completionEvents = broadcast.mock.calls.length;
      expect(await revise()).toMatchObject({ structuredContent: { replayed: true } });
      expect(broadcast).toHaveBeenCalledTimes(completionEvents);
      expect(store.getCommentsForArtifact(artifactId)).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });
});

describe("authenticated standalone page", () => {
  it("replays exact page and revision receipts after End without source, writes, or watches", async () => {
    const f = fixture();
    try {
      const warm = f.start();
      await f.open(warm);
      const file = path.join(f.root, "watched.html");
      fs.writeFileSync(file, "<p>File-backed page</p>");
      const pageOp = randomUUID();
      const pageInput = { title: "Watched page", path: "watched.html" };
      const shown = await f.present(warm, pageOp, pageInput);
      expect(shown.status).toBe(200);
      const fileId = (await shown.json()).structuredContent.artifactId as string;
      await until(() => warm.pageWatcher.watched(f.sessionId).includes(fileId));

      const parent = await (await f.present(warm, randomUUID(), page("<p>First draft</p>"))).json();
      const parentId = parent.structuredContent.artifactId as string;
      const store = warm.sessions.get(f.sessionId)!;
      store.addComment({ id: "root_feedback", artifactId: parentId, author: "human", content: "Clarify the backup step", target: anchored });
      store.addComment({ id: "extra_feedback", artifactId: parentId, author: "human", content: "State who owns the backup", target: anchored });
      const selectedIds = ["extra_feedback", "root_feedback"];
      const reviseOp = randomUUID();
      const html = "<p>Revised draft.</p>";
      const revised = await f.revise(warm, reviseOp, parentId, html, "Apply feedback", selectedIds);
      expect(revised.status).toBe(200);
      const revision = (await revised.json()).structuredContent;
      expect(revision).toMatchObject({ parentArtifactId: parentId, version: 2, acknowledgedCommentIds: selectedIds });
      // A later reopen restores unread status without undoing the original revision receipt.
      store.markCommentHumanResolved("root_feedback");
      store.markCommentHumanResolved("root_feedback", null);
      expect(store.getComment("root_feedback")?.acknowledged).toBe(false);
      const replayPage = (active: Daemon) => f.present(active, pageOp, pageInput);
      const replayRevision = (active: Daemon) => f.revise(active, reviseOp, parentId, html, "Apply feedback", [...selectedIds].reverse());

      const release = warm.standaloneCloseout.admitWrite(f.sessionId);
      expect(release).toBeTypeOf("function");
      const ending = warm.standaloneCloseout.end(f.sessionId);
      try {
        const resume = await f.request(warm, "open-review", { mode: "resume" });
        expect(resume.status).toBe(409);
        expect(await resume.json()).toMatchObject({ code: "session_closing" });
        for (const replay of [replayPage, replayRevision]) {
          const closing = await replay(warm);
          expect(closing.status).toBe(409);
          expect(await closing.json()).toMatchObject({ code: "session_closing" });
        }
      } finally {
        release?.();
        await ending;
      }
      expect(warm.pageWatcher.watched(f.sessionId)).toEqual([]);
      expect(f.watchers.every((watcher) => watcher.closed)).toBe(true);
      fs.unlinkSync(file);

      const dir = path.join(f.root, ".deeppairing", "sessions", f.sessionId);
      const capture = () => fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]);
      const before = capture();
      const watchers = f.watchers.length;
      const meta = structuredClone(warm.sessionMeta.get(f.sessionId));
      const cold = f.start();
      const replies: string[][] = [];
      for (const active of [warm, cold]) {
        const shownAgain = await replayPage(active);
        expect(shownAgain.status).toBe(200);
        const pageReply = await shownAgain.text();
        expect(JSON.parse(pageReply)).toMatchObject({
          structuredContent: { artifactId: fileId, sourcePath: "watched.html", replayed: true },
        });
        const revisedAgain = await replayRevision(active);
        expect(revisedAgain.status).toBe(200);
        const revisionReply = await revisedAgain.text();
        expect(JSON.parse(revisionReply)).toMatchObject({
          structuredContent: {
            artifactId: revision.artifactId, parentArtifactId: parentId, version: 2,
            acknowledgedCommentIds: selectedIds, replayed: true,
          },
        });
        replies.push([pageReply, revisionReply]);
        for (const mismatch of [
          await f.present(active, pageOp, { ...pageInput, title: "Different page" }),
          await f.revise(active, reviseOp, parentId, html, "Different reason", ["root_feedback"]),
        ]) {
          expect(await mismatch.json()).toMatchObject({
            isError: true, structuredContent: { code: "standalone_operation_conflict" },
          });
        }
        for (const fresh of [
          await f.present(active, randomUUID(), page("<p>New page</p>")),
          await f.revise(active, randomUUID(), revision.artifactId, "<p>New revision</p>"),
        ]) {
          expect(fresh.status).toBe(409);
          expect(await fresh.json()).toMatchObject({ code: "session_ended" });
        }
        expect(active.pageWatcher.watched(f.sessionId)).toEqual([]);
        expect(active.activeSessions.has(f.sessionId)).toBe(false);
      }
      expect(replies[1]).toEqual(replies[0]);
      expect(warm.sessionMeta.get(f.sessionId)).toEqual(meta);
      expect(cold.sessionMeta.has(f.sessionId)).toBe(false);
      expect(cold.sessions.has(f.sessionId)).toBe(false);
      expect(f.watchers).toHaveLength(watchers);
      expect(capture()).toEqual(before);

      const comments = path.join(dir, "comments.json");
      const rows: Array<{ id: string }> = JSON.parse(fs.readFileSync(comments, "utf8"));
      const missingSelection = JSON.stringify(rows.filter((row) => row.id !== "root_feedback"));
      fs.writeFileSync(comments, missingSelection);
      const missing = await replayRevision(cold);
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ code: "session_review_conflict" });
      expect(fs.readFileSync(comments, "utf8")).toBe(missingSelection);

      fs.writeFileSync(comments, "{ corrupt");
      const damaged = await replayRevision(cold);
      expect(damaged.status).toBe(409);
      expect(await damaged.json()).toMatchObject({ code: "session_review_conflict" });
      expect(fs.readFileSync(comments, "utf8")).toBe("{ corrupt");
      expect(cold.sessions.has(f.sessionId)).toBe(false);
      expect(f.watchers).toHaveLength(watchers);
    } finally {
      f.dispose();
    }
  });

  it("keeps End behind an admitted page presentation through preflight and receipt commit", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;
      const closeout = daemon.standaloneCloseout;
      const operationId = randomUUID();
      const readMemory = store.getSessionMemory.bind(store);
      const createArtifact = store.createArtifact.bind(store);
      let ending: ReturnType<typeof closeout.end> | undefined;
      let stateAtWrite: string | undefined;
      vi.spyOn(store, "getSessionMemory").mockImplementationOnce(() => {
        // Preflight awaits this read. Start End before the presentation resumes.
        ending = closeout.end(f.sessionId);
        void ending.catch(() => {});
        return readMemory();
      });
      vi.spyOn(store, "createArtifact").mockImplementationOnce((input) => {
        stateAtWrite = closeout.state(f.sessionId).state;
        return createArtifact(input);
      });

      const response = await f.present(daemon, operationId, page("<p>Accepted before End</p>"));
      expect(await response.json()).toMatchObject({ structuredContent: { artifactId: expect.any(String) } });
      expect(ending).toBeDefined();
      await ending;
      expect(stateAtWrite).toBe("closing");
      expect(closeout.state(f.sessionId).state).toBe("ended");
      const receipt = path.join(f.root, ".deeppairing", "sessions", f.sessionId, `present-page-${operationId}.json`);
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toMatchObject({ committed: true });
    } finally {
      f.dispose();
    }
  });

  it("presents an inline page, replays the same request ID, and refuses changed input on it", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const op = randomUUID();
      const input = page("<h1>Replay</h1><p>Keep a local replay file.</p>", { summary: "Which backend?" });
      const first = await (await f.present(daemon, op, input)).json();
      expect(first.isError).toBeUndefined();
      const artifactId = first.structuredContent.artifactId as string;
      expect(artifactId).toMatch(/^art_[0-9a-f]{32}$/);
      const store = daemon.sessions.get(f.sessionId)!;
      expect(store.getArtifacts()).toMatchObject([{
        id: artifactId, type: "page", status: "draft",
        content: { title: "Replay backend", summary: "Which backend?", html: "<h1>Replay</h1><p>Keep a local replay file.</p>" },
      }]);
      expect((store.getArtifacts()[0]!.content as { sourcePath?: string }).sourcePath).toBeUndefined();
      expect(daemon.activeSessions.size).toBe(0); // no wrapper lease was granted

      expect(await (await f.present(daemon, op, input)).json()).toMatchObject({ structuredContent: { artifactId, replayed: true } });
      // A replay survives a daemon restart (the receipt is durable).
      store.dispose();
      daemon.dispose();
      const second = f.start();
      expect((await f.request(second, "open-review", { mode: "resume" })).status).toBe(200);
      expect(await (await f.present(second, op, input)).json()).toMatchObject({ structuredContent: { artifactId, replayed: true } });

      const changed = await (await f.present(second, op, page("<p>Different page</p>"))).json();
      expect(changed).toMatchObject({ isError: true, structuredContent: { code: "standalone_operation_conflict" } });
      expect(changed.content[0].text).toContain("use a new UUID for changed input");
      expect(second.sessions.get(f.sessionId)!.getArtifacts()).toHaveLength(1);
      expect(fs.statSync(path.join(f.root, ".deeppairing", "sessions", f.sessionId, `present-page-${op}.json`)).mode & 0o777).toBe(0o600);
    } finally {
      f.dispose();
    }
  });

  it("runs the rejection gate on the page text and returns the stored reason verbatim", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;
      const reason = "No operators for this dependency — we can't page anyone at 3am for Redis.";
      store.recordRejectedApproach({ description: "Redis Streams", concept: "Redis Streams", reason });
      const op = randomUUID();
      const refused = await (await f.present(daemon, op, page("<p>Use Redis Streams for event replay.</p>", { concept: "Redis Streams" }))).json();
      expect(refused).toMatchObject({ isError: true, structuredContent: { code: "rejected_approach_blocked", reason } });
      expect(store.getArtifacts()).toHaveLength(0);
      // Nothing was written, so the same request ID with the same input is gated again, not replayed.
      expect(await (await f.present(daemon, op, page("<p>Use Redis Streams for event replay.</p>", { concept: "Redis Streams" }))).json())
        .toMatchObject({ isError: true, structuredContent: { code: "rejected_approach_blocked", reason } });
      expect(store.getArtifacts()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it("refuses paths outside the project, absolute paths and symlink escapes through presentPage's reader", async () => {
    const f = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dp-page-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.html"), "<p>outside the project</p>");
      fs.mkdirSync(path.join(f.root, "docs"));
      fs.symlinkSync(path.join(outside, "secret.html"), path.join(f.root, "docs", "link.html"));
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;

      const relativeEscape = await (await f.present(daemon, randomUUID(), { title: "Escape", path: "../secret.html" })).json();
      expect(relativeEscape).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(relativeEscape.content[0].text).toContain("outside the project root");

      const absolute = await (await f.present(daemon, randomUUID(), { title: "Absolute", path: path.join(f.root, "docs", "link.html") })).json();
      expect(absolute).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(absolute.content[0].text).toContain("must be relative to the project root");

      const symlink = await (await f.present(daemon, randomUUID(), { title: "Symlink", path: "docs/link.html" })).json();
      expect(symlink).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(symlink.content[0].text).toContain("through a symlink");

      fs.mkdirSync(path.join(f.root, ".deeppairing", "pages"), { recursive: true });
      fs.writeFileSync(path.join(f.root, ".deeppairing", "pages", "p.html"), "<p>state dir</p>");
      const stateDir = await (await f.present(daemon, randomUUID(), { title: "State", path: ".deeppairing/daemon.json" })).json();
      expect(stateDir).toMatchObject({ isError: true, _meta: { code: "INPUT_VALIDATION_FAILED" } });
      expect(stateDir.content[0].text).toContain(".deeppairing/");
      const statePage = await (await f.present(daemon, randomUUID(), { title: "State", path: ".deeppairing/pages/p.html" })).json();
      expect(statePage.content[0].text).toContain(".deeppairing/");

      expect(store.getArtifacts()).toHaveLength(0);
      expect(f.watchers).toHaveLength(0);

      // A name that only starts with ".." is inside the root.
      fs.writeFileSync(path.join(f.root, "..draft.html"), "<p>dot-dot name</p>");
      const dotDot = await (await f.present(daemon, randomUUID(), { title: "Dot dot", path: "..draft.html" })).json();
      expect(dotDot.structuredContent).toMatchObject({ sourcePath: "..draft.html" });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      f.dispose();
    }
  });

  it("caps the inline page at exactly PAGE_HTML_MAX_BYTES, measures the body, and requires the bearer", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;
      const atCap = `<p>${"x".repeat(PAGE_HTML_MAX_BYTES - 7)}</p>`;
      expect(Buffer.byteLength(atCap)).toBe(PAGE_HTML_MAX_BYTES);

      expect((await f.request(daemon, "present-page", { operationId: randomUUID(), args: page(atCap) }, { authenticated: false })).status).toBe(401);
      expect(store.getArtifacts()).toHaveLength(0);

      const malformed = await f.present(daemon, randomUUID(), { title: "Bad", htmlBase64: "not base64!" });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({ error: "htmlBase64 must be canonical base64.", code: "validation_error" });

      const over = await f.present(daemon, randomUUID(), page(atCap + "x"));
      expect(over.status).toBe(413);
      expect(await over.json()).toMatchObject({ code: "body_too_large", error: expect.stringContaining("page cap") });

      // A body past the measured ceiling is refused by the stream limiter, before parsing.
      const padded = await f.present(daemon, randomUUID(), page("<p>small</p>", { summary: "s".repeat(STANDALONE_PAGE_MAX_BODY_BYTES) }));
      expect(padded.status).toBe(413);
      expect(await padded.json()).toMatchObject({ code: "body_too_large", error: expect.stringContaining("standalone page cap") });
      // The ordinary 512 KiB artifact lane still caps present-options.
      const optionsTooBig = await f.request(daemon, "present-options", { operationId: randomUUID(), args: { context: "x".repeat(600 * 1024) } });
      expect(optionsTooBig.status).toBe(413);
      expect(store.getArtifacts()).toHaveLength(0);

      const ok = await f.present(daemon, randomUUID(), page(atCap));
      expect(ok.status).toBe(200);
      expect((await ok.json()).structuredContent.artifactId).toMatch(/^art_/);
      expect(store.getArtifacts()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("replays with the backing artifact's real status and the newest live successor, even across a fork", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const store = daemon.sessions.get(f.sessionId)!;
      const child = (id: string, parentId: string, version: number) => store.createArtifact({
        id, type: "page", title: id, content: { title: id, html: `<p>${id}</p>` }, parentId, version,
      });

      // An allowance admission (supersedeSkipped) adds a child but leaves its parent approved.
      const approvedOp = randomUUID();
      const input = page("<p>Approved page</p>");
      const first = (await (await f.present(daemon, approvedOp, input)).json()).structuredContent.artifactId as string;
      store.updateArtifactStatus(first, "approved");
      child("art_after_approval", first, 2);
      const approved = await (await f.present(daemon, approvedOp, input)).json();
      expect(approved.structuredContent).toEqual({
        artifactId: first, replayed: true, status: "approved",
        currentArtifactId: "art_after_approval", currentVersion: 2, currentStatus: "draft",
      });
      expect(approved.content[0].text).toContain("It is approved; the page has since moved to v2 (art_after_approval");

      // A two-child fork: the live child wins over a closed one, whatever the order.
      const forkOp = randomUUID();
      const forkInput = page("<p>Forked page</p>");
      const parent = (await (await f.present(daemon, forkOp, forkInput)).json()).structuredContent.artifactId as string;
      store.updateArtifactStatus(parent, "rejected");
      child("art_fork_live", parent, 2);
      child("art_fork_closed", parent, 3);
      store.updateArtifactStatus("art_fork_closed", "rejected");
      expect((await (await f.present(daemon, forkOp, forkInput)).json()).structuredContent).toMatchObject({
        artifactId: parent, status: "rejected", currentArtifactId: "art_fork_live", currentVersion: 2, currentStatus: "draft",
      });
    } finally {
      f.dispose();
    }
  });

  it("re-arms the watch on a direct same-ID replay after a daemon restart, without a resume", async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.root, "docs"));
      fs.writeFileSync(path.join(f.root, "docs", "cold.html"), "<p>one</p>");
      const first = f.start();
      await f.open(first);
      const op = randomUUID();
      const input = { title: "Cold page", path: "docs/cold.html" };
      const artifactId = (await (await f.present(first, op, input)).json()).structuredContent.artifactId as string;
      await until(() => first.pageWatcher.watched(f.sessionId).length === 1);
      first.sessions.get(f.sessionId)!.dispose();
      first.dispose();
      expect(f.watchers.every((w) => w.closed)).toBe(true);

      const second = f.start();
      const replay = await (await f.present(second, op, input)).json();
      expect(replay.structuredContent).toMatchObject({ artifactId, replayed: true, status: "draft" });
      await until(() => second.pageWatcher.watched(f.sessionId).length === 1);
      expect(second.pageWatcher.watched(f.sessionId)).toEqual([artifactId]);
      const live = f.watchers.filter((w) => !w.closed);
      expect(live).toHaveLength(1);

      fs.writeFileSync(path.join(f.root, "docs", "cold.html"), "<p>two</p>");
      live[0]!.fire("cold.html");
      const store = second.sessions.get(f.sessionId)!;
      await until(() => store.getArtifacts().length === 2);
      await second.pageWatcher.idle();
      expect(store.getArtifacts().find((a) => a.parentId === artifactId)).toMatchObject({ version: 2, content: { html: "<p>two</p>" } });
    } finally {
      f.dispose();
    }
  });

  it("a wrapper leaving does not stop the watch of a still-loaded standalone review", async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.root, "docs"));
      fs.writeFileSync(path.join(f.root, "docs", "shared.html"), "<p>one</p>");
      const daemon = f.start();
      await f.open(daemon);
      const artifactId = (await (await f.present(daemon, randomUUID(), { title: "Shared", path: "docs/shared.html" })).json())
        .structuredContent.artifactId as string;
      await until(() => daemon.pageWatcher.watched(f.sessionId).length === 1);

      const wrapper = { session: "session_wrapper" };
      expect((await f.request(daemon, "register", {}, wrapper)).status).toBe(200);
      expect(daemon.activeSessions).toEqual(new Set([wrapper.session]));
      expect((await f.request(daemon, "unregister", {}, wrapper)).status).toBe(200);
      expect(daemon.activeSessions.size).toBe(0);
      expect(daemon.pageWatcher.watched(f.sessionId)).toEqual([artifactId]);
      expect(f.watchers.filter((w) => !w.closed)).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("keeps standalone sessions isolated and refuses unknown or foreign sessions", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      const other = createStandaloneSessionId(f.root);
      await f.open(daemon);
      await f.open(daemon, other);
      const op = randomUUID();
      const input = page("<p>Same request, two sessions.</p>");
      const a = await (await f.present(daemon, op, input)).json();
      const b = await (await f.present(daemon, op, input, other)).json();
      expect(a.structuredContent.replayed).toBeUndefined();
      expect(b.structuredContent.replayed).toBeUndefined();
      expect(a.structuredContent.artifactId).not.toBe(b.structuredContent.artifactId);
      expect(daemon.sessions.get(f.sessionId)!.getArtifacts().map((x) => x.id)).toEqual([a.structuredContent.artifactId]);
      expect(daemon.sessions.get(other)!.getArtifacts().map((x) => x.id)).toEqual([b.structuredContent.artifactId]);

      const missing = createStandaloneSessionId(f.root);
      expect((await f.present(daemon, randomUUID(), input, missing)).status).toBe(404);
      expect(daemon.sessions.has(missing)).toBe(false);
      const foreign = createStandaloneSessionId(path.join(f.root, "elsewhere"));
      expect((await f.present(daemon, randomUUID(), input, foreign)).status).toBe(403);
      expect((await f.present(daemon, randomUUID(), input, "session_legacy")).status).toBe(403);
    } finally {
      f.dispose();
    }
  });

  it("presents a project-relative path as a file-backed page that the watcher records on save", async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.root, "docs"));
      fs.writeFileSync(path.join(f.root, "docs", "plan.html"), "<p>one</p>");
      const daemon = f.start();
      await f.open(daemon);
      const op = randomUUID();
      const input = { title: "Plan page", path: "docs/plan.html" };
      const result = await (await f.present(daemon, op, input)).json();
      expect(result.structuredContent).toMatchObject({ artifactId: expect.stringMatching(/^art_/), sourcePath: "docs/plan.html" });
      const artifactId = result.structuredContent.artifactId as string;
      const store = daemon.sessions.get(f.sessionId)!;
      expect(store.getArtifacts()).toMatchObject([{ id: artifactId, content: { html: "<p>one</p>", sourcePath: "docs/plan.html" } }]);

      // The artifact_created broadcast synced the watch, with no wrapper lease.
      await until(() => f.watchers.length === 1);
      expect(daemon.pageWatcher.watched(f.sessionId)).toEqual([artifactId]);
      expect(daemon.activeSessions.size).toBe(0);

      fs.writeFileSync(path.join(f.root, "docs", "plan.html"), "<p>two</p>");
      f.watchers[0]!.fire("plan.html");
      await until(() => store.getArtifacts().length === 2);
      await daemon.pageWatcher.idle();
      const v2 = store.getArtifacts().find((a) => a.parentId === artifactId)!;
      expect(v2).toMatchObject({ version: 2, content: { html: "<p>two</p>", sourcePath: "docs/plan.html" } });
      expect(readFileWatch(v2.fileWatch).recorded?.fromArtifactId).toBe(artifactId);

      // A retry of the original call replays v1 (the file's later save is not
      // "changed input"), but says truthfully that the page has moved on.
      const replay = await (await f.present(daemon, op, input)).json();
      expect(replay.structuredContent).toEqual({
        artifactId, sourcePath: "docs/plan.html", replayed: true,
        status: "superseded", currentArtifactId: v2.id, currentVersion: 2, currentStatus: "draft",
      });
      expect(replay.content[0].text).toContain(`moved to v2 (${v2.id}`);
      expect(store.getArtifacts()).toHaveLength(2);
    } finally {
      f.dispose();
    }
  });
});

describe("standalone present page and revise-page lint warnings (#714 gap 6)", () => {
  it("carries non-blocking warnings beside the artifactId, and none for a clean page", async () => {
    const f = fixture();
    try {
      const daemon = f.start();
      await f.open(daemon);
      const res = await f.present(daemon, randomUUID(), page('<p>No heading</p><script src="https://cdn.example.com/x.js"></script>'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isError).toBeFalsy();
      expect(typeof body.structuredContent.artifactId).toBe("string");
      expect(body.structuredContent.warnings.map((w: { code: string }) => w.code)).toEqual(["external_asset", "no_headings"]);

      const clean = await (await f.present(daemon, randomUUID(), page("<h1>Plan</h1><p>Clean</p>"))).json();
      expect(clean.structuredContent.warnings).toBeUndefined();

      // revise-page (the CLI spreads structuredContent into its JSON) lints too,
      // on a fresh revision only; a same-UUID replay returns the stored receipt.
      const parentId = clean.structuredContent.artifactId as string;
      const operation = randomUUID();
      const revised = await (await f.revise(daemon, operation, parentId, '<p>v2</p><img src="//x.test/a.png">')).json();
      expect(revised.isError).toBeFalsy();
      expect(revised.structuredContent.warnings.map((w: { code: string }) => w.code)).toEqual(["external_asset", "no_headings"]);
      expect(revised.content[0].text).toContain("Page warnings (non-blocking");
      const replay = await (await f.revise(daemon, operation, parentId, '<p>v2</p><img src="//x.test/a.png">')).json();
      expect(replay.structuredContent.replayed).toBe(true);
      expect(replay.structuredContent.warnings).toBeUndefined();
      const cleanRevision = await (await f.revise(daemon, randomUUID(), revised.structuredContent.artifactId, "<h1>Plan</h1><p>v3</p>")).json();
      expect(cleanRevision.isError).toBeFalsy();
      expect(cleanRevision.structuredContent.warnings).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
});
