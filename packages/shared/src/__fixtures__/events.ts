import type { AgentEvent } from "../schemas/message.js";

export const textEvent: AgentEvent = {
  type: "text",
  content: "I'll analyze the codebase to understand the authentication flow.",
};

export const toolCallRead: AgentEvent = {
  type: "tool_call",
  toolCallId: "tc_001",
  tool: "Read",
  input: { file_path: "/src/auth/login.ts", limit: 100 },
  summary: "Read /src/auth/login.ts (first 100 lines)",
};

export const toolResultRead: AgentEvent = {
  type: "tool_result",
  toolCallId: "tc_001",
  tool: "Read",
  output: 'export async function login(email: string, password: string) {\n  // ...\n}',
  duration: 45,
};

export const toolCallGrep: AgentEvent = {
  type: "tool_call",
  toolCallId: "tc_002",
  tool: "Grep",
  input: { pattern: "validatePassword", path: "/src" },
  summary: 'Grep for "validatePassword" in /src',
};

export const toolResultGrep: AgentEvent = {
  type: "tool_result",
  toolCallId: "tc_002",
  tool: "Grep",
  output: "/src/auth/validate.ts:12: export function validatePassword(password: string)",
  duration: 120,
};

export const toolCallBash: AgentEvent = {
  type: "tool_call",
  toolCallId: "tc_003",
  tool: "Bash",
  input: { command: "npm test -- --grep auth" },
  summary: "Run auth tests",
};

export const toolResultBash: AgentEvent = {
  type: "tool_result",
  toolCallId: "tc_003",
  tool: "Bash",
  output: "3 passing (45ms)\n1 failing",
  duration: 2300,
};

export const thinkingEvent: AgentEvent = {
  type: "thinking",
  content: "The authentication flow uses bcrypt for password hashing. I should check if the salt rounds are configurable.",
};

export const statusGathering: AgentEvent = {
  type: "status",
  phase: "gathering",
};

export const statusPresenting: AgentEvent = {
  type: "status",
  phase: "presenting",
};

export const statusExecuting: AgentEvent = {
  type: "status",
  phase: "executing",
};

export const resultEvent: AgentEvent = {
  type: "result",
  content: "Analysis complete. The authentication system uses bcrypt with 10 salt rounds.",
  stopReason: "end_turn",
};

export const errorEvent: AgentEvent = {
  type: "error",
  message: "Agent exceeded maximum turns (30)",
};

export const reasoningEvent: AgentEvent = {
  type: "reasoning",
  action: "Refactor validatePassword to use argon2 instead of bcrypt",
  reasoning: "Argon2 is the current OWASP recommendation for password hashing. It's more resistant to GPU-based attacks than bcrypt.",
  alternativesConsidered: ["Keep bcrypt with higher salt rounds", "Use scrypt"],
  confidence: "high",
};

export const codeChangeEvent: AgentEvent = {
  type: "code_change",
  filePath: "/src/auth/validate.ts",
  changeType: "modify",
  diff: `--- a/src/auth/validate.ts
+++ b/src/auth/validate.ts
@@ -1,5 +1,5 @@
-import bcrypt from "bcrypt";
+import argon2 from "argon2";

 export async function validatePassword(password: string, hash: string) {
-  return bcrypt.compare(password, hash);
+  return argon2.verify(hash, password);
 }`,
  reasoning: {
    type: "reasoning",
    action: "Refactor validatePassword to use argon2",
    reasoning: "Argon2 is the current OWASP recommendation",
    confidence: "high",
  },
  toolCallId: "tc_010",
};

/** A realistic sequence of events for a "research a codebase" scenario */
export const researchScenario: AgentEvent[] = [
  statusGathering,
  textEvent,
  toolCallRead,
  toolResultRead,
  toolCallGrep,
  toolResultGrep,
  thinkingEvent,
  toolCallBash,
  toolResultBash,
  statusPresenting,
  resultEvent,
];
