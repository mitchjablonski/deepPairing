import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withGlobalStore } from "../../__tests__/global-store-fixture.js";
import { createStandaloneSessionId } from "../../standalone-session-id.js";
import { FileStore } from "../../store/file-store.js";
import { StandaloneCloseout } from "../standalone-closeout.js";
import { presentStandaloneOptions } from "../standalone-options.js";
import { presentStandalonePage } from "../standalone-page.js";
import { reviseStandalonePage } from "../standalone-revise-page.js";

const quiet = () => {};
const options = {
  title: "Choose a format",
  context: "Select the format for the record.",
  options: [
    { id: "plain", title: "Plain text", description: "Write text", pros: [], cons: [], effort: "low", risk: "low" },
    { id: "table", title: "Table", description: "Write a table", pros: [], cons: [], effort: "low", risk: "low" },
  ],
};

function fixture() {
  const fx = withGlobalStore("dp-end-review-");
  const project = fx.dir;
  const sessionId = createStandaloneSessionId(project);
  const dir = path.join(project, ".deeppairing", "sessions", sessionId);
  let store = fx.track(new FileStore(project, sessionId));
  const restart = () => {
    store.dispose();
    store = fx.track(new FileStore(project, sessionId));
  };
  const coordinator = (timeout?: number) => new StandaloneCloseout(project, (id) => id === sessionId ? store : undefined, timeout);
  const marker = path.join(dir, "review-ended.json");
  const receipt = (kind: string, operation: string) => path.join(dir, `${kind}-${operation}.json`);
  return { fx, project, sessionId, dir, marker, receipt, coordinator, restart, get store() { return store; } };
}

