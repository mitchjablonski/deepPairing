import { describe, it, expect } from "vitest";
import { TaskHandleSchema, TaskStatusSchema } from "../../index.js";

describe("TaskHandleSchema", () => {
  it("accepts a working handle without a response", () => {
    const h = TaskHandleSchema.parse({
      id: "art_1",
      taskKind: "findings",
      status: "working",
      artifactId: "art_1",
      createdAt: "2026-04-24T10:00:00.000Z",
      lastUpdatedAt: "2026-04-24T10:00:00.000Z",
    });
    expect(h.status).toBe("working");
  });

  it("accepts a completed handle with a free-form response payload", () => {
    const h = TaskHandleSchema.parse({
      id: "art_dec_1",
      taskKind: "options",
      status: "completed",
      artifactId: "art_dec_1",
      response: { optionId: "a", reasoning: "x", confidence: "high" },
      createdAt: "2026-04-24T10:00:00.000Z",
      lastUpdatedAt: "2026-04-24T10:05:00.000Z",
    });
    expect((h.response as any).optionId).toBe("a");
  });

  it("rejects unknown statuses", () => {
    expect(() =>
      TaskHandleSchema.parse({
        id: "x", taskKind: "options", status: "in-progress",
        artifactId: "x", createdAt: "2026-04-24T10:00:00.000Z", lastUpdatedAt: "2026-04-24T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects unknown taskKind values", () => {
    expect(() =>
      TaskHandleSchema.parse({
        id: "x", taskKind: "magic", status: "working",
        artifactId: "x", createdAt: "2026-04-24T10:00:00.000Z", lastUpdatedAt: "2026-04-24T10:00:00.000Z",
      }),
    ).toThrow();
  });

  it("the spec'd status set covers the SEP-1686 lifecycle", () => {
    expect(TaskStatusSchema.options).toEqual([
      "working", "input_required", "completed", "failed", "cancelled",
    ]);
  });
});
