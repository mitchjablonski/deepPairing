import { describe, it, expect } from "vitest";
import {
  AgentEventSchema,
  CreateSessionRequestSchema,
  DecisionRequestSchema,
  DecisionResponseSchema,
  ArtifactSchema,
  CommentSchema,
} from "../../index.js";
import {
  researchScenario,
  textEvent,
  toolCallRead,
  toolResultRead,
  reasoningEvent,
  codeChangeEvent,
} from "../../__fixtures__/events.js";
import {
  sampleDecisionRequest,
  sampleDecisionResponse,
  sampleDecisionRequestEvent,
  sampleFindingsEvent,
} from "../../__fixtures__/decisions.js";
import {
  researchArtifact,
  planArtifact,
  sampleComment,
  lineComment,
} from "../../__fixtures__/artifacts.js";

describe("AgentEventSchema", () => {
  it("parses text events", () => {
    const result = AgentEventSchema.parse(textEvent);
    expect(result.type).toBe("text");
  });

  it("parses tool_call events", () => {
    const result = AgentEventSchema.parse(toolCallRead);
    expect(result.type).toBe("tool_call");
    if (result.type === "tool_call") {
      expect(result.tool).toBe("Read");
      expect(result.toolCallId).toBe("tc_001");
    }
  });

  it("parses tool_result events", () => {
    const result = AgentEventSchema.parse(toolResultRead);
    expect(result.type).toBe("tool_result");
    if (result.type === "tool_result") {
      expect(result.duration).toBe(45);
    }
  });

  it("parses reasoning events", () => {
    const result = AgentEventSchema.parse(reasoningEvent);
    expect(result.type).toBe("reasoning");
    if (result.type === "reasoning") {
      expect(result.confidence).toBe("high");
      expect(result.alternativesConsidered).toHaveLength(2);
    }
  });

  it("parses code_change events", () => {
    const result = AgentEventSchema.parse(codeChangeEvent);
    expect(result.type).toBe("code_change");
    if (result.type === "code_change") {
      expect(result.changeType).toBe("modify");
      expect(result.reasoning).toBeDefined();
    }
  });

  it("parses decision_request events", () => {
    const result = AgentEventSchema.parse(sampleDecisionRequestEvent);
    expect(result.type).toBe("decision_request");
    if (result.type === "decision_request") {
      expect(result.options).toHaveLength(3);
    }
  });

  it("parses findings events", () => {
    const result = AgentEventSchema.parse(sampleFindingsEvent);
    expect(result.type).toBe("findings");
    if (result.type === "findings") {
      expect(result.findings).toHaveLength(3);
      expect(result.openQuestions).toHaveLength(2);
    }
  });

  it("parses all events in research scenario", () => {
    for (const event of researchScenario) {
      expect(() => AgentEventSchema.parse(event)).not.toThrow();
    }
  });

  it("rejects invalid event type", () => {
    expect(() =>
      AgentEventSchema.parse({ type: "unknown", data: "bad" }),
    ).toThrow();
  });

  it("rejects tool_call missing required fields", () => {
    expect(() =>
      AgentEventSchema.parse({ type: "tool_call", tool: "Read" }),
    ).toThrow();
  });
});

describe("CreateSessionRequestSchema", () => {
  it("parses valid request", () => {
    const result = CreateSessionRequestSchema.parse({
      prompt: "Explain this codebase",
      cwd: "/home/user/project",
    });
    expect(result.prompt).toBe("Explain this codebase");
  });

  it("rejects empty prompt", () => {
    expect(() =>
      CreateSessionRequestSchema.parse({ prompt: "", cwd: "/tmp" }),
    ).toThrow();
  });

  it("rejects empty cwd", () => {
    expect(() =>
      CreateSessionRequestSchema.parse({ prompt: "test", cwd: "" }),
    ).toThrow();
  });
});

