/**
 * Pin the field-bug that motivated validate-tool-input.ts: the agent
 * passed `findings: "<long string>"` to present_findings instead of
 * `findings: [{...}, {...}]`. The store recorded the raw string. The UI
 * later iterated the string character-by-character (1610 single-character
 * "findings"), threw inside ResearchArtifact, and the ErrorBoundary
 * blanked the artifact. The agent had no idea anything was wrong because
 * the tool returned success.
 *
 * After the fix:
 *   - The malformed shape is REJECTED at the tool boundary.
 *   - The artifact is NEVER created.
 *   - The agent gets a structured INPUT_VALIDATION_FAILED message naming
 *     the bad path + a correct-shape example so it can fix and retry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let client: Client;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-validate-input-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "validate_input_session");
  const { server } = createMcpServer(store, () => {}, 4000);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(c);
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

async function call(name: string, args: any) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as any[])?.[0]?.text ?? "";
  return { text, isError: res.isError };
}

describe("Tool-input validation at the write boundary", () => {
  it("present_findings rejects a string `findings` (the actual field bug)", async () => {
    const { text, isError } = await call("present_findings", {
      title: "Sanity check",
      summary: "26/26 face-presence",
      findings: "26/26 selfies passed face detection",  // ← was caught char-by-char before
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toContain("findings");
    // Artifact must NOT have been created.
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("present_findings rejects findings missing required fields and names the bad path", async () => {
    const { text, isError } = await call("present_findings", {
      summary: "x",
      findings: [{ /* category, detail, significance all missing */ }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toMatch(/findings\.0\.(category|detail|significance)/);
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("error message includes a correct-shape example so the agent can retry", async () => {
    const { text } = await call("present_findings", {
      summary: "x",
      findings: "wrong",
    });
    expect(text).toMatch(/Expected shape/i);
    expect(text).toMatch(/significance/);
    expect(text).toMatch(/Fix the input and call present_findings again/);
  });

  it("present_findings ACCEPTS a valid finding without `evidence` (it's optional)", async () => {
    // High-level architectural findings often have no code evidence to
    // attach. Validation must not force every finding to carry one.
    const { isError } = await call("present_findings", {
      summary: "Architecture concern",
      findings: [{ category: "architecture", detail: "Auth and billing share a transaction", significance: "high" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("present_findings PERSISTS a finding's `confidence` (C-1 — schema must model what the tool advertises)", async () => {
    // The tool's JSON schema accepts `confidence` and the UI renders a badge,
    // but the non-strict validation boundary used to strip it before persist
    // because FindingSchema didn't model it. Now it must survive to disk.
    const { isError } = await call("present_findings", {
      summary: "s",
      findings: [{ category: "perf", detail: "N+1", significance: "high", confidence: "high" }],
    });
    expect(isError).toBeFalsy();
    const content = store.getArtifacts()[0].content as { findings: Array<{ confidence?: string }> };
    expect(content.findings[0].confidence).toBe("high");
  });

  it("present_options rejects fewer than 2 options (decisions need a real choice)", async () => {
    const { text, isError } = await call("present_options", {
      context: "Pick something",
      options: [
        { id: "a", title: "Only one", description: "x", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
      ],
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toContain("options");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("present_options rejects an option missing required fields", async () => {
    const { text, isError } = await call("present_options", {
      context: "x",
      options: [
        { id: "a", title: "A", description: "x", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
        { id: "b" /* missing title, description, pros, cons, effort, risk, recommendation */ },
      ],
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/options\.1\./);
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("present_plan rejects steps that are a string instead of an array", async () => {
    const { text, isError } = await call("present_plan", {
      title: "Plan",
      estimatedChanges: 3,
      steps: "do the thing then the other thing",
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toMatch(/steps/);
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("present_plan ACCEPTS a step without `files` (e.g. 'run tests')", async () => {
    const { isError } = await call("present_plan", {
      title: "Plan",
      estimatedChanges: 1,
      steps: [{ description: "Run the test suite", reasoning: "verify nothing broke" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("present_plan PERSISTS a step's `condition`/`branches` (C-1 — schema must model what the tool advertises)", async () => {
    // present_plan accepts conditional branches and the renderer displays
    // them, but the non-strict boundary used to strip them before persist
    // because PlanStepSchema didn't model them. Now they must survive to disk.
    const { isError } = await call("present_plan", {
      title: "Plan",
      estimatedChanges: 1,
      steps: [
        {
          description: "Run tests, then branch",
          reasoning: "gate the next move on the result",
          condition: "if tests pass",
          branches: [{ description: "ship it", reasoning: "green build", files: ["release.ts"] }],
        },
      ],
    });
    expect(isError).toBeFalsy();
    const content = store.getArtifacts()[0].content as {
      steps: Array<{ condition?: string; branches?: Array<{ description: string; files?: string[] }> }>;
    };
    expect(content.steps[0].condition).toBe("if tests pass");
    expect(content.steps[0].branches?.[0]).toMatchObject({ description: "ship it", files: ["release.ts"] });
  });

  it("present_plan PERSISTS `visuals` (diagram + file_map) so the planning UI can render them", async () => {
    const { isError } = await call("present_plan", {
      title: "Plan with visuals",
      estimatedChanges: 2,
      steps: [{ description: "do it", reasoning: "because" }],
      visuals: [
        { id: "arch", kind: "diagram", title: "Architecture", source: "graph TD; UI-->API-->DB" },
        { id: "files", kind: "file_map", files: [{ path: "src/api.ts", change: "create", note: "new route" }] },
      ],
    });
    expect(isError).toBeFalsy();
    const content = store.getArtifacts()[0].content as {
      visuals?: Array<{ id: string; kind: string; source?: string; files?: Array<{ path: string }> }>;
    };
    expect(content.visuals).toHaveLength(2);
    expect(content.visuals![0]).toMatchObject({ id: "arch", kind: "diagram", source: "graph TD; UI-->API-->DB" });
    expect(content.visuals![1].files?.[0]).toMatchObject({ path: "src/api.ts", change: "create" });
  });

  it("present_plan PERSISTS an `annotated_code` visual (code + line annotations survive the validation boundary)", async () => {
    const { isError } = await call("present_plan", {
      title: "Plan with annotated code",
      estimatedChanges: 1,
      steps: [{ description: "do it", reasoning: "because" }],
      visuals: [
        {
          id: "ac",
          kind: "annotated_code",
          title: "The hot path",
          code: "function f() {\n  return cache.get(k);\n}",
          filePath: "src/cache.ts",
          lineStart: 12,
          annotations: [{ line: 13, note: "add a TTL check here", kind: "change" }],
        },
      ],
    });
    expect(isError).toBeFalsy();
    const content = store.getArtifacts()[0].content as {
      visuals?: Array<{ id: string; kind: string; code?: string; filePath?: string; lineStart?: number; annotations?: Array<{ line: number; note: string; kind?: string }> }>;
    };
    expect(content.visuals).toHaveLength(1);
    expect(content.visuals![0]).toMatchObject({
      id: "ac",
      kind: "annotated_code",
      code: "function f() {\n  return cache.get(k);\n}",
      filePath: "src/cache.ts",
      lineStart: 12,
    });
    expect(content.visuals![0].annotations?.[0]).toMatchObject({ line: 13, note: "add a TTL check here", kind: "change" });
  });

  it("present_plan NUDGES toward revise_artifact when a live plan with a similar title already exists", async () => {
    await call("present_plan", { title: "Add realtime notifications", estimatedChanges: 2, steps: [{ description: "ws gateway", reasoning: "push" }] });
    const first = store.getArtifacts()[0];
    const { text, isError } = await call("present_plan", {
      title: "Add realtime notifications", // re-post (a revision masquerading as a fresh plan)
      estimatedChanges: 3,
      steps: [{ description: "ws gateway via worker", reasoning: "push" }],
    });
    expect(isError).toBeFalsy(); // advisory — the artifact is still created
    expect(text).toMatch(/revise_artifact/);
    expect(text).toContain(first.id); // hands the agent the id to supersede
  });

  it("present_plan does NOT nudge for a genuinely unrelated new plan", async () => {
    await call("present_plan", { title: "Add realtime notifications", estimatedChanges: 2, steps: [{ description: "ws", reasoning: "push" }] });
    const { text } = await call("present_plan", {
      title: "Migrate billing to Stripe",
      estimatedChanges: 4,
      steps: [{ description: "stripe sdk", reasoning: "payments" }],
    });
    expect(text).not.toMatch(/revise_artifact/);
  });

  it("present_code_change rejects missing required fields (filePath, changeType, after, reasoning)", async () => {
    const { text, isError } = await call("present_code_change", {
      // filePath missing
      after: "x = 2;",
      reasoning: "fix",
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toContain("filePath");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("log_reasoning rejects when both `action` and `reasoning` are missing", async () => {
    const { text, isError } = await call("log_reasoning", {
      // action missing, reasoning missing
      confidence: "high",
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toMatch(/action|reasoning/);
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("log_reasoning advertises `confidence` as optional (C-1 — was wrongly in required)", async () => {
    // The JSON schema marked confidence required while the description and the
    // Zod schema both call it optional — a strict MCP client would reject valid
    // calls. The advertised contract must match.
    const { tools } = await client.listTools();
    const lr = tools.find((t) => t.name === "log_reasoning");
    expect(lr?.inputSchema?.required).toEqual(["action", "reasoning"]);
  });

  it("log_reasoning ACCEPTS a call without `confidence`", async () => {
    const { isError } = await call("log_reasoning", {
      action: "refactor the parser",
      reasoning: "the current one is unreadable",
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("present_spec rejects a string `requirements` field", async () => {
    const { text, isError } = await call("present_spec", {
      title: "Rate limit",
      objective: "Block credential stuffing",
      requirements: "Limit /login to 5/min",
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).toContain("requirements");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("present_spec PERSISTS `visuals` (specs are a planning surface too)", async () => {
    const { isError } = await call("present_spec", {
      title: "Auth rate limiting",
      objective: "Block credential stuffing",
      requirements: [{ id: "R1", statement: "limit /login", rationale: "stop brute force", acceptanceCriteria: ["429 after 5"] }],
      visuals: [{ id: "flow", kind: "diagram", title: "Request flow", source: "sequenceDiagram; Client->>API: login" }],
    });
    expect(isError).toBeFalsy();
    const content = store.getArtifacts()[0].content as { visuals?: Array<{ id: string; source?: string }> };
    expect(content.visuals?.[0]).toMatchObject({ id: "flow", source: "sequenceDiagram; Client->>API: login" });
  });
});

// ---------------------------------------------------------------------------
// #183 — EXAMPLE-ECHO GUARD.
//
// Field bug (hit in a real session): the agent's present_options failed schema
// validation, the INPUT_VALIDATION_FAILED message embedded the EXAMPLE_OPTIONS
// sample ("Which cache layer?" / Redis / In-memory LRU), and the agent echoed
// that sample VERBATIM as a real call — twice — minting junk draft decisions.
// The guard rejects a schema-valid payload whose distinctive content matches a
// teaching example, WITHOUT blocking real artifacts that merely mention the
// same domain (caches/Redis) in prose.
// ---------------------------------------------------------------------------

// The EXAMPLE_OPTIONS payload, exactly as an echoing agent would replay it.
const OPTIONS_EXAMPLE_ARGS = {
  context: "Which cache layer?",
  options: [
    { id: "a", title: "Redis", description: "...", pros: ["fast"], cons: ["another service"], effort: "medium", risk: "low", recommendation: true, concept: { name: "external cache service", oneLineExplanation: "in-process is faster but loses on multi-instance" } },
    { id: "b", title: "In-memory LRU", description: "...", pros: ["simple"], cons: ["per-instance"], effort: "low", risk: "medium", recommendation: false, concept: { name: "in-process LRU", oneLineExplanation: "no network hop; each instance keeps its own copy" } },
  ],
};

describe("#183 — example-echo guard", () => {
  it("REJECTS a verbatim echo of the present_options example with a pointed message and creates NO artifact", async () => {
    const { text, isError } = await call("present_options", OPTIONS_EXAMPLE_ARGS);
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    // Pointed, second-person-to-the-agent phrasing.
    expect(text).toMatch(/this is the EXAMPLE payload/i);
    expect(text).toMatch(/not your real content/i);
    expect(text).toMatch(/replace every value with your actual/i);
    expect(text).toMatch(/artifact was NOT created/i);
    // The junk draft decision the real bug created must NOT exist.
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("attaches _meta.code = EXAMPLE_ECHO_REJECTED (retryable) so MCP clients can branch", async () => {
    const res = await client.callTool({ name: "present_options", arguments: OPTIONS_EXAMPLE_ARGS });
    const meta = (res as { _meta?: { code?: string; retryable?: boolean } })._meta;
    expect(meta?.code).toBe("EXAMPLE_ECHO_REJECTED");
    expect(meta?.retryable).toBe(true);
  });

  it("REJECTS a trivially-normalized echo: same context different case, different options", async () => {
    const { isError, text } = await call("present_options", {
      context: "  WHICH CACHE LAYER?  ", // trim + case only
      options: [
        { id: "x", title: "Totally different", description: "d", pros: ["p"], cons: ["c"], effort: "low", risk: "low", recommendation: true },
        { id: "y", title: "Also different", description: "d", pros: ["p"], cons: ["c"], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("still REJECTS the incident's follow-up call: SAME context, an extra Memcached option added (context scalar catches it)", async () => {
    // The real incident's call #2 kept the echoed context and appended a third
    // option. The context scalar alone must still catch it — this is exactly
    // why the (removed) option-title-set arm was never load-bearing.
    const { isError, text } = await call("present_options", {
      context: "Which cache layer?", // verbatim example context
      options: [
        { id: "a", title: "Redis", description: "d", pros: ["fast"], cons: ["svc"], effort: "medium", risk: "low", recommendation: true },
        { id: "b", title: "In-memory LRU", description: "d", pros: ["simple"], cons: ["per-instance"], effort: "low", risk: "medium", recommendation: false },
        { id: "c", title: "Memcached", description: "added on retry", pros: ["mature"], cons: ["fewer types"], effort: "medium", risk: "low", recommendation: false },
      ],
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("ADMITS a REAL decision with a genuinely different context whose options are titled EXACTLY Redis + In-memory LRU (A1 — the canonical cache card, NOT an echo)", async () => {
    // Post-review probe A1: the two-option caching decision is the single most
    // common real decision in the wild — options titled exactly Redis /
    // In-memory LRU. With a real, different question it MUST be admitted; the
    // old option-title-set arm bounced this legitimate human card.
    const { isError } = await call("present_options", {
      context: "Where should the rate-limiter counter store live for our multi-instance API?",
      options: [
        { id: "a", title: "Redis", description: "shared counter across instances", pros: ["consistent"], cons: ["network hop"], effort: "medium", risk: "low", recommendation: true },
        { id: "b", title: "In-memory LRU", description: "per-instance counter", pros: ["fast"], cons: ["drifts across instances"], effort: "low", risk: "medium", recommendation: false },
      ],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("ADMITS a REAL cache decision that mentions Redis/caches in prose but has a different context AND options", async () => {
    const { isError } = await call("present_options", {
      context: "Should the session cache be Redis, Postgres, or DynamoDB for our multi-region rollout?",
      options: [
        { id: "a", title: "Redis Cluster", description: "sharded redis for the cache layer", pros: ["fast"], cons: ["ops"], effort: "medium", risk: "low", recommendation: true },
        { id: "b", title: "Postgres UNLOGGED table", description: "reuse the db as a cache", pros: ["one system"], cons: ["slower"], effort: "low", risk: "medium", recommendation: false },
        { id: "c", title: "DynamoDB", description: "managed cache", pros: ["no ops"], cons: ["cost"], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("ADMITS a two-option cache decision when neither the context NOR the option-title set matches the example", async () => {
    const { isError } = await call("present_options", {
      context: "Which cache eviction policy for the LRU?", // mentions cache + LRU, different question
      options: [
        { id: "a", title: "LFU eviction", description: "least frequently used", pros: ["hit rate"], cons: ["complex"], effort: "medium", risk: "low", recommendation: true },
        { id: "b", title: "TTL-only", description: "simple expiry", pros: ["simple"], cons: ["cold"], effort: "low", risk: "low", recommendation: false },
      ],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("REJECTS the present_findings example (summary AND finding-title set both match) end-to-end", async () => {
    const { text, isError } = await call("present_findings", {
      title: "Auth audit",
      summary: "Two issues in auth.ts",
      findings: [{ category: "security", title: "Weak password hash", detail: "bcrypt rounds=4 is too low", evidence: "auth.ts L23 uses bcrypt.hash(pw, 4)", significance: "high", recommendation: "raise to 12+" }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("ADMITS a real auth finding that discusses bcrypt but isn't the example", async () => {
    const { isError } = await call("present_findings", {
      summary: "One real weakness in the password path",
      findings: [{ category: "security", title: "Timing-unsafe compare", detail: "== on the bcrypt hash leaks timing", significance: "medium" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("ADMITS a real audit with a DIFFERENT summary but a single finding titled exactly 'Weak password hash' (A3 — title set alone must not suffice)", async () => {
    // Post-review probe A3: reusing just a finding title (a genuinely common
    // one) with a real, different summary must be admitted.
    const { isError } = await call("present_findings", {
      summary: "Password storage review of the new signup flow",
      findings: [{ category: "security", title: "Weak password hash", detail: "argon2 params below OWASP floor", significance: "high" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("REJECTS the present_plan example (title AND step-description set both match) end-to-end", async () => {
    const { text, isError } = await call("present_plan", {
      title: "Add rate limiting",
      estimatedChanges: 3,
      steps: [{ description: "Install limiter middleware", reasoning: "...", files: ["packages/api/middleware/limit.ts"] }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("ADMITS a real plan titled exactly 'Add rate limiting' with DIFFERENT steps (A4 — the common title must not suffice alone)", async () => {
    // Post-review probe A4: "Add rate limiting" is an extremely common exact
    // title. A real plan with different steps must be admitted.
    const { isError } = await call("present_plan", {
      title: "Add rate limiting",
      estimatedChanges: 2,
      steps: [
        { description: "Add a token-bucket to the API gateway", reasoning: "central chokepoint" },
        { description: "Wire per-tenant quotas from config", reasoning: "fairness" },
      ],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("ADMITS a real plan whose single step is exactly 'Install limiter middleware' under a DIFFERENT title (A5 — step set alone must not suffice)", async () => {
    // Post-review probe A5: reusing the example step under a real, different
    // title must be admitted.
    const { isError } = await call("present_plan", {
      title: "Harden the public API surface",
      estimatedChanges: 1,
      steps: [{ description: "Install limiter middleware", reasoning: "block abusive clients" }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("REJECTS the present_code_change example (filePath+before+after tuple) end-to-end", async () => {
    const { text, isError } = await call("present_code_change", {
      filePath: "packages/api/auth.ts",
      changeType: "modify",
      before: "bcrypt.hash(pw, 4)",
      after: "bcrypt.hash(pw, 12)",
      reasoning: "Raise cost factor; rounds=4 is brute-forceable in <1 day",
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("ADMITS a real code_change that shares the example's before/after but a DIFFERENT file (AND-tuple precision)", async () => {
    const { isError } = await call("present_code_change", {
      filePath: "services/worker/hash.ts", // not the example file
      changeType: "modify",
      before: "bcrypt.hash(pw, 4)",
      after: "bcrypt.hash(pw, 12)",
      reasoning: "same class of fix, real different file",
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("REJECTS the log_reasoning example (action fingerprint) end-to-end", async () => {
    const { text, isError } = await call("log_reasoning", {
      action: "extract DI for the cache",
      reasoning: "tests need to swap Redis for an in-memory fake",
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("REJECTS the present_spec example (title AND requirement-statement set both match) end-to-end", async () => {
    const { text, isError } = await call("present_spec", {
      title: "Rate limit auth endpoints",
      objective: "Block credential stuffing",
      requirements: [{ id: "REQ-1", statement: "Limit /login to 5 attempts/min per IP", rationale: "Slows brute-force without harming real users", acceptanceCriteria: ["6th attempt within 60s returns 429"] }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("ADMITS a real spec that reuses the example OBJECTIVE but has a different title + requirements (objective is NOT a fingerprint)", async () => {
    const { isError } = await call("present_spec", {
      title: "Harden the login endpoint", // not the example title
      objective: "Block credential stuffing", // deliberately the example objective
      requirements: [{ id: "R1", statement: "Add a CAPTCHA after 3 failures", rationale: "raise attacker cost", acceptanceCriteria: ["CAPTCHA shown on 4th attempt"] }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("ADMITS a real spec that reuses the example TITLE but has different requirements (title alone must not suffice)", async () => {
    // Post-review consistency: spec now requires title AND the requirement set,
    // so reusing just the title with real requirements is admitted.
    const { isError } = await call("present_spec", {
      title: "Rate limit auth endpoints", // deliberately the example title
      objective: "Stop token-endpoint abuse",
      requirements: [{ id: "R1", statement: "Cap /oauth/token to 20/min per client_id", rationale: "protect the IdP", acceptanceCriteria: ["21st call in 60s returns 429"] }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });

  it("REJECTS the present_changeset example (title fingerprint) end-to-end", async () => {
    const { text, isError } = await call("present_changeset", {
      title: "Move session-TTL refresh into middleware",
      summary: "anything",
      files: [{ path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }],
    });
    expect(isError).toBe(true);
    expect(text).toContain("EXAMPLE_ECHO_REJECTED");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("ADMITS a real changeset that reuses the example SUMMARY but a different title (summary is NOT a fingerprint)", async () => {
    const { isError } = await call("present_changeset", {
      title: "Move TTL refresh into middleware", // no "session-" — differs from the example title
      summary: "Centralize the sliding-window refresh", // deliberately the example summary
      files: [{ path: "auth/middleware.ts", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: "x", newLine: 1 }] }] }],
    });
    expect(isError).toBeFalsy();
    expect(store.getArtifacts()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #184 — TRUNCATED tool-call detection (the ROOT cause upstream of the echo).
//
// `context`/`summary` streams before the required array; the model's turn is
// cut off mid-call → the earlier field arrives, the array is undefined. That
// specific shape gets a dedicated TOOL_CALL_TRUNCATED error carrying NO
// embedded example (so it can't seed the echo). Every OTHER schema mismatch
// keeps the generic, example-bearing INPUT_VALIDATION_FAILED error.
// ---------------------------------------------------------------------------
describe("#184 — truncated tool-call detection", () => {
  const LONG_CONTEXT =
    "We need to choose a caching strategy for the session store given our " +
    "multi-region rollout and the read-heavy access pattern, weighing latency, " +
    "operational cost, and consistency across instances.".repeat(3);

  it("REJECTS present_options with context present but options TRUNCATED away — TOOL_CALL_TRUNCATED, NO embedded example", async () => {
    const { text, isError } = await call("present_options", {
      context: LONG_CONTEXT,
      // options truncated away mid-stream
    });
    expect(isError).toBe(true);
    expect(text).toContain("TOOL_CALL_TRUNCATED");
    expect(text).toMatch(/truncated in transit/i);
    expect(text).toMatch(/`options` is missing while `context` is present/);
    // CRUCIAL: the echo-able example must NOT be in this path.
    expect(text).not.toContain("Which cache layer?");
    expect(text).not.toContain("In-memory LRU");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("attaches _meta.code = TOOL_CALL_TRUNCATED (retryable)", async () => {
    const res = await client.callTool({ name: "present_options", arguments: { context: LONG_CONTEXT } });
    const meta = (res as { _meta?: { code?: string; retryable?: boolean } })._meta;
    expect(meta?.code).toBe("TOOL_CALL_TRUNCATED");
    expect(meta?.retryable).toBe(true);
  });

  it("KEEPS the generic example-bearing error when BOTH context AND options are missing (agent just malformed the call)", async () => {
    const { text, isError } = await call("present_options", {
      // neither context nor options — not a truncation signature
      stakes: "low",
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).not.toContain("TOOL_CALL_TRUNCATED");
    // The generic path still teaches the shape with the example.
    expect(text).toContain("Which cache layer?");
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("REJECTS present_findings with summary present but findings TRUNCATED away — TOOL_CALL_TRUNCATED (second tool)", async () => {
    const { text, isError } = await call("present_findings", {
      summary: "A long audit summary describing several issues in the auth subsystem",
      // findings truncated away
    });
    expect(isError).toBe(true);
    expect(text).toContain("TOOL_CALL_TRUNCATED");
    expect(text).toMatch(/`findings` is missing while `summary` is present/);
    expect(store.getArtifacts()).toHaveLength(0);
  });

  it("does NOT treat a present-but-wrong-type array as truncation (findings as a string → generic example error)", async () => {
    const { text, isError } = await call("present_findings", {
      summary: "x",
      findings: "26/26 selfies passed face detection", // present, wrong type — the classic field bug
    });
    expect(isError).toBe(true);
    expect(text).toContain("INPUT_VALIDATION_FAILED");
    expect(text).not.toContain("TOOL_CALL_TRUNCATED");
    expect(store.getArtifacts()).toHaveLength(0);
  });
});