describe("standalone End review core", () => {
  it("drains only the exact review, refuses new writes while closing, and keeps one durable timestamp", async () => {
    const f = fixture();
    try {
      const coordinator = f.coordinator();
      const other = createStandaloneSessionId(f.project);
      f.fx.track(new FileStore(f.project, other));
      const release = coordinator.admitWrite(f.sessionId)!;
      const ending = coordinator.end(f.sessionId);
      const second = coordinator.end(f.sessionId);
      expect(coordinator.state(f.sessionId)).toEqual({ state: "closing" });
      expect(coordinator.admitWrite(f.sessionId)).toBeUndefined();
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(coordinator.state(other)).toEqual({ state: "open" });
      const releaseOther = coordinator.admitWrite(other)!;
      releaseOther();
      expect(() => coordinator.admitWrite(createStandaloneSessionId(path.dirname(f.project)))).toThrow();
      expect(() => coordinator.admitWrite("session_mcp")).toThrow();
      release();
      release();
      const marker = await ending;
      expect(await second).toEqual(marker);
      expect(JSON.parse(fs.readFileSync(f.marker, "utf8"))).toEqual(marker);
      f.restart();
      expect(f.coordinator().state(f.sessionId)).toEqual({ state: "ended", endedAt: marker.endedAt });
      expect(f.coordinator().admitWrite(f.sessionId)).toBeUndefined();
      expect(await f.coordinator().end(f.sessionId)).toEqual(marker);
    } finally {
      f.fx.dispose();
    }
  });

  it("does not publish an end on drain timeout or marker write failure", async () => {
    const f = fixture();
    try {
      const coordinator = f.coordinator();
      const impatient = f.coordinator(5);
      const release = impatient.admitWrite(f.sessionId)!;
      await expect(impatient.end(f.sessionId)).rejects.toThrow(/retry End review/);
      expect(impatient.state(f.sessionId)).toEqual({ state: "open" });
      release();
      const rename = fs.renameSync.bind(fs);
      const fail = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (to === f.marker) throw new Error("Closeout marker interrupted");
        rename(from, to);
      });
      try {
        const ending = coordinator.end(f.sessionId);
        const waitingSave = coordinator.admitWatchedWrite(f.sessionId);
        await expect(ending).rejects.toThrow("Closeout marker interrupted");
        const releaseSave = await waitingSave;
        expect(releaseSave).toBeTypeOf("function");
        releaseSave?.();
        expect(coordinator.state(f.sessionId)).toEqual({ state: "open" });
        expect(fs.existsSync(f.marker)).toBe(false);
      } finally {
        fail.mockRestore();
      }
      await expect(coordinator.end(f.sessionId)).resolves.toMatchObject({ sessionId: f.sessionId });
    } finally {
      f.fx.dispose();
    }
  });

  it.each(["options", "page", "revision"] as const)("completes only the durable effects of an interrupted %s", async (kind) => {
    const f = fixture();
    try {
      const operation = randomUUID();
      const receipt = f.receipt(kind === "revision" ? "revise-page" : `present-${kind}`, operation);
      let parentId: string | undefined;
      const commentId = "cmt_durable_before_end";
      if (kind === "revision") {
        const original = await presentStandalonePage(f.project, f.store, randomUUID(), {
          title: "An outline", html: "<p>First draft</p>",
        }, 3847, quiet);
        parentId = original.structuredContent?.artifactId as string;
        f.store.addComment({
          id: commentId, artifactId: parentId, author: "human", content: "Clarify the draft",
          target: { htmlAnchor: { kind: "element", locator: "p", quote: "First draft" } },
        });
      }
      const rename = fs.renameSync.bind(fs);
      const fail = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (kind === "options" && path.basename(String(to)) === "decisions.json") throw new Error("Interrupted decision");
        if (kind === "revision" && path.basename(String(to)) === "preflight-traces.json") throw new Error("Interrupted revision trace");
        if (kind === "page" && to === receipt && JSON.parse(fs.readFileSync(from, "utf8")).committed) {
          throw new Error("Interrupted page receipt");
        }
        rename(from, to);
      });
      try {
        if (kind === "options") {
          await expect(presentStandaloneOptions(f.project, f.store, operation, options, 3847, quiet)).rejects.toThrow("Interrupted decision");
        } else if (kind === "page") {
          await expect(presentStandalonePage(f.project, f.store, operation, { title: "An outline", html: "<p>First draft</p>" }, 3847, quiet))
            .rejects.toThrow("Interrupted page receipt");
        } else {
          await expect(reviseStandalonePage(f.project, f.store, operation, {
            artifactId: parentId!, reason: "Clarify", html: "<p>Second draft</p>", ackCommentIds: [commentId],
          }, quiet)).rejects.toThrow("Interrupted revision trace");
        }
      } finally {
        fail.mockRestore();
      }
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).not.toHaveProperty("committed");
      f.restart();
      const artifactIds = f.store.getArtifacts().map((row) => row.id);
      const coordinator = f.coordinator();
      expect(await coordinator.end(f.sessionId)).toMatchObject({ sessionId: f.sessionId });
      expect(f.store.getArtifacts().map((row) => row.id)).toEqual(artifactIds);
      expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toMatchObject({ committed: true });
      if (kind === "options") expect(f.store.getPendingDecisions()).toMatchObject([{ artifactId: artifactIds[0] }]);
      if (kind === "revision") {
        const successor = f.store.getArtifacts().find((item) => item.parentId === parentId)!;
        expect(f.store.getPreflightTrace(successor.id)).toMatchObject({ decision: "admitted" });
        expect(f.store.getComment(commentId)?.acknowledged).toBe(true);
      }
    } finally {
      f.fx.dispose();
    }
  });

  it("ignores receipts without effects and does not turn buffered-only proposals into durable effects", async () => {
    const f = fixture();
    try {
      const operation = randomUUID();
      const rename = fs.renameSync.bind(fs);
      const fail = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (path.basename(String(to)) === "artifacts.json") throw new Error("Buffered proposal only");
        rename(from, to);
      });
      try {
        await expect(presentStandalonePage(f.project, f.store, operation,
          { title: "An outline", html: "<p>First draft</p>" }, 3847, quiet)).rejects.toThrow("Buffered proposal only");
      } finally {
        fail.mockRestore();
      }
      await expect(f.coordinator().end(f.sessionId)).rejects.toThrow(/without a durable artifact/);
      expect(fs.existsSync(f.marker)).toBe(false);
      f.restart();
      expect(f.store.getArtifacts()).toHaveLength(0);
      await expect(f.coordinator().end(f.sessionId)).resolves.toMatchObject({ sessionId: f.sessionId });
      expect(JSON.parse(fs.readFileSync(f.receipt("present-page", operation), "utf8"))).not.toHaveProperty("committed");
      expect(f.store.getArtifacts()).toHaveLength(0);
    } finally {
      f.fx.dispose();
    }
  });

  it("does not repair an earlier durable revision before rejecting a malformed later receipt", async () => {
    const f = fixture();
    try {
      const original = await presentStandalonePage(f.project, f.store, randomUUID(), { title: "An outline", html: "<p>Draft</p>" }, 3847, quiet);
      const parentId = original.structuredContent?.artifactId as string;
      const commentId = "cmt_pending";
      f.store.addComment({
        id: commentId, artifactId: parentId, author: "human", content: "Clarify the draft",
        target: { htmlAnchor: { kind: "element", locator: "p", quote: "Draft" } },
      });
      const operation = "00000000-0000-4000-8000-000000000000";
      const fail = vi.spyOn(f.store, "recordPreflightTrace").mockImplementationOnce(() => { throw new Error("Interrupted trace"); });
      try {
        await expect(reviseStandalonePage(f.project, f.store, operation, {
          artifactId: parentId, reason: "Clarify", html: "<p>Updated</p>", ackCommentIds: [commentId],
        }, quiet)).rejects.toThrow("Interrupted trace");
      } finally {
        fail.mockRestore();
      }
      f.restart();
      const receipt = f.receipt("revise-page", operation);
      const bytes = fs.readFileSync(receipt, "utf8");
      const malformed = f.receipt("revise-page", "ffffffff-ffff-4fff-bfff-ffffffffffff");
      fs.writeFileSync(malformed, JSON.stringify({ version: 1 }));
      const coordinator = f.coordinator();
      await expect(coordinator.end(f.sessionId)).rejects.toThrow();
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.readFileSync(receipt, "utf8")).toBe(bytes);
      expect(f.store.getComment(commentId)?.acknowledged).toBe(false);
      fs.unlinkSync(malformed);
      await expect(coordinator.end(f.sessionId)).resolves.toMatchObject({ sessionId: f.sessionId });
      expect(f.store.getComment(commentId)?.acknowledged).toBe(true);
    } finally {
      f.fx.dispose();
    }
  });

  it("rejects duplicate durable rows before a no-receipt close can flush unrelated warm changes", async () => {
    const f = fixture();
    try {
      f.store.createArtifact({ id: "art_original", title: "Outline", type: "page", content: { title: "Outline", html: "<p>Draft</p>" } });
      f.store.forceFlush();
      const file = path.join(f.dir, "artifacts.json");
      const [artifact] = JSON.parse(fs.readFileSync(file, "utf8"));
      const duplicate = JSON.stringify([artifact, artifact]);
      fs.writeFileSync(file, duplicate);
      f.store.createArtifact({ id: "art_warm", title: "Other", type: "page", content: { title: "Other", html: "<p>Other</p>" } });
      await expect(f.coordinator().end(f.sessionId)).rejects.toThrow(/duplicate/);
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe(duplicate);
    } finally {
      f.fx.dispose();
    }
  });

  it("rejects a same-ID store from a different project", async () => {
    const f = fixture();
    try {
      const foreignProject = path.join(f.project, "other");
      const foreign = f.fx.track(new FileStore(foreignProject, f.sessionId));
      const coordinator = new StandaloneCloseout(f.project, () => foreign);
      await expect(coordinator.end(f.sessionId)).rejects.toThrow(/in its project/);
      expect(fs.existsSync(f.marker)).toBe(false);
    } finally {
      f.fx.dispose();
    }
  });

  it("fails closed on malformed receipts and mismatched end markers", async () => {
    const f = fixture();
    try {
      fs.writeFileSync(f.receipt("revise-page", randomUUID()), JSON.stringify({ version: 1 }));
      const coordinator = f.coordinator();
      await expect(coordinator.end(f.sessionId)).rejects.toThrow();
      expect(fs.existsSync(f.marker)).toBe(false);
      fs.writeFileSync(f.marker, JSON.stringify({ version: 1, sessionId: "another review", endedAt: new Date().toISOString() }));
      expect(() => coordinator.admitWrite(f.sessionId)).toThrow(/different review/);
    } finally {
      f.fx.dispose();
    }
  });
});
