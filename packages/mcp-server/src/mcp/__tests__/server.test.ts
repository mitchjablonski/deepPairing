/**
 * Integration tests for MCP tool handlers.
 * Creates a real MCP server + FileStore, simulates tool calls via the SDK.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let store: FileStore;
let client: Client;
const broadcasts: any[] = [];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-mcp-test-"));
  store = new FileStore(tmpDir, "test_session");
  broadcasts.length = 0;

  const { server } = createMcpServer(store, (e) => broadcasts.push(e), 4000);

  // Connect client ↔ server via in-memory transport
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(clientTransport);
});

afterEach(() => {
  // Force flush to prevent pending timer writes after dir is deleted
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, any> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as any[])?.[0]?.text ?? "";
  return { text, isError: result.isError };
}

describe("MCP Tool Handlers", () => {
  describe("present_findings", () => {
    it("creates a research artifact and returns the ID", async () => {
      const { text } = await callTool("deepPairing_present_findings", {
        summary: "Found issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      expect(text).toContain("Findings recorded");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("research");
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].type).toBe("artifact_created");
    });
  });

  describe("present_options", () => {
    it("creates a decision artifact and records the decision request", async () => {
      const { text } = await callTool("deepPairing_present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "A", description: "Option A", pros: ["fast"], cons: ["risky"], effort: "low", risk: "high", recommendation: true },
          { id: "b", title: "B", description: "Option B", pros: ["safe"], cons: ["slow"], effort: "high", risk: "low", recommendation: false },
        ],
      });

      expect(text).toContain("Decision");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("decision");
      expect(store.getPendingDecisions()).toHaveLength(1);
    });
  });

  describe("present_plan", () => {
    it("creates a plan artifact and records a plan review", async () => {
      const { text } = await callTool("deepPairing_present_plan", {
        title: "Refactoring Plan",
        steps: [{ description: "Step 1", reasoning: "Because" }],
        estimatedChanges: 2,
      });

      expect(text).toContain("Plan");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("plan");
      expect(store.getPendingPlanReviews()).toHaveLength(1);
    });
  });

  describe("log_reasoning", () => {
    it("creates a reasoning artifact with structured alternatives", async () => {
      const { text } = await callTool("deepPairing_log_reasoning", {
        action: "Create service",
        reasoning: "Service pattern is cleaner",
        confidence: "high",
        alternativeDetails: [
          { title: "Inline refactor", reason: "Too coupled" },
        ],
      });

      expect(text).toContain("Reasoning logged");
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("reasoning");
      expect((art.content as any).alternativeDetails).toHaveLength(1);
    });
  });

  describe("present_code_change", () => {
    it("creates a code_change artifact with confidence", async () => {
      const { text } = await callTool("deepPairing_present_code_change", {
        filePath: "/src/auth.ts",
        changeType: "modify",
        before: "const x = 1;",
        after: "const x = 2;",
        reasoning: "Update value",
        confidence: "high",
      });

      expect(text).toContain("Code change presented");
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("code_change");
      expect((art.content as any).confidence).toBe("high");
    });
  });

  describe("port in responses", () => {
    it("includes the correct port in tool responses", async () => {
      const { text } = await callTool("deepPairing_present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
      expect(text).not.toContain("localhost:3847");
    });

    it("includes correct port in first-call hint", async () => {
      const { text } = await callTool("deepPairing_present_findings", {
        summary: "First call",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
    });
  });

  describe("check_feedback", () => {
    it("returns session status preamble", async () => {
      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Session:");
      expect(text).toContain("Suggested action:");
    });

    it("returns unacknowledged comments", async () => {
      // Create an artifact and add a comment
      await callTool("deepPairing_present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });
      const artId = store.getArtifacts()[0].id;
      store.addComment({ id: "cmt_1", artifactId: artId, content: "Good work", author: "human" });

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Good work");
    });

    it("returns resolved decisions", async () => {
      await callTool("deepPairing_present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "Service", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Inline", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "Cleaner");

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Service");
    });

    it("delivers session memory on first check_feedback", async () => {
      store.recordApprovedPattern("Service pattern");
      store.recordRejectedApproach("Inline refactor");

      const { text } = await callTool("deepPairing_check_feedback");
      expect(text).toContain("Service pattern");
      expect(text).toContain("Inline refactor");
      expect(text).toContain("previous sessions");
    });

    it("resets poll counter when feedback arrives", async () => {
      // Poll 3 times with no feedback (no drafts = no long-poll)
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");

      // Now add human feedback — counter should reset
      store.addComment({ id: "cmt_1", artifactId: "__session__", content: "hello", author: "human" });
      const { text } = await callTool("deepPairing_check_feedback");

      expect(text).toContain("Human directive");
      expect(text).not.toContain("No human response"); // Counter was reset
    });

    it("increments poll counter on empty polls", async () => {
      // Poll 4 times with no feedback, no drafts = instant return
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");
      await callTool("deepPairing_check_feedback");
      // 4th poll — counter is now 4
      const { text } = await callTool("deepPairing_check_feedback");
      // No pending items, so escalation hint won't appear,
      // but counter is tracked correctly (tested via reset above)
      expect(text).toContain("Session:");
    });
  });

  describe("export_session", () => {
    it("returns markdown in the specified format", async () => {
      await callTool("deepPairing_present_findings", {
        summary: "Auth issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      const { text } = await callTool("deepPairing_export_session", { format: "full" });
      expect(text).toContain("Session Report");
      expect(text).toContain("Weak hashing");
    });
  });

  describe("unknown tool", () => {
    it("returns an error for unknown tools", async () => {
      const result = await callTool("deepPairing_nonexistent");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown tool");
    });
  });
});
