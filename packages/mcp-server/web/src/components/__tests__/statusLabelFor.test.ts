import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { statusLabelFor } from "../ArtifactPanel";

function art(over: Partial<Artifact>): Artifact {
  return {
    id: "a", sessionId: "s", type: "research", version: 1, parentId: null,
    title: "t", status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    ...over,
  } as Artifact;
}

describe("#193 E2 — statusLabelFor (the type-aware header chip)", () => {
  it("a DRAFT explainer reads 'New — for you to read' (not 'Draft, awaiting review')", () => {
    expect(statusLabelFor(art({ type: "explainer", status: "draft" }))).toBe("New — for you to read");
  });

  it("an APPROVED explainer reads 'Read' — the SAME word the footer uses, not 'Approved'", () => {
    // Pins Fix 2: after Got it, neither header nor footer may say "Approved".
    expect(statusLabelFor(art({ type: "explainer", status: "approved" }))).toBe("Read");
  });

  it("every other type/status keeps the default label (a draft research is still 'Draft, awaiting review')", () => {
    expect(statusLabelFor(art({ type: "research", status: "draft" }))).toBe("Draft, awaiting review");
    expect(statusLabelFor(art({ type: "debrief", status: "draft" }))).toBe("Draft, awaiting review");
    expect(statusLabelFor(art({ type: "research", status: "approved" }))).toBe("Approved");
    expect(statusLabelFor(art({ type: "debrief", status: "approved" }))).toBe("Approved");
  });
});
