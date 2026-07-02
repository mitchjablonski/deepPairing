/**
 * Smoke tests — mount each component with realistic props and assert it
 * renders without throwing. Catches dumb bugs (missing imports, null deref
 * in the render path, broken hooks) at near-zero authoring cost. Doesn't
 * test behavior — the targeted suites in sibling files cover interactions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Artifact, Comment } from "@deeppairing/shared";

// Avoid pulling shiki into every render — syntax highlighting is async and
// irrelevant for smoke coverage.
vi.mock("../../hooks/useHighlightedCode", () => ({
  useHighlightedCode: () => ({ lines: null }),
}));

import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { PlanArtifact } from "../artifacts/PlanArtifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { CodeChangeArtifact } from "../artifacts/CodeChangeArtifact";
import { ReasoningCard } from "../artifacts/ReasoningCard";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { SearchResults as _SearchResults } from "../SessionBrowser";

import { MessageInput } from "../MessageInput";
import { TurnIndicator } from "../TurnIndicator";
import { PendingBanner } from "../PendingBanner";
import { AutonomySlider } from "../AutonomySlider";
import { ExportMenu } from "../ExportMenu";
import { KeyboardShortcutHelp } from "../KeyboardShortcutHelp";
import { SettingsSheet } from "../SettingsSheet";
import { CommandPalette } from "../CommandPalette";
import { CausalChain } from "../CausalChain";
import { SessionMetrics } from "../SessionMetrics";

import { useArtifactStore } from "../../stores/artifact";

function baseArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_x",
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: "Smoke artifact",
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt: "2026-04-17T10:00:00.000Z",
    updatedAt: "2026-04-17T10:00:00.000Z",
    ...overrides,
  };
}

function comment(id: string, artifactId: string): Comment {
  return {
    id,
    sessionId: "s1",
    target: { artifactId },
    parentCommentId: null,
    author: "human",
    content: "smoke",
    acknowledged: false,
    createdAt: "2026-04-17T10:00:00.000Z",
  };
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("artifact viewers — smoke", () => {
  it("ResearchArtifact renders with rich findings", () => {
    const artifact = baseArtifact({
      type: "research",
      content: {
        summary: "x",
        findings: [
          {
            category: "Security",
            title: "Weak hash",
            detail: "bcrypt 10 rounds",
            evidence: [
              { filePath: "auth.ts", lineStart: 1, lineEnd: 3, snippet: "code", explanation: "why" },
            ],
            significance: "high",
            severity: "high",
            impact: "brute force",
            recommendation: "use argon2id",
          },
        ],
      },
    });
    expect(() => render(<ResearchArtifact artifact={artifact} />)).not.toThrow();
  });

  it("PlanArtifact renders with steps + preview", () => {
    const artifact = baseArtifact({
      type: "plan",
      content: {
        steps: [
          {
            description: "Add middleware",
            reasoning: "DI",
            files: ["src/mw.ts"],
            preview: {
              before: "old",
              after: "new",
              filePath: "src/mw.ts",
            },
          },
        ],
        estimatedChanges: 1,
      },
    });
    expect(() => render(<PlanArtifact artifact={artifact} />)).not.toThrow();
  });

  it("SpecArtifact renders with requirements + tasks + openQuestions", () => {
    const artifact = baseArtifact({
      type: "spec",
      content: {
        objective: "stop credential stuffing",
        context: "login endpoint is unthrottled",
        requirements: [
          {
            id: "REQ-1",
            statement: "throttle per user",
            rationale: "brute-force is fast",
            acceptanceCriteria: ["5 fails / 10min rejects", "reset on success"],
            priority: "must",
          },
        ],
        design: "redis counters",
        tasks: [{ description: "middleware", linkedRequirementIds: ["REQ-1"], estimate: "m" }],
        openQuestions: ["admin exemption?"],
      },
    });
    expect(() => render(<SpecArtifact artifact={artifact} />)).not.toThrow();
  });

  it("CodeChangeArtifact renders with before/after", () => {
    const artifact = baseArtifact({
      type: "code_change",
      content: {
        filePath: "src/a.ts",
        changeType: "modify",
        before: "function a() {}",
        after: "function a() { return 1; }",
        reasoning: "return value needed",
        confidence: "high",
      },
    });
    expect(() => render(<CodeChangeArtifact artifact={artifact} />)).not.toThrow();
  });

  it("ReasoningCard renders with concept + evidence + alternatives", () => {
    const artifact = baseArtifact({
      type: "reasoning",
      content: {
        action: "Refactor",
        reasoning: "DI makes testing easier",
        concept: { name: "dependency inversion", oneLineExplanation: "depend on abstractions" },
        evidence: [
          { filePath: "a.ts", lineStart: 1, lineEnd: 3, snippet: "old", explanation: "why" },
        ],
        alternativeDetails: [{ title: "Inline helper", reason: "still couples" }],
        confidence: "medium",
      },
    });
    expect(() => render(<ReasoningCard artifact={artifact} />)).not.toThrow();
  });
});

describe("layout / chrome — smoke", () => {
  it("MessageInput renders with no history", () => {
    expect(() => render(<MessageInput />)).not.toThrow();
  });

  it("MessageInput renders with session history", () => {
    useArtifactStore.getState().addComment(comment("c1", "__session__"));
    useArtifactStore.getState().addComment(comment("c2", "__session__"));
    expect(() => render(<MessageInput />)).not.toThrow();
  });

  it("TurnIndicator renders (disconnected default)", () => {
    expect(() => render(<TurnIndicator />)).not.toThrow();
  });

  it("PendingBanner renders", () => {
    expect(() => render(<PendingBanner />)).not.toThrow();
  });

  it("AutonomySlider renders", () => {
    expect(() => render(<AutonomySlider />)).not.toThrow();
  });

  it("ExportMenu renders", () => {
    expect(() => render(<ExportMenu />)).not.toThrow();
  });

  it("KeyboardShortcutHelp renders", () => {
    expect(() => render(<KeyboardShortcutHelp onClose={() => {}} />)).not.toThrow();
  });

  it("SettingsSheet renders", () => {
    expect(() => render(<SettingsSheet onClose={() => {}} />)).not.toThrow();
  });

  it("CommandPalette renders", () => {
    expect(() => render(<CommandPalette onClose={() => {}} />)).not.toThrow();
  });

  it("CausalChain renders", () => {
    expect(() => render(<CausalChain />)).not.toThrow();
  });

  it("SessionMetrics renders", () => {
    expect(() => render(<SessionMetrics />)).not.toThrow();
  });
});

describe("SimpleMarkdown — smoke", () => {
  it("renders paragraphs, bold, italics, lists, code", () => {
    const md = [
      "**Bold** and *italic*.",
      "",
      "- one",
      "- two",
      "",
      "`inline code` here.",
    ].join("\n");
    expect(() => render(<SimpleMarkdown text={md} />)).not.toThrow();
  });

  it("handles empty string", () => {
    expect(() => render(<SimpleMarkdown text="" />)).not.toThrow();
  });
});
