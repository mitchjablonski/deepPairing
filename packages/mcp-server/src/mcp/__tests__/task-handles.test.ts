/**
 * S5 — taskHandleForArtifact converter. Pin the status mapping so the
 * future MCP Tasks renderer (when SDK ships) sees the right shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { taskHandleForArtifact, taskKindForArtifactType } from "../task-handles.js";

let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-task-handle-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "task_handle_session");
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

describe("taskKindForArtifactType", () => {
  it("maps every artifact type to a task kind", () => {
    expect(taskKindForArtifactType("research")).toBe("findings");
    expect(taskKindForArtifactType("decision")).toBe("options");
    expect(taskKindForArtifactType("spec")).toBe("spec");
    expect(taskKindForArtifactType("plan")).toBe("plan");
    expect(taskKindForArtifactType("code_change")).toBe("code_change");
    expect(taskKindForArtifactType("reasoning")).toBe("log_reasoning");
  });
});

describe("taskHandleForArtifact", () => {
  it("findings (research) artifact in draft → input_required", async () => {
    const artifact = store.createArtifact({
      id: "art_findings_1",
      type: "research",
      title: "Audit",
      content: { summary: "x", findings: [] },
    });
    const h = await taskHandleForArtifact(artifact, store);
    expect(h.taskKind).toBe("findings");
    expect(h.status).toBe("input_required");
    expect(h.artifactId).toBe("art_findings_1");
  });

  it("approved findings → completed with status payload", async () => {
    const artifact = store.createArtifact({
      id: "art_findings_2",
      type: "research",
      title: "Audit",
      content: { summary: "x", findings: [] },
    });
    store.updateArtifactStatus(artifact.id, "approved");
    const refreshed = store.getArtifacts().find((a) => a.id === artifact.id)!;
    const h = await taskHandleForArtifact(refreshed, store);
    expect(h.status).toBe("completed");
    expect((h.response as any).status).toBe("approved");
  });

  it("retracted artifact → failed", async () => {
    const artifact = store.createArtifact({
      id: "art_r1",
      type: "research",
      title: "x",
      content: {},
    });
    store.updateArtifactStatus(artifact.id, "retracted");
    const refreshed = store.getArtifacts().find((a) => a.id === artifact.id)!;
    const h = await taskHandleForArtifact(refreshed, store);
    expect(h.status).toBe("failed");
  });

  it("superseded artifact → cancelled", async () => {
    const artifact = store.createArtifact({
      id: "art_s1",
      type: "research",
      title: "x",
      content: {},
    });
    store.updateArtifactStatus(artifact.id, "superseded");
    const refreshed = store.getArtifacts().find((a) => a.id === artifact.id)!;
    const h = await taskHandleForArtifact(refreshed, store);
    expect(h.status).toBe("cancelled");
  });

  it("reasoning artifact → completed on creation (no review cycle)", async () => {
    const artifact = store.createArtifact({
      id: "art_reasoning_1",
      type: "reasoning",
      title: "Use DI",
      content: { action: "x", reasoning: "y", concept: { name: "DI" } },
    });
    const h = await taskHandleForArtifact(artifact, store);
    expect(h.taskKind).toBe("log_reasoning");
    expect(h.status).toBe("completed");
  });

  it("decision artifact with no resolved response → input_required", async () => {
    const artifact = store.createArtifact({
      id: "art_dec_1",
      type: "decision",
      title: "Pick a cache",
      content: {
        decisionId: "dec_1",
        context: "Pick a cache",
        options: [{ id: "a", title: "Redis" }, { id: "b", title: "CDN" }],
      },
    });
    store.recordDecisionRequest({
      decisionId: "dec_1",
      artifactId: artifact.id,
      context: "Pick a cache",
      options: [{ id: "a", title: "Redis" }, { id: "b", title: "CDN" }] as any,
    });
    const h = await taskHandleForArtifact(artifact, store);
    expect(h.taskKind).toBe("options");
    expect(h.status).toBe("input_required");
    expect(h.response).toBeUndefined();
  });

  it("decision with resolved response → completed with response payload", async () => {
    const artifact = store.createArtifact({
      id: "art_dec_2",
      type: "decision",
      title: "Pick a cache",
      content: {
        decisionId: "dec_2",
        context: "Pick a cache",
        options: [{ id: "a", title: "Redis" }, { id: "b", title: "CDN" }],
      },
    });
    store.recordDecisionRequest({
      decisionId: "dec_2",
      artifactId: artifact.id,
      context: "Pick a cache",
      options: [{ id: "a", title: "Redis" }, { id: "b", title: "CDN" }] as any,
    });
    store.resolveDecision("dec_2", "a", "preferred");
    const h = await taskHandleForArtifact(artifact, store);
    expect(h.status).toBe("completed");
    expect((h.response as any).optionId).toBe("a");
    expect((h.response as any).reasoning).toBe("preferred");
  });

  it("plan artifact with verdict → completed with verdict payload", async () => {
    const artifact = store.createArtifact({
      id: "art_plan_1",
      type: "plan",
      title: "Implementation",
      content: { steps: [] },
    });
    store.recordPlanReview(artifact.id);
    store.resolvePlanReview(artifact.id, "approved", "ship it");
    const h = await taskHandleForArtifact(artifact, store);
    expect(h.taskKind).toBe("plan");
    expect(h.status).toBe("completed");
    expect((h.response as any).verdict).toBe("approved");
    expect((h.response as any).feedback).toBe("ship it");
  });

  it("plan artifact with no verdict → input_required", async () => {
    const artifact = store.createArtifact({
      id: "art_plan_2",
      type: "plan",
      title: "Implementation",
      content: { steps: [] },
    });
    store.recordPlanReview(artifact.id);
    const h = await taskHandleForArtifact(artifact, store);
    expect(h.status).toBe("input_required");
  });
});
