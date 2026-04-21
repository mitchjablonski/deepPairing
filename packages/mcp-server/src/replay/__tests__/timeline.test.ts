import { describe, it, expect } from "vitest";
import { buildTimeline } from "../timeline.js";
import type { Artifact, Comment } from "@deeppairing/shared";

function artifact(id: string, createdAt: string, updatedAt = createdAt, status: any = "draft"): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status,
    content: {},
    agentReasoning: null,
    createdAt,
    updatedAt,
  };
}

function comment(id: string, artifactId: string, createdAt: string, author: "human" | "agent" = "human"): Comment {
  return {
    id,
    sessionId: "s1",
    target: { artifactId },
    parentCommentId: null,
    author,
    content: `comment ${id}`,
    acknowledged: false,
    createdAt,
  };
}

describe("buildTimeline", () => {
  it("interleaves artifacts, comments, decisions, plan reviews chronologically", () => {
    const events = buildTimeline({
      artifacts: [
        artifact("a1", "2026-04-16T10:00:00.000Z", "2026-04-16T10:05:00.000Z", "approved"),
      ],
      comments: [
        comment("c1", "a1", "2026-04-16T10:02:00.000Z"),
      ],
      decisions: [
        {
          decisionId: "d1",
          artifactId: "a1",
          context: "Which pattern?",
          options: [
            { id: "o1", title: "Service" },
            { id: "o2", title: "Inline" },
          ],
          response: { optionId: "o1", reasoning: "Cleaner" },
          createdAt: "2026-04-16T10:00:30.000Z",
          resolvedAt: "2026-04-16T10:03:00.000Z",
        },
      ],
      planReviews: [
        {
          artifactId: "a1",
          verdict: "approved",
          createdAt: "2026-04-16T10:01:00.000Z",
          resolvedAt: "2026-04-16T10:04:00.000Z",
        },
      ],
    });

    expect(events.map((e) => e.kind)).toEqual([
      "artifact_created",       // 10:00:00
      "comment_added",          // 10:02:00
      "decision_resolved",      // 10:03:00
      "plan_reviewed",          // 10:04:00
      "artifact_status_changed" // 10:05:00 via updatedAt
    ]);
    expect(events[2].label).toContain("Service");
    expect(events[2].payload?.rejectedTitles).toEqual(["Inline"]);
  });

  it("prefers statusHistory when provided", () => {
    const a: any = artifact("a1", "2026-04-16T10:00:00.000Z", "2026-04-16T10:10:00.000Z", "approved");
    a.statusHistory = [
      { status: "draft", at: "2026-04-16T10:00:00.000Z" },
      { status: "reviewing", at: "2026-04-16T10:05:00.000Z" },
      { status: "approved", at: "2026-04-16T10:10:00.000Z" },
    ];
    const events = buildTimeline({ artifacts: [a] });
    const transitions = events.filter((e) => e.kind === "artifact_status_changed");
    expect(transitions.map((e) => (e.payload as any).status)).toEqual(["reviewing", "approved"]);
  });

});
