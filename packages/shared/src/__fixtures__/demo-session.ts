/**
 * Complete demo session fixture for the "Try Demo" button.
 * Includes one of each artifact type + realistic comments.
 */
import type { Artifact, Comment } from "../index.js";
import {
  researchArtifact,
  planArtifact,
  codeChangeArtifact,
  sampleComment,
  evidenceComment,
  threadedComment,
  lineComment,
} from "./artifacts.js";
import {
  optionServicePattern,
  optionInlineRefactor,
  optionMiddleware,
} from "./decisions.js";

const decisionArtifact: Artifact = {
  id: "art_decision_001",
  sessionId: "sess_1",
  type: "decision",
  version: 1,
  parentId: null,
  title: "How should we restructure the authentication logic?",
  status: "draft",
  content: {
    context: "How should we restructure the authentication logic?",
    options: [optionServicePattern, optionInlineRefactor, optionMiddleware],
    decisionId: "dec_001",
  },
  agentReasoning:
    "Three viable approaches identified. Service pattern recommended based on existing codebase patterns.",
  relatedArtifactIds: ["art_research_001"],
  createdAt: "2026-04-02T10:03:00.000Z",
  updatedAt: "2026-04-02T10:03:00.000Z",
};

const reasoningArtifact: Artifact = {
  id: "art_reasoning_001",
  sessionId: "sess_1",
  type: "reasoning",
  version: 1,
  parentId: null,
  title: "Create AuthService with argon2",
  status: "approved",
  content: {
    action: "Create AuthService with argon2",
    reasoning:
      "Following the approved service pattern. Using argon2id with OWASP-recommended parameters instead of bcrypt, as identified in the security findings.",
    alternativesConsidered: [
      "Keep bcrypt but increase rounds to 12",
      "Use scrypt instead of argon2",
    ],
    confidence: "high",
  },
  agentReasoning:
    "Following the approved service pattern. Using argon2id with OWASP-recommended parameters.",
  relatedArtifactIds: ["art_plan_001"],
  createdAt: "2026-04-02T10:08:00.000Z",
  updatedAt: "2026-04-02T10:08:00.000Z",
};

// Enrich the code change artifact with before/after content
const enrichedCodeChange: Artifact = {
  ...codeChangeArtifact,
  content: {
    filePath: "/src/services/auth-service.ts",
    changeType: "create",
    before: "",
    after: 'import argon2 from "argon2";\nimport { db } from "../db/client";\n\nexport class AuthService {\n  async validateCredentials(email: string, password: string) {\n    const user = await db.users.findByEmail(email);\n    if (!user) return null;\n    const valid = await argon2.verify(user.passwordHash, password);\n    return valid ? user : null;\n  }\n\n  async hashPassword(password: string): Promise<string> {\n    return argon2.hash(password, {\n      type: argon2.argon2id,\n      memoryCost: 65536,\n      timeCost: 3,\n      parallelism: 4,\n    });\n  }\n}',
    reasoning: "Following the approved service pattern plan.",
  },
  relatedArtifactIds: ["art_plan_001", "art_reasoning_001"],
};

export const demoArtifacts: Artifact[] = [
  researchArtifact,
  decisionArtifact,
  { ...planArtifact, relatedArtifactIds: ["art_research_001", "art_decision_001"] },
  reasoningArtifact,
  enrichedCodeChange,
];

export const demoComments: Comment[] = [
  sampleComment,
  evidenceComment,
  threadedComment,
  lineComment,
];
