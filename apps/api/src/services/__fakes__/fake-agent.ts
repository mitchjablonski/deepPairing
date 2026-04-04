import { EventEmitter } from "node:events";
import type { AgentEvent } from "@deeppairing/shared";
import type {
  AgentService,
  AgentSession,
  StartSessionOptions,
} from "../agent-types.js";
import { AGENT_EVENTS, emitAgentEvent } from "../agent-types.js";

export type FakeScenario = {
  name: string;
  events: AgentEvent[];
  /** Delay in ms between events. Default 150 */
  delayMs?: number;
  /** If true, pause at decision_request events and wait for resolution via emitter */
  pauseAtDecisions?: boolean;
};

/**
 * A scenario where the agent researches a codebase.
 * Emits Read/Grep tool calls, thinking, and a result.
 */
export const researchScenario: FakeScenario = {
  name: "research",
  events: [
    { type: "status", phase: "gathering" },
    {
      type: "text",
      content:
        "I'll analyze the codebase to understand the project structure and key patterns.",
    },
    {
      type: "tool_call",
      toolCallId: "tc_001",
      tool: "Read",
      input: { file_path: "/src/index.ts", limit: 100 },
      summary: "Read /src/index.ts (first 100 lines)",
    },
    {
      type: "tool_result",
      toolCallId: "tc_001",
      tool: "Read",
      output:
        'import express from "express";\nconst app = express();\n\napp.get("/", (req, res) => {\n  res.json({ status: "ok" });\n});\n\napp.listen(3000);',
      duration: 32,
    },
    {
      type: "tool_call",
      toolCallId: "tc_002",
      tool: "Glob",
      input: { pattern: "src/**/*.ts" },
      summary: "Find all TypeScript files in src/",
    },
    {
      type: "tool_result",
      toolCallId: "tc_002",
      tool: "Glob",
      output:
        "src/index.ts\nsrc/routes/auth.ts\nsrc/routes/users.ts\nsrc/middleware/auth.ts\nsrc/db/client.ts",
      duration: 15,
    },
    {
      type: "thinking",
      content:
        "This is an Express app with auth middleware and a database client. Let me check the auth implementation.",
    },
    {
      type: "tool_call",
      toolCallId: "tc_003",
      tool: "Read",
      input: { file_path: "/src/routes/auth.ts" },
      summary: "Read /src/routes/auth.ts",
    },
    {
      type: "tool_result",
      toolCallId: "tc_003",
      tool: "Read",
      output:
        'import { Router } from "express";\nimport bcrypt from "bcrypt";\n\nconst router = Router();\n\nrouter.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  // TODO: validate input\n  const user = await db.users.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }\n  res.json({ token: generateToken(user) });\n});',
      duration: 28,
    },
    {
      type: "tool_call",
      toolCallId: "tc_004",
      tool: "Grep",
      input: { pattern: "TODO|FIXME|HACK", path: "/src" },
      summary: 'Grep for "TODO|FIXME|HACK" in /src',
    },
    {
      type: "tool_result",
      toolCallId: "tc_004",
      tool: "Grep",
      output:
        "/src/routes/auth.ts:7:  // TODO: validate input\n/src/db/client.ts:3:  // TODO: add connection pooling",
      duration: 85,
    },
    { type: "status", phase: "presenting" },
    {
      type: "result",
      content:
        "## Codebase Analysis\n\nThis is an Express.js application with the following structure:\n\n- **5 TypeScript files** in src/\n- **Authentication**: Uses bcrypt for password hashing (login route at `/login`)\n- **Database**: Custom client (no connection pooling yet)\n- **TODOs found**: 2 items — input validation on login, connection pooling\n\n### Key Observations\n1. No input validation on the login endpoint — potential security issue\n2. No connection pooling on the database client — performance concern\n3. Auth middleware exists but its integration pattern is unclear",
      stopReason: "end_turn",
    },
  ],
  delayMs: 150,
};

/**
 * A scenario where the agent encounters an error.
 */
