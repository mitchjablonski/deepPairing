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
    summary: "The authentication system has several areas for improvement across security, architecture, and testing.",
    findings: [
      {
        category: "Security",
        title: "Weak Password Hashing",
        detail: "Password hashing uses bcrypt with only 10 salt rounds, below the OWASP minimum recommendation of 12 rounds. Modern GPUs can crack 10-round bcrypt hashes significantly faster than 12+ round hashes.",
        evidence: [
          {
            filePath: "/src/routes/auth.ts",
            lineStart: 2,
            lineEnd: 2,
            snippet: 'import bcrypt from "bcrypt";',
            language: "typescript",
            explanation: "Uses the bcrypt library. While bcrypt itself is not weak, the configuration (salt rounds) determines security.",
          },
          {
            filePath: "/src/routes/auth.ts",
            lineStart: 9,
            lineEnd: 12,
            snippet: '  const user = await db.users.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }',
            context: 'router.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  // TODO: validate input\n  const user = await db.users.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }\n  res.json({ token: generateToken(user) });\n});',
            language: "typescript",
            explanation: "bcrypt.compare uses the hash's embedded cost factor (10 rounds by default). OWASP recommends argon2id or bcrypt with 12+ rounds. With 10 rounds, a dedicated attacker with modern GPUs can test ~5,000 passwords/second.",
            relatedPaths: ["/src/middleware/auth.ts"],
          },
        ],
        significance: "high",
        impact: "User passwords are vulnerable to offline brute-force attacks. If the database is compromised, weak hashing means passwords are cracked faster, leading to account takeovers across services where users reuse passwords.",
        recommendation: "Switch to argon2id with OWASP-recommended parameters (memoryCost: 65536, timeCost: 3, parallelism: 4), or increase bcrypt rounds to 12+. Argon2id is preferred as it's resistant to both GPU and side-channel attacks.",
      },
      {
        category: "Security",
        title: "Missing Input Validation",
        detail: "The login endpoint accepts email and password directly from req.body without any validation. This allows malformed data, excessively long strings, and potential injection vectors.",
        evidence: [
          {
            filePath: "/src/routes/auth.ts",
            lineStart: 7,
            lineEnd: 8,
            snippet: '  const { email, password } = req.body;\n  // TODO: validate input',
            language: "typescript",
            explanation: "Destructures directly from req.body with a TODO comment acknowledging the missing validation. No email format check, no password length limits, no sanitization.",
          },
        ],
        significance: "high",
        impact: "Without validation, the endpoint is vulnerable to: oversized payloads causing memory issues, malformed emails bypassing downstream logic, and potential NoSQL injection if the ORM doesn't sanitize.",
        recommendation: "Add zod validation at the route level. Validate email format (z.string().email()), password length (z.string().min(8).max(128)), and reject invalid requests with 400 status.",
      },
      {
        category: "Architecture",
        title: "Auth Logic Mixed with Route Handlers",
        detail: "Authentication business logic (password comparison, token generation) is embedded directly in Express route handlers rather than separated into a service layer.",
        evidence: [
          {
            filePath: "/src/routes/auth.ts",
            lineStart: 6,
            lineEnd: 14,
            snippet: 'router.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  // TODO: validate input\n  const user = await db.users.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }\n  res.json({ token: generateToken(user) });\n});',
            language: "typescript",
            explanation: "The route handler does everything: validation, database lookup, password comparison, token generation, and HTTP response. This makes it hard to test, reuse, or modify individual concerns.",
            relatedPaths: ["/src/middleware/auth.ts", "/src/routes/users.ts"],
          },
        ],
        significance: "medium",
        impact: "Testing requires mocking Express request/response objects. Auth logic can't be reused in other contexts (WebSocket auth, API key validation). Changes to auth flow require modifying route handlers.",
        recommendation: "Extract to an AuthService class with methods like validateCredentials(email, password) and hashPassword(password). Route handlers become thin wrappers that call the service and format HTTP responses.",
      },
    ],
    openQuestions: [
      "Should we add rate limiting to the login endpoint to prevent brute-force attacks?",
      "Is multi-factor authentication planned for this application?",
      "Should session tokens use JWT or opaque tokens backed by a session store?",
    ],
  },
  agentReasoning: "Thorough review of the auth module revealed both critical security vulnerabilities and architectural concerns that compound each other.",
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
      {
        description: "Create AuthService class with argon2",
        files: [
          { filePath: "/src/services/auth-service.ts", changeType: "create", description: "New service with validateCredentials() and hashPassword()" },
        ],
        reasoning: "Separates auth logic from route handlers, enables unit testing, and replaces bcrypt with argon2id",
        motivatedBy: ["Weak Password Hashing", "Auth Logic Mixed with Route Handlers"],
        preview: {
          before: "// No file exists yet",
          after: 'import argon2 from "argon2";\nimport { db } from "../db/client";\n\nexport class AuthService {\n  async validateCredentials(email: string, password: string) {\n    const user = await db.users.findByEmail(email);\n    if (!user) return null;\n    const valid = await argon2.verify(user.passwordHash, password);\n    return valid ? user : null;\n  }\n\n  async hashPassword(password: string): Promise<string> {\n    return argon2.hash(password, {\n      type: argon2.argon2id,\n      memoryCost: 65536,\n      timeCost: 3,\n      parallelism: 4,\n    });\n  }\n}',
          filePath: "/src/services/auth-service.ts",
        },
      },
      {
        description: "Add input validation with zod",
        files: [
          { filePath: "/src/schemas/auth.ts", changeType: "create", description: "Login request schema with email and password validation" },
        ],
        reasoning: "Validates email format and password requirements before any processing",
        motivatedBy: ["Missing Input Validation"],
      },
      {
        description: "Update login route to use AuthService",
        files: [
          { filePath: "/src/routes/auth.ts", changeType: "modify", description: "Replace inline bcrypt with AuthService, add validation middleware" },
        ],
        reasoning: "Replace inline bcrypt calls with service methods, add zod validation",
        motivatedBy: ["Weak Password Hashing", "Missing Input Validation", "Auth Logic Mixed with Route Handlers"],
        preview: {
          before: 'import bcrypt from "bcrypt";\n\nrouter.post("/login", async (req, res) => {\n  const { email, password } = req.body;\n  const user = await db.users.findByEmail(email);\n  if (!user || !await bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }',
          after: 'import { AuthService } from "../services/auth-service";\nimport { loginSchema } from "../schemas/auth";\n\nconst authService = new AuthService();\n\nrouter.post("/login", async (req, res) => {\n  const parsed = loginSchema.safeParse(req.body);\n  if (!parsed.success) return res.status(400).json({ error: parsed.error });\n  const user = await authService.validateCredentials(parsed.data.email, parsed.data.password);\n  if (!user) return res.status(401).json({ error: "Invalid credentials" });',
          filePath: "/src/routes/auth.ts",
        },
      },
      {
        description: "Add integration tests",
        files: [
          { filePath: "/tests/auth/integration.test.ts", changeType: "create", description: "End-to-end tests for login flow with valid/invalid credentials" },
        ],
        reasoning: "Verify the full login flow works end-to-end after refactoring",
      },
    ],
    estimatedChanges: 4,
  },
  agentReasoning: "Service pattern with 4 focused changes. Each step addresses specific findings and is independently verifiable.",
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

