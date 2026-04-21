import { describe, it, expect } from "vitest";
import { buildTimeline, annotationsByEventId } from "../timeline";
import type { Artifact, Comment, SessionAnnotation } from "@deeppairing/shared";

function artifact(id: string, createdAt: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function comment(id: string, artifactId: string, createdAt: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    sessionId: "s1",
    target: { artifactId },
    parentCommentId: null,
    author: "human",
    content: `comment ${id}`,
    acknowledged: false,
    createdAt,
    ...overrides,
  };
}

describe("web buildTimeline — chronological interleave", () => {
  it("orders events across artifact / comment / decision / plan review", () => {
    const events = buildTimeline({
      artifacts: [
        artifact("a1", "2026-04-16T10:00:00.000Z", {
          updatedAt: "2026-04-16T10:05:00.000Z",
          status: "approved",
        }),
      ],
      comments: [comment("c1", "a1", "2026-04-16T10:02:00.000Z")],
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
          resolvedAt: "2026-04-16T10:03:00.000Z",
        },
      ],
      planReviews: [
        { artifactId: "a1", verdict: "approved", resolvedAt: "2026-04-16T10:04:00.000Z" },
      ],
    });

    expect(events.map((e) => e.kind)).toEqual([
      "artifact_created",
      "comment_added",
      "decision_resolved",
      "plan_reviewed",
      "artifact_status_changed",
    ]);
  });

  it("prefers statusHistory over updatedAt when both exist", () => {
    const a: any = artifact("a1", "2026-04-16T10:00:00.000Z", {
      updatedAt: "2026-04-16T10:30:00.000Z",
      status: "approved",
    });
    a.statusHistory = [
      { status: "draft", at: "2026-04-16T10:00:00.000Z" },
      { status: "reviewing", at: "2026-04-16T10:10:00.000Z" },
      { status: "approved", at: "2026-04-16T10:20:00.000Z" },
    ];
    const events = buildTimeline({ artifacts: [a] });
    const transitions = events.filter((e) => e.kind === "artifact_status_changed");
    expect(transitions).toHaveLength(2);
    expect((transitions[0].payload as any).status).toBe("reviewing");
    expect((transitions[1].payload as any).status).toBe("approved");
  });

  it("tags question comments with `Q` prefix in the label", () => {
    const events = buildTimeline({
      comments: [
        comment("c1", "a1", "2026-04-16T10:01:00.000Z", { intent: "question" } as any),
        comment("c2", "a1", "2026-04-16T10:02:00.000Z"),
      ],
    });
    expect(events[0].label.startsWith("Q ")).toBe(true);
    expect(events[1].label.startsWith("You ")).toBe(true);
  });

  it("skips unresolved decisions and plan reviews", () => {
    const events = buildTimeline({
      decisions: [
        {
          decisionId: "d1",
          artifactId: "a1",
          context: "Pending",
          options: [],
          // no response / resolvedAt
        },
      ],
      planReviews: [
        { artifactId: "a1" /* no verdict */ } as any,
      ],
    });
    expect(events).toHaveLength(0);
  });
});

describe("annotationsByEventId", () => {
  it("groups annotations by target event id", () => {
    const anns: SessionAnnotation[] = [
      { id: "ann_1", sessionId: "s1", targetEventId: "evt_x", note: "first", createdAt: "2026-04-16T10:00:00.000Z" },
      { id: "ann_2", sessionId: "s1", targetEventId: "evt_x", note: "second", createdAt: "2026-04-16T10:01:00.000Z" },
      { id: "ann_3", sessionId: "s1", targetEventId: "evt_y", note: "other", createdAt: "2026-04-16T10:02:00.000Z" },
    ];
    const map = annotationsByEventId(anns);
    expect(map.get("evt_x")).toHaveLength(2);
    expect(map.get("evt_y")).toHaveLength(1);
    expect(map.get("evt_missing")).toBeUndefined();
  });
});