export const errorScenario: FakeScenario = {
  name: "error",
  events: [
    { type: "status", phase: "gathering" },
    {
      type: "text",
      content: "I'll look into the issue.",
    },
    {
      type: "tool_call",
      toolCallId: "tc_err_001",
      tool: "Bash",
      input: { command: "npm test" },
      summary: "Run npm test",
    },
    {
      type: "tool_result",
      toolCallId: "tc_err_001",
      tool: "Bash",
      output: "Error: ENOENT: no such file or directory",
      duration: 450,
    },
    {
      type: "error",
      message: "The project directory does not appear to contain a valid project.",
    },
  ],
  delayMs: 200,
};

/**
 * A scenario that includes a decision point (for Phase 3 testing).
 */
export const decisionScenario: FakeScenario = {
  name: "decision",
  events: [
    { type: "status", phase: "gathering" },
    {
      type: "text",
      content: "Let me research the authentication patterns in use.",
    },
    {
      type: "tool_call",
      toolCallId: "tc_d_001",
      tool: "Read",
      input: { file_path: "/src/routes/auth.ts" },
      summary: "Read /src/routes/auth.ts",
    },
    {
      type: "tool_result",
      toolCallId: "tc_d_001",
      tool: "Read",
      output: "// auth route implementation...",
      duration: 25,
    },
    {
      type: "findings",
      summary: "The authentication system has several areas for improvement.",
      findings: [
        {
          category: "Security",
          detail: "No input validation on login endpoint",
          evidence: "/src/routes/auth.ts:7",
          significance: "high" as const,
        },
        {
          category: "Architecture",
          detail: "Auth logic mixed with route handling",
          evidence: "/src/routes/auth.ts",
          significance: "medium" as const,
        },
      ],
      openQuestions: ["Should we add rate limiting?"],
    },
    { type: "status", phase: "presenting" },
    {
      type: "decision_request",
      decisionId: "dec_fake_001",
      context: "How should we restructure the authentication logic?",
      options: [
        {
          id: "opt_service",
          title: "Extract to Service Layer",
          description: "Move auth logic into a dedicated AuthService class.",
          pros: ["Clean separation", "Easier to test"],
          cons: ["More files", "Slight over-engineering"],
          effort: "medium" as const,
          risk: "low" as const,
          recommendation: true,
        },
        {
          id: "opt_inline",
          title: "Refactor In-Place",
          description: "Clean up the existing route handler.",
          pros: ["Minimal changes", "Quick"],
          cons: ["Controller stays large"],
          effort: "low" as const,
          risk: "low" as const,
          recommendation: false,
        },
      ],
    },
    // Events after this point represent what happens AFTER a decision is made.
    // In real usage, the fake would pause here and wait for resolution.
    { type: "status", phase: "executing" },
    {
      type: "reasoning",
      action: "Create AuthService class",
      reasoning: "Following the selected service pattern approach.",
      confidence: "high" as const,
    },
    {
      type: "tool_call",
      toolCallId: "tc_d_edit_001",
      tool: "Edit",
      input: {
        file_path: "/src/services/auth-service.ts",
        old_string: "",
        new_string: 'export class AuthService {}',
      },
      summary: "Create /src/services/auth-service.ts",
    },
    {
      type: "tool_result",
      toolCallId: "tc_d_edit_001",
      tool: "Edit",
      output: `File updated: /src/services/auth-service.ts
--- a/src/services/auth-service.ts
+++ b/src/services/auth-service.ts
@@ -0,0 +1,24 @@
+import argon2 from "argon2";
+import { db } from "../db/client";
+
+export class AuthService {
+  async validateCredentials(email: string, password: string) {
+    const user = await db.users.findByEmail(email);
+    if (!user) return null;
+
+    const valid = await argon2.verify(user.passwordHash, password);
+    return valid ? user : null;
+  }
+
+  async hashPassword(password: string): Promise<string> {
+    return argon2.hash(password);
+  }
+}`,
      duration: 85,
    },
    {
      type: "reasoning",
      action: "Update login route to use AuthService",
      reasoning: "Replacing inline bcrypt calls with the new service.",
      alternativesConsidered: ["Keep bcrypt calls as fallback"],
      confidence: "high" as const,
    },
    {
      type: "tool_call",
      toolCallId: "tc_d_edit_002",
      tool: "Edit",
      input: {
        file_path: "/src/routes/auth.ts",
        old_string: 'import bcrypt from "bcrypt"',
        new_string: 'import { AuthService } from "../services/auth-service"',
      },
      summary: "Update /src/routes/auth.ts to use AuthService",
    },
    {
      type: "tool_result",
      toolCallId: "tc_d_edit_002",
      tool: "Edit",
      output: `File updated: /src/routes/auth.ts
--- a/src/routes/auth.ts
+++ b/src/routes/auth.ts
@@ -1,11 +1,10 @@
 import { Router } from "express";
-import bcrypt from "bcrypt";
+import { AuthService } from "../services/auth-service";

 const router = Router();
+const authService = new AuthService();

 router.post("/login", async (req, res) => {
   const { email, password } = req.body;
-  const user = await db.users.findByEmail(email);
-  if (!user || !await bcrypt.compare(password, user.passwordHash)) {
+  const user = await authService.validateCredentials(email, password);
+  if (!user) {
     return res.status(401).json({ error: "Invalid credentials" });
   }`,
      duration: 62,
    },
    {
      type: "result",
      content: "Authentication refactoring complete. Created AuthService with argon2 and updated the login route to use it.",
      stopReason: "end_turn",
    },
  ],
  delayMs: 150,
  pauseAtDecisions: true,
};

