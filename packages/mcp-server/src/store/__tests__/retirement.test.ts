import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { collectUnansweredQuestions } from "@deeppairing/shared";
import { FileStore } from "../file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
const session = "retirement";
const request = (door: "withdraw" | "revise" = "revise", mode: "retract" | "obsolete" = "retract") => ({
  artifactId: "a", expectedVersion: 1, expectedStatus: "draft" as const,
  door, mode, reason: "The premise no longer holds",
});
const open = () => fx.track(new FileStore(fx.dir, session));
const artifact = (store: FileStore) => store.getArtifacts().find(a => a.id === "a");
const file = (name: string) => path.join(fx.dir, ".deeppairing", "sessions", session, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");
function seed() {
  const store = open();
  store.createArtifact({ id: "a", type: "research", title: "Finding", content: { summary: "Premise" } });
  store.forceFlush();
  return store;
}
function human(store: FileStore, id: string, intent: "comment" | "question" = "comment", parentCommentId?: string) {
  return store.addComment({ id, artifactId: "a", content: id, author: "human", intent, parentCommentId });
}
beforeEach(() => { fx = withGlobalStore("dp-retirement-"); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fx.dispose(); });

describe("feedback-safe FileStore retirement", () => {
  it("installs repaired disk questions when recovery starts with no pending local comments", () => {
    const store = seed();
    fs.writeFileSync(file("comments.json"), JSON.stringify({ unknown: "feedback" }));
    expect(store.retireArtifact(request()).kind).toBe("feedback_unknown");
    const repaired = { id: "recovered_q", sessionId: session, target: { artifactId: "a" }, parentCommentId: null,
      author: "human", content: "Which boundary was checked?", intent: "question", acknowledged: false,
      answeredByCommentId: null, createdAt: "2026-10-24T01:00:00.000Z" };
    fs.writeFileSync(file("comments.json"), JSON.stringify([repaired]));
    store.forceFlush();
    expect(store.getUnacknowledgedComments().map((c) => c.id)).toContain("recovered_q");
    expect(collectUnansweredQuestions(store.getCommentsForArtifact("a")).map((q) => q.question.id)).toEqual(["recovered_q"]);
    expect(store.retireArtifact(request())).toMatchObject({ kind: "blocked_feedback", unansweredQuestions: 1 });
  });

  it.each([
    { broken: { fragment: "unknown human feedback" } },
    { broken: [{ author: "human", content: "unread fragment without id" }] },
    { broken: [{ id: "malformed", author: "human", content: "unread with invalid shape" }] },
  ])("preserves unknown feedback through queued disarm flush and explicit flush, then recovers losslessly: %j", async ({ broken }) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = seed();
    store.createArtifact({ id: "external", type: "changeset", title: "PR", content: { files: [], reviewIntent: "external" } });
    store.updateArtifactStatus("a", "approved", "ui_approve_button");
    store.forceFlush();
    human(store, "pending_local"); // Already queued before retirement discovers bad disk.
    const bytes = JSON.stringify(broken);
    fs.writeFileSync(file("comments.json"), bytes);
    expect(store.retireArtifact({ ...request(), expectedStatus: "approved" })).toMatchObject({ kind: "committed", disarmed: true, warning: expect.any(String) });
    await vi.advanceTimersByTimeAsync(101);
    expect(read("comments.json")).toBe(bytes);
    expect(() => store.forceFlush()).toThrow();
    expect(read("comments.json")).toBe(bytes);
    expect(store.getComment("pending_local")?.acknowledged).toBe(false);
    // A valid repaired disk collection can now merge the still-pending human input.
    const repaired = { ...store.getComment("pending_local")!, id: "repaired_disk", content: "Recovered original human input" };
    fs.writeFileSync(file("comments.json"), JSON.stringify([repaired]));
    store.forceFlush();
    const fresh = open();
    expect(fresh.getCommentsForArtifact("a").map((c) => c.id).sort()).toEqual(["pending_local", "repaired_disk"]);
    expect(artifact(fresh)?.status).toBe("retracted");
  });

  it.each(["humanResolvedAt", "createdAt", "duplicate"])("refuses malformed effective canonical feedback %s without normalizing bytes", (field) => {
    const store = seed();
    human(store, "q", "question");
    store.acknowledgeComments(["q"]);
    store.forceFlush();
    const q = structuredClone(store.getComment("q")!);
    const broken = field === "humanResolvedAt" ? [{ ...q, humanResolvedAt: 42 }] : field === "createdAt" ? [{ ...q, createdAt: "not-a-date" }] : [q, q];
    const bytes = JSON.stringify(broken);
    fs.writeFileSync(file("comments.json"), bytes);
    expect(store.retireArtifact(request()).kind).toBe("feedback_unknown");
    expect(artifact(store)?.status).toBe("draft");
    expect(read("comments.json")).toBe(bytes);
    expect(() => store.forceFlush()).toThrow();
    expect(read("comments.json")).toBe(bytes);
  });

  it("validates pending local canonical question fields as well as disk", () => {
    const store = seed();
    const q = human(store, "pending_question", "question");
    Object.assign(q, { humanResolvedAt: 42, acknowledged: true });
    expect(store.retireArtifact(request()).kind).toBe("feedback_unknown");
    expect(artifact(store)?.status).toBe("draft");
    expect(store.getComment("pending_question")).toEqual(q);
  });

  it("refuses malformed feedback instead of laundering it through salvage", () => {
    const store = seed();
    const bytes = JSON.stringify([{ id: "broken", author: "human", content: "unread", target: { artifactId: "a" } }]);
    fs.writeFileSync(file("comments.json"), bytes);
    expect(store.retireArtifact(request()).kind).toBe("feedback_unknown");
    expect(artifact(store)?.status).toBe("draft");
    expect(read("comments.json")).toBe(bytes);
  });

  it("refuses malformed artifact authority before changing status or feedback", () => {
    const store = seed();
    const broken = { ...artifact(store), version: "not-a-version" };
    const bytes = JSON.stringify([broken]);
    fs.writeFileSync(file("artifacts.json"), bytes);
    expect(() => store.retireArtifact(request())).toThrow(/authority/);
    expect(read("artifacts.json")).toBe(bytes);
    expect(store.getCommentsForArtifact("a")).toEqual([]);
  });

  it("unreadable feedback does not keep authoritative approved external findings armed", () => {
    const store = seed();
    store.createArtifact({ id: "external", type: "changeset", title: "PR", content: { files: [], reviewIntent: "external" } });
    store.updateArtifactStatus("a", "approved", "ui_approve_button");
    store.forceFlush();
    const bytes = "{unreadable feedback";
    fs.writeFileSync(file("comments.json"), bytes);
    expect(store.retireArtifact({ ...request(), expectedStatus: "approved" })).toMatchObject({ kind: "committed", disarmed: true, warning: expect.any(String) });
    expect(artifact(open())?.status).toBe("retracted");
    expect(read("comments.json")).toBe(bytes);
  });

  for (const door of ["withdraw", "revise"] as const) {
    it(`${door} persists status, reason, history and one root marker before success`, () => {
      const store = seed();
      expect(store.retireArtifact(request(door)).kind).toBe("committed");
      const fresh = open();
      const saved = artifact(fresh)!;
      expect(saved.status).toBe("retracted");
      expect(saved.content).toMatchObject({ retractReason: request().reason });
      expect(saved.statusHistory?.at(-1)).toMatchObject({ status: "retracted" });
      const markers = fresh.getCommentsForArtifact("a");
      expect(markers).toHaveLength(1);
      expect(markers[0].author).toBe("agent");
      expect(markers[0].parentCommentId).toBeFalsy();
    });

    for (const kind of ["plain", "question", "delivered-question", "answered-undrained", "pending", "countered"] as const) {
      it(`${door} refuses ${kind} without changing lifecycle or feedback bytes`, () => {
        const store = seed();
        if (kind === "pending" || kind === "countered") {
          store.addComment({ id: "s", artifactId: "a", content: "Replace this", author: "human", intent: "suggestion",
            suggestion: { originalText: "old", replacementText: "new", lineStart: 1, lineEnd: 1, state: kind } });
          store.acknowledgeComments(["s"]);
        } else {
          human(store, "h", kind === "plain" ? "comment" : "question");
          if (kind === "delivered-question") store.acknowledgeComments(["h"]);
          if (kind === "answered-undrained") store.addComment({ id: "answer", artifactId: "a", content: "Answer", author: "agent", parentCommentId: "h" });
        }
        store.forceFlush();
        const before = { artifacts: read("artifacts.json"), comments: read("comments.json") };
        const result = store.retireArtifact(request(door));
        expect(result.kind).toBe("blocked_feedback");
        expect(read("artifacts.json")).toBe(before.artifacts);
        expect(read("comments.json")).toBe(before.comments);
        expect(artifact(store)?.status).toBe("draft");
      });
    }

    it(`${door} permits answered or human-resolved questions after actual delivery`, () => {
      const store = seed();
      human(store, "answered", "question");
      store.addComment({ id: "answer", artifactId: "a", content: "Because", author: "agent", parentCommentId: "answered" });
      human(store, "resolved", "question");
      store.markCommentHumanResolved("resolved");
      store.acknowledgeComments(["answered", "resolved"]);
      const preserved = structuredClone(store.getCommentsForArtifact("a"));
      expect(store.retireArtifact(request(door)).kind).toBe("committed");
      for (const comment of preserved) expect(store.getComment(comment.id)).toEqual(comment);
    });
  }

  it("counts questions and suggestions once, with plain undrained comments separately", () => {
    const store = seed();
    human(store, "q", "question");
    human(store, "plain");
    store.addComment({ id: "s", artifactId: "a", content: "Suggestion", author: "human", intent: "suggestion",
      suggestion: { originalText: "a", replacementText: "b", lineStart: 1, lineEnd: 1, state: "pending" } });
    expect(store.retireArtifact(request())).toMatchObject({ kind: "blocked_feedback", unansweredQuestions: 1, openSuggestions: 1, undrainedComments: 1 });
  });

  it("retains root context when a delivered follow-up question blocks", () => {
    const store = seed();
    human(store, "root");
    store.addComment({ id: "answer", artifactId: "a", content: "Initial response", author: "agent", parentCommentId: "root" });
    human(store, "followup", "question", "root");
    store.acknowledgeComments(["root", "followup"]);
    expect(store.retireArtifact(request())).toMatchObject({ kind: "blocked_feedback", unansweredQuestions: 1 });
  });

  it("allows reviewing only through revise and supports obsolete", () => {
    const store = seed();
    store.updateArtifactStatus("a", "reviewing", "unspecified");
    store.forceFlush();
    const input = { ...request(), expectedStatus: "reviewing" as const };
    expect(store.retireArtifact({ ...input, door: "withdraw" }).kind).toBe("ineligible");
    expect(store.retireArtifact({ ...input, mode: "obsolete" }).kind).toBe("committed");
    expect(artifact(open())?.status).toBe("obsolete");
  });

  it("sees another writer's persisted feedback plus its own pending comments", () => {
    const store = seed();
    const writer = open();
    human(store, "local");
    human(writer, "external", "question");
    writer.forceFlush();
    expect(store.retireArtifact(request())).toMatchObject({ kind: "blocked_feedback", unansweredQuestions: 1, undrainedComments: 1 });
    store.forceFlush();
    expect(open().getCommentsForArtifact("a").map(c => c.id).sort()).toEqual(["external", "local"]);
  });

  it("refuses a persisted human verdict changed since the caller's snapshot", () => {
    const store = seed();
    const writer = open();
    writer.updateArtifactStatus("a", "approved", "ui_approve_button");
    writer.forceFlush();
    expect(store.retireArtifact(request()).kind).toBe("stale");
    expect(artifact(open())?.status).toBe("approved");
    expect(store.getCommentsForArtifact("a")).toHaveLength(0);
  });

  it("replays across restart without duplicating history or marker and preserves late feedback", () => {
    const store = seed();
    expect(store.retireArtifact(request()).kind).toBe("committed");
    const saved = structuredClone(artifact(store));
    const marker = store.getCommentsForArtifact("a")[0];
    const writer = open();
    human(writer, "late", "question");
    writer.forceFlush();
    const fresh = open();
    expect(fresh.retireArtifact(request()).kind).toBe("already_retired");
    expect(artifact(fresh)).toEqual(saved);
    expect(fresh.getCommentsForArtifact("a").filter(c => c.author === "agent")).toEqual([marker]);
    expect(fresh.getComment("late")?.acknowledged).toBe(false);
    expect(collectUnansweredQuestions(fresh.getCommentsForArtifact("a"))).toHaveLength(1);
    expect(fresh.retireArtifact({ ...request(), reason: "Different operation" }).kind).not.toBe("already_retired");
  });

  it("disarms approved external research without delivering or answering feedback", () => {
    const store = seed();
    store.createArtifact({ id: "external", type: "changeset", title: "External PR", content: { files: [], reviewIntent: "external" } });
    store.updateArtifactStatus("a", "approved", "ui_approve_button");
    human(store, "question", "question");
    human(store, "plain");
    const before = structuredClone(store.getCommentsForArtifact("a"));
    const input = { ...request(), expectedStatus: "approved" as const };
    expect(store.retireArtifact({ ...input, mode: "obsolete" }).kind).toBe("ineligible");
    expect(store.retireArtifact(input).kind).toBe("committed");
    for (const comment of before) expect(store.getComment(comment.id)).toEqual(comment);
    expect(collectUnansweredQuestions(store.getCommentsForArtifact("a"))).toHaveLength(1);
    expect(artifact(store)?.statusHistory?.some(h => h.status === "approved")).toBe(true);
  });

  it("cannot borrow external intent from another session or disarm a nonresearch artifact", () => {
    const store = seed();
    const other = fx.track(new FileStore(fx.dir, "other"));
    other.createArtifact({ id: "external", type: "changeset", title: "PR", content: { files: [], reviewIntent: "external" } });
    other.forceFlush();
    store.updateArtifactStatus("a", "approved", "ui_approve_button");
    store.forceFlush();
    expect(store.retireArtifact({ ...request(), expectedStatus: "approved" }).kind).toBe("ineligible");
    store.createArtifact({ id: "local-external", type: "changeset", title: "PR", content: { files: [], reviewIntent: "external" } });
    store.createArtifact({ id: "plan", type: "plan", title: "Plan", content: { steps: [], estimatedChanges: 0 } });
    store.updateArtifactStatus("plan", "approved", "ui_approve_button");
    expect(store.retireArtifact({ ...request(), artifactId: "plan", expectedStatus: "approved" }).kind).toBe("ineligible");
  });

  it("refuses an absent target or stale version before creating feedback", () => {
    const store = seed();
    expect(store.retireArtifact({ ...request(), artifactId: "absent" }).kind).toBe("not_found");
    expect(store.retireArtifact({ ...request(), expectedVersion: 2 }).kind).toBe("stale");
    expect(artifact(store)?.status).toBe("draft");
    expect(store.getCommentsForArtifact("a")).toHaveLength(0);
  });

  it("repairs a missing root marker after restart without another transition", () => {
    const store = seed();
    expect(store.retireArtifact(request()).kind).toBe("committed");
    const saved = read("artifacts.json");
    // Simulate the artifact replacement succeeding before a crash lost the marker.
    fs.writeFileSync(file("comments.json"), "[]");
    const fresh = open();
    expect(fresh.retireArtifact(request()).kind).toBe("already_retired");
    expect(read("artifacts.json")).toBe(saved);
    expect(fresh.getCommentsForArtifact("a")).toHaveLength(1);
    expect(fresh.getCommentsForArtifact("a")[0].parentCommentId).toBeFalsy();
  });

  it("refuses disposed and frozen writers before changing lifecycle or adding a marker", () => {
    const store = seed();
    store.dispose();
    expect(() => store.retireArtifact(request())).toThrow();
    expect(artifact(store)?.status).toBe("draft");
    expect(store.getCommentsForArtifact("a")).toHaveLength(0);

    const writer = open();
    const frozen = open();
    const changed = artifact(writer)!;
    changed.content = { summary: "New premise" };
    changed.version = 2;
    writer.renameArtifact("a", changed.title);
    frozen.updateArtifactStatus("a", "approved", "ui_approve_button");
    writer.forceFlush();
    expect(() => frozen.forceFlush()).toThrow();
    const before = structuredClone(artifact(frozen));
    expect(() => frozen.retireArtifact({ ...request(), expectedStatus: "approved" })).toThrow();
    expect(artifact(frozen)).toEqual(before);
    expect(frozen.getCommentsForArtifact("a")).toHaveLength(0);
  });

  for (const failedFile of ["artifacts.json", "comments.json"]) {
    it(`retains applied retirement after ${failedFile} replacement fails and repairs on replay`, () => {
      const store = seed();
      const rename = fs.renameSync;
      const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === file(failedFile)) throw Object.assign(new Error("injected replacement failure"), { code: "EIO" });
        return rename(from, to);
      });
      expect(store.retireArtifact(request()).kind).toBe("persist_uncertain");
      expect(artifact(store)?.status).toBe("retracted");
      const history = structuredClone(artifact(store)?.statusHistory);
      spy.mockRestore();
      expect(store.retireArtifact(request()).kind).toBe("already_retired");
      const fresh = open();
      expect(artifact(fresh)?.statusHistory).toEqual(history);
      expect(fresh.getCommentsForArtifact("a").filter(c => c.author === "agent")).toHaveLength(1);
    });
  }
});