// #171 — a multi-file changeset reviewed as one artifact. Mirrors the approved
// mockup (session-TTL refresh moved into middleware): 4 files, unified-diff
// hunks, per-file stats, risk chips, and one file already marked reviewed.
export const changesetArtifact: Artifact = {
  id: "art_changeset_001",
  sessionId: "sess_1",
  type: "changeset",
  version: 2,
  parentId: "art_changeset_000",
  title: "Move session-TTL refresh out of the routes and into middleware",
  status: "draft",
  content: {
    summary: "Centralize the sliding-window TTL refresh so every authenticated route inherits it, instead of each route touching the session store by hand.",
    risks: ["touches auth"],
    files: [
      {
        path: "auth/session.ts",
        changeType: "modified",
        stats: { additions: 8, deletions: 5 },
        hunks: [
          {
            header: "@@ -10,6 +10,9 @@ export interface Session {",
            lines: [
              { kind: "ctx", content: "export interface Session {", oldLine: 10, newLine: 10 },
              { kind: "ctx", content: "  id: string;", oldLine: 11, newLine: 11 },
              { kind: "add", content: "  expiresAt: number; // sliding window, refreshed on touch", newLine: 12 },
              { kind: "ctx", content: "}", oldLine: 12, newLine: 13 },
            ],
          },
        ],
      },
      {
        path: "auth/middleware.ts",
        changeType: "modified",
        stats: { additions: 24, deletions: 11 },
        hunks: [
          {
            header: "@@ -24,9 +24,14 @@ export function requireSession(store: SessionStore) {",
            lines: [
              { kind: "ctx", content: "  return async (req, res, next) => {", oldLine: 24, newLine: 24 },
              { kind: "ctx", content: "    const sid = readSessionCookie(req);", oldLine: 25, newLine: 25 },
              { kind: "del", content: "    const session = await store.get(sid);", oldLine: 26 },
              { kind: "del", content: "    if (!session) return res.status(401).end();", oldLine: 27 },
              { kind: "add", content: "    const session = await store.getAndTouch(sid); // refreshes TTL", newLine: 26 },
              { kind: "add", content: "    if (!session || session.expiresAt < Date.now()) {", newLine: 27 },
              { kind: "add", content: "      clearSessionCookie(res);", newLine: 28 },
              { kind: "add", content: "      return res.status(401).end();", newLine: 29 },
              { kind: "add", content: "    }", newLine: 30 },
              { kind: "ctx", content: "    req.session = session;", oldLine: 28, newLine: 31 },
              { kind: "ctx", content: "    next();", oldLine: 29, newLine: 32 },
            ],
          },
        ],
      },
      {
        path: "routes/login.ts",
        changeType: "modified",
        stats: { additions: 3, deletions: 9 },
        hunks: [
          {
            header: "@@ -40,10 +40,4 @@ router.post('/login', async (req, res) => {",
            lines: [
              { kind: "del", content: "  const session = await store.create(user.id);", oldLine: 40 },
              { kind: "del", content: "  scheduleTtlRefresh(session);", oldLine: 41 },
              { kind: "add", content: "  const session = await store.create(user.id); // TTL now handled in middleware", newLine: 40 },
            ],
          },
        ],
      },
      {
        path: "auth/session.test.ts",
        changeType: "added",
        stats: { additions: 51, deletions: 0 },
        hunks: [
          {
            header: "@@ -0,0 +1,5 @@",
            lines: [
              { kind: "add", content: "import { getAndTouch } from './session';", newLine: 1 },
              { kind: "add", content: "test('getAndTouch refreshes the sliding window', async () => {", newLine: 2 },
              { kind: "add", content: "  const s = await getAndTouch(sid);", newLine: 3 },
              { kind: "add", content: "  expect(s.expiresAt).toBeGreaterThan(Date.now());", newLine: 4 },
              { kind: "add", content: "});", newLine: 5 },
            ],
          },
        ],
      },
    ],
    reviewState: {
      "auth/session.ts": "reviewed",
      "routes/login.ts": "reviewed",
    },
  },
  agentReasoning: "Superseded v1 (you asked to keep the sliding window) — the refresh now lives in one middleware instead of every route.",
  createdAt: "2026-04-02T10:20:00.000Z",
  updatedAt: "2026-04-02T10:20:00.000Z",
};

// A cross-file comment binding the TTL constant to the middleware check.
export const changesetCrossFileComment: Comment = {
  id: "cmt_xfile_001",
  sessionId: "sess_1",
  target: {
    artifactId: "art_changeset_001",
    anchors: [
      { filePath: "auth/session.ts", lineStart: 12 },
      { filePath: "auth/middleware.ts", lineStart: 27 },
    ],
  },
  parentCommentId: null,
  author: "human",
  content: "TTL constant and the middleware check must stay in sync.",
  acknowledged: false,
  createdAt: "2026-04-02T10:21:00.000Z",
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

export const evidenceComment: Comment = {
  id: "cmt_004",
  sessionId: "sess_1",
  target: { artifactId: "art_research_001", findingIndex: 0, evidenceIndex: 1 },
  parentCommentId: null,
  author: "human",
  content: "The middleware file also has a similar pattern — can you check if it uses the same bcrypt config?",
  acknowledged: false,
  createdAt: "2026-04-02T10:01:15.000Z",
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
