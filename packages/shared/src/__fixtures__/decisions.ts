import type { DecisionRequest, DecisionResponse, DecisionOption } from "../schemas/decision.js";
import type { DecisionRequestEvent, FindingsEvent } from "../schemas/message.js";

export const optionServicePattern: DecisionOption = {
  id: "opt_service",
  title: "Extract to Service Layer",
  description: "Move authentication logic into a dedicated AuthService class with dependency injection.",
  pros: ["Clean separation of concerns", "Easier to test", "Follows existing patterns in the codebase"],
  cons: ["More files to create", "Slight over-engineering for current scale"],
  effort: "medium",
  risk: "low",
  recommendation: true,
};

export const optionInlineRefactor: DecisionOption = {
  id: "opt_inline",
  title: "Refactor In-Place",
  description: "Keep the logic in the existing controller but clean up the function signatures and error handling.",
  pros: ["Minimal changes", "No new abstractions", "Quick to implement"],
  cons: ["Controller stays large", "Harder to test in isolation"],
  effort: "low",
  risk: "low",
  recommendation: false,
};

export const optionMiddleware: DecisionOption = {
  id: "opt_middleware",
  title: "Auth Middleware + Guards",
  description: "Implement authentication as Express middleware with route-level guard decorators.",
  pros: ["Declarative auth at route level", "Reusable across routes", "Framework-standard approach"],
  cons: ["Different pattern from existing code", "Need to update all routes", "More complex error handling"],
  effort: "high",
  risk: "medium",
  recommendation: false,
};

export const sampleDecisionRequest: DecisionRequest = {
  decisionId: "dec_001",
  context: "How should we restructure the authentication logic?",
  options: [optionServicePattern, optionInlineRefactor, optionMiddleware],
};

export const sampleDecisionResponse: DecisionResponse = {
  optionId: "opt_service",
  reasoning: "I prefer the service pattern because it matches what we've done with UserService already.",
};

export const sampleDecisionRequestEvent: DecisionRequestEvent = {
  type: "decision_request",
  ...sampleDecisionRequest,
};

export const sampleFindingsEvent: FindingsEvent = {
  type: "findings",
  summary: "The authentication system has several areas for improvement.",
  findings: [
    {
      category: "Security",
      detail: "Password hashing uses bcrypt with only 10 salt rounds (OWASP recommends 12+)",
      evidence: "/src/auth/validate.ts:5",
      significance: "high",
    },
    {
      category: "Architecture",
      detail: "Auth logic is split between controller and middleware with no clear boundary",
      evidence: "/src/controllers/auth.ts, /src/middleware/auth.ts",
      significance: "medium",
    },
    {
      category: "Testing",
      detail: "No integration tests for the login flow, only unit tests for individual functions",
      evidence: "/tests/auth/ (3 files, all unit tests)",
      significance: "medium",
    },
  ],
  openQuestions: [
    "Should we also add rate limiting to the login endpoint?",
    "Is there a requirement for multi-factor authentication?",
  ],
};
