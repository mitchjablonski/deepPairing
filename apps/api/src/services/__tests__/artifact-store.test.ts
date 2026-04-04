import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentEvent } from "@deeppairing/shared";
import { ArtifactStore } from "../artifact-store.js";
import { FakeArtifactRepository, FakeCommentRepository } from "../../repositories/__fakes__/fake-repositories.js";
import { onAgentEvent } from "../agent-types.js";

function createStore() {
  const artifactRepo = new FakeArtifactRepository();
  const commentRepo = new FakeCommentRepository();
  const store = new ArtifactStore(artifactRepo, commentRepo);
  const emitter = new EventEmitter();
  store.registerSession("sess_test", emitter);
  return { store, emitter, artifactRepo, commentRepo };
}

function collectEvents(emitter: EventEmitter): AgentEvent[] {
  const events: AgentEvent[] = [];
  onAgentEvent(emitter, (e) => events.push(e));
  return events;
}

describe("ArtifactStore", () => {
  describe("createArtifact", () => {
    it("creates an artifact and emits artifact_created event", async () => {
      const { store, emitter } = createStore();
      const events = collectEvents(emitter);

      const artifact = await store.createArtifact("sess_test", {
        type: "research",
        title: "Auth Analysis",
        content: { summary: "Found issues", findings: [] },
      });

      expect(artifact.id).toMatch(/^art_/);
      expect(artifact.type).toBe("research");
      expect(artifact.status).toBe("draft");
      expect(artifact.version).toBe(1);
      expect(artifact.parentId).toBeNull();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("artifact_created");
    });

    it("includes agent reasoning when provided", async () => {
      const { store } = createStore();

      const artifact = await store.createArtifact("sess_test", {
        type: "plan",
        title: "Refactor Plan",
        content: { steps: [] },
        agentReasoning: "Based on findings from research phase.",
      });

      expect(artifact.agentReasoning).toBe("Based on findings from research phase.");
    });
  });

  describe("updateStatus", () => {
    it("updates status and emits artifact_updated event", async () => {
      const { store, emitter } = createStore();
      const events = collectEvents(emitter);

      const artifact = await store.createArtifact("sess_test", {
        type: "research",
        title: "Test",
        content: {},
      });

      await store.updateStatus(artifact.id, "approved");

      // artifact_created + artifact_updated
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe("artifact_updated");
      if (events[1].type === "artifact_updated") {
        expect(events[1].status).toBe("approved");
      }
    });

    it("creates a comment when status is revised with feedback", async () => {
      const { store, emitter } = createStore();
      const events = collectEvents(emitter);

      const artifact = await store.createArtifact("sess_test", {
        type: "plan",
        title: "Plan",
        content: {},
      });

      await store.updateStatus(artifact.id, "revised", "Add error handling to step 2");

      // artifact_created + artifact_updated + comment_added
      expect(events).toHaveLength(3);
      expect(events[2].type).toBe("comment_added");
      if (events[2].type === "comment_added") {
        expect(events[2].comment.content).toBe("Add error handling to step 2");
        expect(events[2].comment.author).toBe("human");
      }
    });
  });

  describe("createVersion", () => {
    it("creates a new version linked to parent", async () => {
      const { store } = createStore();

      const v1 = await store.createArtifact("sess_test", {
        type: "plan",
        title: "Plan",
        content: { steps: ["step 1"] },
      });

      const v2 = await store.createVersion(v1.id, { steps: ["step 1", "step 2"] });

      expect(v2.version).toBe(2);
      expect(v2.parentId).toBe(v1.id);
      expect(v2.title).toBe("Plan");
    });

    it("supersedes the parent artifact", async () => {
      const { store, artifactRepo } = createStore();

      const v1 = await store.createArtifact("sess_test", {
        type: "plan",
        title: "Plan",
        content: {},
      });

      await store.createVersion(v1.id, { steps: ["updated"] });

      const parentAfter = await artifactRepo.getById(v1.id);
      expect(parentAfter?.status).toBe("superseded");
    });
  });

  describe("comments", () => {
    it("adds a human comment and emits comment_added event", async () => {
      const { store, emitter } = createStore();
      const events = collectEvents(emitter);

      const artifact = await store.createArtifact("sess_test", {
        type: "research",
        title: "Test",
        content: {},
      });

      const comment = await store.addComment("sess_test", {
        artifactId: artifact.id,
        content: "This finding is critical.",
        author: "human",
        findingIndex: 0,
      });

      expect(comment.id).toMatch(/^cmt_/);
      expect(comment.author).toBe("human");
      expect(comment.acknowledged).toBe(false);
      expect(comment.target.findingIndex).toBe(0);

      const commentEvents = events.filter((e) => e.type === "comment_added");
      expect(commentEvents).toHaveLength(1);
    });

    it("agent comments are pre-acknowledged", async () => {
      const { store } = createStore();

      const artifact = await store.createArtifact("sess_test", {
        type: "research",
        title: "Test",
        content: {},
      });

      const comment = await store.addComment("sess_test", {
        artifactId: artifact.id,
        content: "Noted, will address this.",
        author: "agent",
      });

      expect(comment.acknowledged).toBe(true);
    });

    it("returns unacknowledged comments", async () => {
      const { store } = createStore();

      const artifact = await store.createArtifact("sess_test", {
        type: "research",
        title: "Test",
        content: {},
      });

      await store.addComment("sess_test", {
        artifactId: artifact.id,
        content: "Human says something",
        author: "human",
      });

      await store.addComment("sess_test", {
        artifactId: artifact.id,
        content: "Agent responds",
        author: "agent",
      });

      const unack = await store.getUnacknowledgedComments("sess_test");
      expect(unack).toHaveLength(1);
      expect(unack[0].author).toBe("human");
    });

    it("acknowledges comments", async () => {
      const { store } = createStore();

      const artifact = await store.createArtifact("sess_test", {
        type: "research",
        title: "Test",
        content: {},
      });

      const comment = await store.addComment("sess_test", {
        artifactId: artifact.id,
        content: "Feedback",
        author: "human",
      });

      await store.acknowledgeComments([comment.id]);

      const unack = await store.getUnacknowledgedComments("sess_test");
      expect(unack).toHaveLength(0);
    });
  });

  describe("queries", () => {
    it("lists artifacts by session", async () => {
      const { store } = createStore();

      await store.createArtifact("sess_test", { type: "research", title: "A", content: {} });
      await store.createArtifact("sess_test", { type: "plan", title: "B", content: {} });

      const artifacts = await store.getArtifactsBySession("sess_test");
      expect(artifacts).toHaveLength(2);
    });

    it("gets comments for a specific artifact", async () => {
      const { store } = createStore();

      const a1 = await store.createArtifact("sess_test", { type: "research", title: "A", content: {} });
      const a2 = await store.createArtifact("sess_test", { type: "plan", title: "B", content: {} });

      await store.addComment("sess_test", { artifactId: a1.id, content: "On A", author: "human" });
      await store.addComment("sess_test", { artifactId: a2.id, content: "On B", author: "human" });
      await store.addComment("sess_test", { artifactId: a1.id, content: "Also on A", author: "human" });

      const commentsA = await store.getCommentsForArtifact(a1.id);
      expect(commentsA).toHaveLength(2);

      const commentsB = await store.getCommentsForArtifact(a2.id);
      expect(commentsB).toHaveLength(1);
    });
  });
});