/**
 * Full artifact lifecycle scenario — exercises research, plan review, reasoning, and code changes.
 * This is the default scenario for development mode.
 */
export const artifactScenario: FakeScenario = {
  name: "artifact",
  events: [
    { type: "status", phase: "gathering" },
    { type: "text", content: "I'll research the authentication system in depth." },
    {
      type: "tool_call",
      toolCallId: "tc_a_001",
      tool: "Glob",
      input: { pattern: "src/**/*.ts" },
      summary: "Find all TypeScript files",
    },
    {
      type: "tool_result",
      toolCallId: "tc_a_001",
      tool: "Glob",
      output: "src/index.ts\nsrc/routes/auth.ts\nsrc/middleware/auth.ts\nsrc/db/client.ts",
      duration: 12,
    },
    {
      type: "tool_call",
      toolCallId: "tc_a_002",
      tool: "Read",
      input: { file_path: "/src/routes/auth.ts" },
      summary: "Read /src/routes/auth.ts",
    },
    {
      type: "tool_result",
      toolCallId: "tc_a_002",
      tool: "Read",
      output: 'import { Router } from "express";\nimport bcrypt from "bcrypt";\n\nconst router = Router();\n\nrouter.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  // TODO: validate input\n  const user = await db.users.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }\n  res.json({ token: generateToken(user) });\n});',
      duration: 25,
    },
    // Research findings artifact
    {
      type: "artifact_created",
      artifact: {
        id: "art_fake_research",
        sessionId: "fake",
        type: "research" as const,
        version: 1,
        parentId: null,
        title: "Authentication System Analysis",
        status: "draft" as const,
        content: {
          summary: "The authentication system has several areas for improvement across security, architecture, and testing.",
          findings: [
            { category: "Security", detail: "Password hashing uses bcrypt with default salt rounds (10). OWASP recommends 12+ or switching to argon2.", evidence: "/src/routes/auth.ts:2", significance: "high" },
            { category: "Security", detail: "No input validation on login endpoint — email and password are used directly from req.body.", evidence: "/src/routes/auth.ts:7", significance: "high" },
            { category: "Architecture", detail: "Authentication logic is mixed directly into route handlers. No service layer separation.", evidence: "/src/routes/auth.ts", significance: "medium" },
            { category: "Testing", detail: "No integration tests for the login flow. Only 2 unit tests exist for password hashing.", evidence: "/tests/auth/ (2 files)", significance: "medium" },
          ],
          openQuestions: [
            "Should we add rate limiting to the login endpoint?",
            "Is multi-factor authentication planned?",
            "Should session tokens use JWT or opaque tokens?",
          ],
        },
        agentReasoning: "Thorough review of auth module revealed both security vulnerabilities and architectural concerns.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    {
      type: "findings",
      summary: "The authentication system has several areas for improvement.",
      findings: [
        { category: "Security", detail: "Weak password hashing (bcrypt, 10 rounds)", evidence: "/src/routes/auth.ts:2", significance: "high" as const },
        { category: "Security", detail: "No input validation on login", evidence: "/src/routes/auth.ts:7", significance: "high" as const },
        { category: "Architecture", detail: "Auth logic mixed with routes", evidence: "/src/routes/auth.ts", significance: "medium" as const },
        { category: "Testing", detail: "No integration tests for login flow", evidence: "/tests/auth/", significance: "medium" as const },
      ],
      openQuestions: ["Should we add rate limiting?", "Is MFA planned?"],
    },
    { type: "status", phase: "presenting" },
    // Decision point — present options
    {
      type: "decision_request",
      decisionId: "art_fake_decision",
      context: "How should we restructure the authentication system to address the security and architecture issues?",
      options: [
        {
          id: "opt_service",
          title: "Extract to AuthService + argon2",
          description: "Create a dedicated AuthService class with argon2 hashing, input validation, and clean separation from route handlers.",
          pros: ["Clean separation of concerns", "Easy to test in isolation", "Follows existing service patterns", "Addresses both security and architecture"],
          cons: ["More files to create", "Slightly more complex dependency injection"],
          effort: "medium" as const,
          risk: "low" as const,
          recommendation: true,
        },
        {
          id: "opt_middleware",
          title: "Auth Middleware + Guards",
          description: "Implement authentication as Express middleware with route-level guard decorators.",
          pros: ["Declarative auth at route level", "Reusable across all routes", "Framework-standard pattern"],
          cons: ["Different pattern from existing code", "Need to refactor all routes", "More complex error handling"],
          effort: "high" as const,
          risk: "medium" as const,
          recommendation: false,
        },
        {
          id: "opt_inline",
          title: "Refactor In-Place",
          description: "Fix the security issues (argon2 + validation) without changing the architecture.",
          pros: ["Minimal changes", "No new abstractions", "Fastest to implement"],
          cons: ["Route handlers stay large", "Harder to test", "Doesn't fix architecture"],
          effort: "low" as const,
          risk: "low" as const,
          recommendation: false,
        },
      ],
    },
    // After decision, show plan
    { type: "status", phase: "executing" },
    {
      type: "artifact_created",
      artifact: {
        id: "art_fake_plan",
        sessionId: "fake",
        type: "plan" as const,
        version: 1,
        parentId: null,
        title: "Auth Refactoring Implementation Plan",
        status: "draft" as const,
        content: {
          steps: [
            { description: "Create AuthService class with argon2", files: ["/src/services/auth-service.ts"], reasoning: "Centralizes auth logic with modern hashing" },
            { description: "Add input validation with zod", files: ["/src/schemas/auth.ts"], reasoning: "Validates email format and password requirements before processing" },
            { description: "Update login route to use AuthService", files: ["/src/routes/auth.ts"], reasoning: "Replace inline bcrypt calls with service methods" },
            { description: "Add integration tests", files: ["/tests/auth/integration.test.ts"], reasoning: "Verify the full login flow works end-to-end" },
          ],
          estimatedChanges: 4,
        },
        agentReasoning: "Service pattern with 4 focused changes. Each step is independently verifiable.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    // Reasoning + code changes
    {
      type: "reasoning",
      action: "Create AuthService with argon2 password hashing",
      reasoning: "Following the approved service pattern. Using argon2id variant with OWASP-recommended parameters.",
      alternativesConsidered: ["Keep bcrypt with higher rounds"],
      confidence: "high" as const,
    },
    {
      type: "tool_call",
      toolCallId: "tc_a_edit_001",
      tool: "Edit",
      input: { file_path: "/src/services/auth-service.ts" },
      summary: "Create /src/services/auth-service.ts",
    },
    {
      type: "tool_result",
      toolCallId: "tc_a_edit_001",
      tool: "Edit",
      output: `File updated: /src/services/auth-service.ts
--- /dev/null
+++ b/src/services/auth-service.ts
@@ -0,0 +1,20 @@
+import argon2 from "argon2";
+import { db } from "../db/client";
+
+export class AuthService {
+  async validateCredentials(email: string, password: string) {
+    const user = await db.users.findByEmail(email);
+    if (!user) return null;
+    const valid = await argon2.verify(user.passwordHash, password);
+    return valid ? user : null;
+  }
+
+  async hashPassword(password: string): Promise<string> {
+    return argon2.hash(password, {
+      type: argon2.argon2id,
+      memoryCost: 65536,
+      timeCost: 3,
+      parallelism: 4,
+    });
+  }
+}`,
      duration: 80,
    },
    {
      type: "result",
      content: "Authentication refactoring is underway. Created AuthService with argon2id hashing using OWASP-recommended parameters. Next step: add input validation.",
      stopReason: "end_turn",
    },
  ],
  delayMs: 200,
  pauseAtDecisions: true,
};

const DEFAULT_SCENARIO = artifactScenario;

const scenarios: Record<string, FakeScenario> = {
  research: researchScenario,
  error: errorScenario,
  decision: decisionScenario,
  artifact: artifactScenario,
};

export class FakeAgentService implements AgentService {
  private sessions = new Map<string, AgentSession>();
  private abortControllers = new Map<string, AbortController>();
  private nextId = 1;
  private defaultScenario: FakeScenario;

  constructor(scenario?: FakeScenario | string) {
    if (typeof scenario === "string") {
      this.defaultScenario = scenarios[scenario] ?? DEFAULT_SCENARIO;
    } else {
      this.defaultScenario = scenario ?? DEFAULT_SCENARIO;
    }
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const id = options.sessionId ?? `fake_session_${this.nextId++}`;
    const emitter = new EventEmitter();
    const session: AgentSession = { id, status: "running", emitter };
    this.sessions.set(id, session);

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);

    // Pick scenario based on prompt keywords, or use default
    let scenario = this.defaultScenario;
    const promptLower = options.prompt.toLowerCase();
    if (promptLower.includes("error") && !promptLower.includes("exploring")) {
      scenario = errorScenario;
    } else if (promptLower.startsWith("decision") || promptLower.includes("show me a decision")) {
      scenario = decisionScenario;
    }

    // Emit events on a timer (non-blocking)
    this.playScenario(id, scenario, abortController.signal);

    return session;
  }

  stopSession(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "completed";
      session.emitter.emit(AGENT_EVENTS.done);
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  private waitForEvent(
    session: AgentSession,
    signal: AbortSignal,
    eventName: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const onResolved = () => resolve();
      const onAbort = () => {
        session.emitter.removeListener(eventName, onResolved);
        resolve();
      };
      session.emitter.once(eventName, onResolved);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async playScenario(
    sessionId: string,
    scenario: FakeScenario,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const delay = scenario.delayMs ?? 150;

    for (const event of scenario.events) {
      if (signal.aborted) break;

      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal.aborted) break;

      emitAgentEvent(session.emitter, event);

      // Pause at decision points — wait for human to resolve via emitter
      if (event.type === "decision_request" && scenario.pauseAtDecisions) {
        await this.waitForEvent(session, signal, "decision:resolved");
      }

      // Pause at plan artifacts — wait for human to approve/revise/reject
      if (
        event.type === "artifact_created" &&
        (event as any).artifact?.type === "plan" &&
        scenario.pauseAtDecisions
      ) {
        await this.waitForEvent(session, signal, "plan:resolved");
      }
    }

    if (!signal.aborted) {
      session.status = "completed";
      session.emitter.emit(AGENT_EVENTS.done);
    }
  }
}
