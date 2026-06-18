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
