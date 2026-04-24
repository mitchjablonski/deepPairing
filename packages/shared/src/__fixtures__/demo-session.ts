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

// R5: extend the canonical demo with a spec (think-together), a high-stakes
// decision that captures a prediction, and a second reasoning artifact that
// names a different concept. The Try-Demo button now loads a fuller pairing
// transcript — realistic enough to ground tests, screenshots, and the
// onboarding walkthrough without constructing fixtures ad-hoc.

const specArtifact: Artifact = {
  id: "art_spec_001",
  sessionId: "sess_1",
  type: "spec",
  version: 1,
  parentId: null,
  title: "Auth rate-limiting spec",
  status: "approved",
  content: {
    title: "Auth rate-limiting",
    objective: "Protect the login endpoint from credential-stuffing without degrading legitimate login latency.",
    context: "The current controller has no per-IP or per-account throttling. Observability shows a 3× baseline attempt rate on weekends.",
    requirements: [
      {
        id: "REQ-1",
        statement: "Reject more than 5 failed attempts per (email, IP) pair within 10 minutes.",
        rationale: "Credential-stuffing tools iterate many emails from the same IP; gating on (email, IP) catches both without punishing shared WiFi.",
        acceptanceCriteria: [
          "6th failed attempt returns 429 Too Many Requests",
          "Successful login resets the counter",
          "Counter expires after 10 minutes of inactivity",
        ],
        priority: "must",
      },
      {
        id: "REQ-2",
        statement: "Log rate-limit trips to the audit stream.",
        rationale: "The security team investigates clusters of trips — missing logs makes this impossible.",
        acceptanceCriteria: ["Each 429 emits a structured log event with email hash, IP, and ts"],
        priority: "should",
      },
    ],
    openQuestions: [
      "Do we need a separate ceiling for total requests per IP irrespective of email?",
    ],
  },
  agentReasoning: "Starting from a spec so REQ-1's rationale is visible before we argue about the implementation.",
  relatedArtifactIds: ["art_research_001"],
  createdAt: "2026-04-02T10:02:00.000Z",
  updatedAt: "2026-04-02T10:02:30.000Z",
};

const highStakesDecisionArtifact: Artifact = {
  id: "art_decision_hashing",
  sessionId: "sess_1",
  type: "decision",
  version: 1,
  parentId: null,
  title: "Password hashing: argon2id vs bcrypt cost-12",
  status: "approved",
  content: {
    decisionId: "dec_hashing",
    context: "Which password hashing algorithm should AuthService use?",
    stakes: "high",
    options: [
      {
        id: "argon",
        title: "argon2id",
        description: "Memory-hard, OWASP-recommended. Requires a new dep + one-pass rehash on login.",
        pros: ["GPU-resistant", "OWASP #1 recommendation", "Future-proof parameters"],
        cons: ["New dependency", "One-shot migration needed on next login per user"],
        effort: "medium",
        risk: "low",
        recommendation: true,
      },
      {
        id: "bcrypt12",
        title: "bcrypt @ cost 12",
        description: "Keep the existing bcrypt dep; bump the cost factor.",
        pros: ["Zero migration — existing hashes keep working"],
        cons: ["Not GPU-resistant", "Cost bump will be obsolete in 2-3 years"],
        effort: "low",
        risk: "medium",
        recommendation: false,
      },
    ],
  },
  agentReasoning: "High-stakes because it's hard to reverse once hashes are written. Capturing a prediction so we can calibrate later.",
  relatedArtifactIds: ["art_spec_001"],
  createdAt: "2026-04-02T10:04:30.000Z",
  updatedAt: "2026-04-02T10:05:15.000Z",
};

const backoffReasoningArtifact: Artifact = {
  id: "art_reasoning_002",
  sessionId: "sess_1",
  type: "reasoning",
  version: 1,
  parentId: null,
  title: "Exponential backoff on login retries",
  status: "approved",
  content: {
    action: "Add exponential backoff between login attempts",
    reasoning: "Rate-limiting per REQ-1 alone still lets attackers sprint to their 5-attempt ceiling. Exponential backoff on each failure widens the window so the same 5 attempts take proportionally longer, without changing the success-case latency.",
    concept: {
      name: "exponential backoff",
      oneLineExplanation: "Escalate the wait between attempts so repeated failures consume strictly more time.",
    },
    alternativesConsidered: [
      "Fixed 1-second delay (too mild)",
      "Linear ramp 1s/2s/3s (attackers still cluster at the top)",
    ],
    confidence: "high",
  },
  agentReasoning: "Pairing with the rate-limit requirement. Naming the concept so future sessions recognize the pattern.",
  relatedArtifactIds: ["art_spec_001"],
  createdAt: "2026-04-02T10:09:30.000Z",
  updatedAt: "2026-04-02T10:09:30.000Z",
};

export const demoArtifacts: Artifact[] = [
  researchArtifact,
  specArtifact,
  decisionArtifact,
  highStakesDecisionArtifact,
  { ...planArtifact, relatedArtifactIds: ["art_research_001", "art_decision_001", "art_spec_001"] },
  reasoningArtifact,
  backoffReasoningArtifact,
  enrichedCodeChange,
];

// A question + answer pair so the Try-Demo session shows the Q&A surface
// working end-to-end (❓→✓). Threaded via parentCommentId so the UI can
// collapse the answer under the question.
const questionComment: Comment = {
  id: "cmt_question_1",
  sessionId: "sess_1",
  target: { artifactId: "art_reasoning_002" },
  parentCommentId: null,
  author: "human",
  content: "Would a token bucket be simpler than exponential backoff here? Honest question — I'd learn from the tradeoff.",
  intent: "question",
  answeredByCommentId: "cmt_answer_1",
  acknowledged: true,
  createdAt: "2026-04-02T10:11:30.000Z",
};

const answerComment: Comment = {
  id: "cmt_answer_1",
  sessionId: "sess_1",
  target: { artifactId: "art_reasoning_002" },
  parentCommentId: "cmt_question_1",
  author: "agent",
  content:
    "Good question. A token bucket smooths burst rates — what you want for API-wide quota. Exponential backoff specifically punishes repeated failure on the SAME credential; it's adversarial, not fairness. You'd want both for a public API; here, just the backoff matches the threat.",
  acknowledged: true,
  createdAt: "2026-04-02T10:12:15.000Z",
};

export const demoComments: Comment[] = [
  sampleComment,
  evidenceComment,
  threadedComment,
  lineComment,
  questionComment,
  answerComment,
];

/**
 * R5: a resolved decision record for the high-stakes hashing choice, with
 * predictedOutcome + confidence captured. Consumers that stage the demo
 * with decision records (not just artifacts) can surface the predictions
 * breadcrumb + retrospective affordance.
 */
export const demoDecisionRecords = [
  {
    decisionId: "dec_hashing",
    artifactId: "art_decision_hashing",
    context: "Password hashing: argon2id vs bcrypt cost-12",
    options: highStakesDecisionArtifact.content && "options" in highStakesDecisionArtifact.content
      ? (highStakesDecisionArtifact.content as any).options
      : [],
    response: {
      optionId: "argon",
      reasoning: "OWASP recommendation + GPU resistance outweighs the one-time rehash migration.",
      predictedOutcome: "Zero-downtime migration — 95% of users rehash within a week, the rest on next login.",
      confidence: "medium" as const,
    },
    createdAt: "2026-04-02T10:04:30.000Z",
    resolvedAt: "2026-04-02T10:05:15.000Z",
  },
];
