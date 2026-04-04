import type { Artifact, Comment } from "../index.js";

export const researchArtifact: Artifact = {
  id: "art_research_001",
  sessionId: "sess_1",
  type: "research",
  version: 1,
  parentId: null,
  title: "Authentication System Analysis",
  status: "draft",
  content: {
    summary: "The authentication system has several areas for improvement.",
    findings: [
      { category: "Security", detail: "Bcrypt with 10 salt rounds", evidence: "auth.ts:5", significance: "high" },
      { category: "Architecture", detail: "Auth logic mixed with routes", evidence: "routes/auth.ts", significance: "medium" },
    ],
    openQuestions: ["Should we add rate limiting?"],
  },
  agentReasoning: "Thorough review of the auth module revealed security and architecture concerns.",
  createdAt: "2026-04-02T10:00:00.000Z",
  updatedAt: "2026-04-02T10:00:00.000Z",
};

export const planArtifact: Artifact = {
  id: "art_plan_001",
  sessionId: "sess_1",
  type: "plan",
  version: 1,
  parentId: null,
  title: "Auth Refactoring Plan",
  status: "reviewing",
  content: {
    steps: [
      { description: "Create AuthService class", files: ["/src/services/auth-service.ts"], reasoning: "Separates auth logic from route handlers" },
      { description: "Update login route", files: ["/src/routes/auth.ts"], reasoning: "Replace inline bcrypt with AuthService calls" },
      { description: "Add integration tests", files: ["/tests/auth.test.ts"], reasoning: "Verify the refactoring doesn't break existing behavior" },
    ],
    estimatedChanges: 3,
  },
  agentReasoning: "Service pattern matches existing codebase conventions.",
  createdAt: "2026-04-02T10:05:00.000Z",
  updatedAt: "2026-04-02T10:05:00.000Z",
};

export const codeChangeArtifact: Artifact = {
  id: "art_code_001",
  sessionId: "sess_1",
  type: "code_change",
  version: 1,
  parentId: null,
  title: "Create AuthService",
  status: "draft",
  content: {
    filePath: "/src/services/auth-service.ts",
    changeType: "create",
    diff: "+export class AuthService {\n+  async validateCredentials() {}\n+}",
  },
  agentReasoning: "Following the approved service pattern plan.",
  createdAt: "2026-04-02T10:10:00.000Z",
  updatedAt: "2026-04-02T10:10:00.000Z",
};

export const sampleComment: Comment = {
  id: "cmt_001",
  sessionId: "sess_1",
  target: { artifactId: "art_research_001", findingIndex: 0 },
  parentCommentId: null,
  author: "human",
  content: "We should prioritize this — the bcrypt rounds issue was flagged in our last security audit.",
  acknowledged: false,
  createdAt: "2026-04-02T10:01:00.000Z",
};

export const threadedComment: Comment = {
  id: "cmt_002",
  sessionId: "sess_1",
  target: { artifactId: "art_research_001", findingIndex: 0 },
  parentCommentId: "cmt_001",
  author: "agent",
  content: "Understood. I'll prioritize switching to argon2 with OWASP-recommended parameters.",
  acknowledged: true,
  createdAt: "2026-04-02T10:01:30.000Z",
};

export const lineComment: Comment = {
  id: "cmt_003",
  sessionId: "sess_1",
  target: { artifactId: "art_code_001", lineNumber: 2 },
  parentCommentId: null,
  author: "human",
  content: "Should this also handle password hashing, or just validation?",
  acknowledged: false,
  createdAt: "2026-04-02T10:11:00.000Z",
};