describe("DecisionRequestSchema", () => {
  it("parses valid decision request", () => {
    const result = DecisionRequestSchema.parse(sampleDecisionRequest);
    expect(result.options).toHaveLength(3);
    expect(result.options[0].recommendation).toBe(true);
  });

  it("rejects fewer than 2 options", () => {
    expect(() =>
      DecisionRequestSchema.parse({
        ...sampleDecisionRequest,
        options: [sampleDecisionRequest.options[0]],
      }),
    ).toThrow();
  });

  it("rejects more than 4 options", () => {
    const tooMany = Array(5)
      .fill(null)
      .map((_, i) => ({
        ...sampleDecisionRequest.options[0],
        id: `opt_${i}`,
      }));
    expect(() =>
      DecisionRequestSchema.parse({
        ...sampleDecisionRequest,
        options: tooMany,
      }),
    ).toThrow();
  });

  // Z5a — wire-shape DecisionOption now carries `concept` so DecisionCard
  // can read it without an (option as any) cast. Y5 hoisted the field
  // into the stored-content shape (artifact.ts) but missed the wire
  // shape — the regression code-quality council Y review flagged.
  it("Z5a: DecisionOption accepts an optional concept", () => {
    const result = DecisionRequestSchema.parse({
      ...sampleDecisionRequest,
      options: sampleDecisionRequest.options.map((o, i) =>
        i === 0
          ? { ...o, concept: { name: "service-oriented", oneLineExplanation: "wire boundary" } }
          : o,
      ),
    });
    expect(result.options[0].concept?.name).toBe("service-oriented");
    expect(result.options[1].concept).toBeUndefined();
  });

  it("Z5a: rejects an empty concept name (low-signal rows are worse than no row)", () => {
    expect(() =>
      DecisionRequestSchema.parse({
        ...sampleDecisionRequest,
        options: sampleDecisionRequest.options.map((o, i) =>
          i === 0 ? { ...o, concept: { name: "" } } : o,
        ),
      }),
    ).toThrow();
  });
});

describe("DecisionResponseSchema", () => {
  it("parses valid response with reasoning", () => {
    const result = DecisionResponseSchema.parse(sampleDecisionResponse);
    expect(result.optionId).toBe("opt_service");
    expect(result.reasoning).toBeDefined();
  });

  it("parses valid response without reasoning", () => {
    const result = DecisionResponseSchema.parse({ optionId: "opt_inline" });
    expect(result.optionId).toBe("opt_inline");
    expect(result.reasoning).toBeUndefined();
  });
});

describe("ArtifactSchema", () => {
  it("parses a research artifact", () => {
    const result = ArtifactSchema.parse(researchArtifact);
    expect(result.type).toBe("research");
    expect(result.version).toBe(1);
    expect(result.status).toBe("draft");
  });

  it("parses a plan artifact", () => {
    const result = ArtifactSchema.parse(planArtifact);
    expect(result.type).toBe("plan");
    expect(result.status).toBe("reviewing");
  });

  it("rejects invalid artifact type", () => {
    expect(() =>
      ArtifactSchema.parse({ ...researchArtifact, type: "invalid" }),
    ).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() =>
      ArtifactSchema.parse({ ...researchArtifact, status: "unknown" }),
    ).toThrow();
  });
});

describe("CommentSchema", () => {
  it("parses a comment with finding target", () => {
    const result = CommentSchema.parse(sampleComment);
    expect(result.author).toBe("human");
    expect(result.target.findingIndex).toBe(0);
    expect(result.acknowledged).toBe(false);
  });

  it("parses a line-level comment", () => {
    const result = CommentSchema.parse(lineComment);
    expect(result.target.lineNumber).toBe(2);
  });

  it("rejects empty content", () => {
    expect(() =>
      CommentSchema.parse({ ...sampleComment, content: "" }),
    ).toThrow();
  });
});

describe("AgentEventSchema - artifact events", () => {
  it("parses artifact_created events", () => {
    const event = { type: "artifact_created", artifact: researchArtifact };
    const result = AgentEventSchema.parse(event);
    expect(result.type).toBe("artifact_created");
  });

  it("parses artifact_updated events", () => {
    const event = { type: "artifact_updated", artifactId: "art_001", status: "approved" };
    const result = AgentEventSchema.parse(event);
    expect(result.type).toBe("artifact_updated");
  });

  it("parses comment_added events", () => {
    const event = { type: "comment_added", comment: sampleComment };
    const result = AgentEventSchema.parse(event);
    expect(result.type).toBe("comment_added");
  });

  it("parses plan_review_request events", () => {
    const event = {
      type: "plan_review_request",
      artifactId: "art_plan_001",
      title: "Auth Refactoring Plan",
      steps: [{ description: "Create service", files: ["/src/service.ts"], reasoning: "Clean separation" }],
    };
    const result = AgentEventSchema.parse(event);
    expect(result.type).toBe("plan_review_request");
  });
});
