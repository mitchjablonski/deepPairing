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
});
