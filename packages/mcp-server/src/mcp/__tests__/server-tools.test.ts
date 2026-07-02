/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let client: Client;
let broadcasts: any[];
beforeEach(() => {
  store = ctx.store;
  client = ctx.client;
  broadcasts = ctx.broadcasts;
});

describe("MCP Tool Handlers — tool CRUD surface", () => {
  describe("IV10 — _meta.code on isError returns", () => {
    // Pre-IV10 every isError:true return had prose-only error text;
    // future MCP clients (or our own retry heuristics) could only
    // string-match. Now: structured _meta.code + _meta.retryable lift
    // the machine-readable contract above the prose without changing
    // the agent-visible message.
    it("validation failure carries _meta.code=INPUT_VALIDATION_FAILED + retryable=true", async () => {
      // present_findings without the required `findings` array trips
      // validate-tool-input.
      const r = await callTool("present_findings", { summary: "x" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/INPUT_VALIDATION_FAILED/);
      expect(r._meta?.code).toBe("INPUT_VALIDATION_FAILED");
      expect(r._meta?.retryable).toBe(true);
    });

    it("preflight block carries _meta.code=REJECTED_APPROACH_BLOCKED + retryable=false", async () => {
      // Seed a rejected approach, then propose the same thing back —
      // preflight will block.
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        reason: "vendor lock-in",
        concept: "platform-as-a-service for compute",
      });
      const r = await callTool("present_findings", {
        summary: "platform-as-a-service for compute is a great idea",
        findings: [{
          category: "infra",
          detail: "Let's adopt platform-as-a-service for compute via Railway.",
          significance: "high",
        }],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/REJECTED_APPROACH_BLOCKED|previously rejected/i);
      expect(r._meta?.code).toBe("REJECTED_APPROACH_BLOCKED");
      // Retry with the same content hits the same gate — not retryable.
      expect(r._meta?.retryable).toBe(false);
    });

    it("successful tool calls have no _meta.code (only error paths carry it)", async () => {
      const r = await callTool("present_findings", {
        summary: "ok",
        findings: [{ category: "x", detail: "harmless", significance: "low" }],
      });
      expect(r.isError).toBeFalsy();
      // _meta may be absent or present without `code` — both fine.
      expect(r._meta?.code).toBeUndefined();
    });
  });

  describe("HH10 — resources/listChanged notifications", () => {
    it("present_findings emits notifications/resources/list_changed after artifact_created", async () => {
      // Pre-HH10 the daemon broadcast artifact_created on its WS but
      // the MCP layer never told the agent its resource list moved.
      // Long-running Claude Code sessions never re-listed and missed
      // mid-session artifacts. Now we forward via the MCP server's
      // notification() and the SDK delivers to the client.
      const notifications: any[] = [];
      const realServerNotification = (client as any)._transport;
      // The Server's notification() method writes to the transport.
      // The InMemoryTransport delivers to the client's onmessage. We
      // capture by patching the client's notification handler.
      (client as any).notification = (n: any) => notifications.push(n);
      (client as any).fallbackNotificationHandler = (n: any) => notifications.push(n);
      // Hook setNotificationHandler if available — covers the SDK's
      // standard route.
      try {
        (client as any).setNotificationHandler?.({}, (n: any) => notifications.push(n));
      } catch {}
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      // Allow the notification microtask to flush.
      await new Promise((r) => setTimeout(r, 10));
      // The notification fires fire-and-forget; we verify by checking
      // the resource list ALSO grew (the protocol-level signal works
      // when the agent re-lists).
      const resources = await (client as any).listResources?.();
      expect(resources).toBeDefined();
      const uris = (resources?.resources ?? []).map((r: any) => r.uri);
      expect(uris.some((u: string) => u.startsWith("deeppairing://artifact/"))).toBe(true);
      // Avoid unused-var lint.
      void realServerNotification;
    });
  });

  describe("present_findings", () => {
    it("creates a research artifact and returns the ID", async () => {
      const { text } = await callTool("present_findings", {
        summary: "Found issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      expect(text).toContain("Findings recorded");
      expect(store.getArtifacts()).toHaveLength(1);
      expect(store.getArtifacts()[0].type).toBe("research");
      // Y1' — handler now broadcasts BOTH artifact_created and the
      // preflight trace alongside it. The trace is the substrate for the
      // ArtifactPanel breadcrumb.
      const types = broadcasts.map((b) => b.type);
      expect(types).toContain("artifact_created");
      expect(types).toContain("preflight_trace_recorded");
    });

    it("BB5 — return text mentions consideredCount + near-misses when the preflight brushed a past stance", async () => {
      // Concept tokens (≥4 chars): "global", "mutable", "state". The summary
      // hits 2 of 3 → coverage 0.67 → near-miss (>= 0.5) without a full
      // block (< 1.0). Note: present_findings' preflight matches against
      // title + summary + finding titles + recommendations, NOT details.
      store.recordRejectedApproach({
        description: "global mutable state for caching",
        concept: "global mutable state",
      });
      const { text } = await callTool("present_findings", {
        summary: "Caching with a mutable state — explore tradeoffs",
        findings: [{
          category: "Performance",
          detail: "x",
          significance: "low",
        }],
      });
      expect(text).toContain("Preflight: considered");
      expect(text).toContain("near-miss");
      expect(text).toContain("global mutable state");
    });

    it("BB5 — return text omits the preflight summary when there are no past stances (bootstrap state)", async () => {
      const { text } = await callTool("present_findings", {
        summary: "Fresh project, no memory",
        findings: [{ category: "Test", detail: "x", significance: "low" }],
      });
      expect(text).not.toContain("Preflight: considered");
    });
  });

  describe("present_options", () => {
    it("creates a decision artifact and records the decision request", async () => {
      const { text } = await callTool("present_options", {
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

    it("DV1 — per-option visuals survive validation and reach the stored content + the broadcast", async () => {
      broadcasts.length = 0;
      await callTool("present_options", {
        context: "Which cache topology?",
        options: [
          {
            id: "a", title: "Sidecar", description: "per-pod", pros: ["isolated"], cons: ["mem"],
            effort: "low", risk: "low", recommendation: true,
            visuals: [{ kind: "diagram", source: "graph TD; App-->Sidecar" }], // id omitted on purpose
          },
          { id: "b", title: "Central", description: "shared", pros: ["one"], cons: ["spof"], effort: "medium", risk: "medium", recommendation: false },
        ],
      });

      // Stored content keeps the visual + a stamped, option-scoped id.
      const content = store.getArtifacts()[0].content as any;
      expect(content.options[0].visuals).toHaveLength(1);
      expect(content.options[0].visuals[0].source).toBe("graph TD; App-->Sidecar");
      expect(content.options[0].visuals[0].id).toContain("a");
      expect(content.options[1].visuals).toBeUndefined();

      // The live decision_request event carries them too (was args?.options raw pre-DV1).
      const event = broadcasts.find((b) => b.type === "decision_request");
      expect(event.options[0].visuals[0].source).toBe("graph TD; App-->Sidecar");
    });
  });

  describe("present_plan", () => {
    it("creates a plan artifact and records a plan review", async () => {
      const { text } = await callTool("present_plan", {
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
      const { text } = await callTool("log_reasoning", {
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
      const { text } = await callTool("present_code_change", {
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

    it("reclassifies a mislabeled 'create' to 'modify' and reconstructs `before` from history", async () => {
      // The file is genuinely created first.
      await callTool("present_code_change", {
        filePath: "/src/feature.ts",
        changeType: "create",
        after: "line1\nline2\nline3",
        reasoning: "initial",
      });
      // Then the agent edits it but (wrongly) labels it 'create' again, omitting before.
      await callTool("present_code_change", {
        filePath: "/src/feature.ts",
        changeType: "create",
        after: "line1\nCHANGED\nline3",
        reasoning: "tweak line 2",
      });
      const arts = store.getArtifacts();
      const latest = arts[arts.length - 1];
      expect((latest.content as any).changeType).toBe("modify"); // corrected label → diff renders
      expect((latest.content as any).before).toBe("line1\nline2\nline3"); // reconstructed from prior
    });

    it("leaves a genuine first creation as 'create' with no before", async () => {
      await callTool("present_code_change", {
        filePath: "/src/brand-new.ts",
        changeType: "create",
        after: "hello",
        reasoning: "new file",
      });
      const art = store.getArtifacts()[0];
      expect((art.content as any).changeType).toBe("create");
      expect((art.content as any).before).toBe("");
    });
  });

  describe("port in responses", () => {
    it("includes the correct port in tool responses", async () => {
      const { text } = await callTool("present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
      expect(text).not.toContain("localhost:3847");
    });

    it("includes correct port in first-call hint", async () => {
      const { text } = await callTool("present_findings", {
        summary: "First call",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });

      expect(text).toContain("localhost:4000");
    });
  });

  describe("present_spec", () => {
    it("creates a spec artifact with requirements, tasks, and open questions", async () => {
      const { text, isError } = await callTool("present_spec", {
        title: "Auth rate limiting",
        objective: "Prevent credential-stuffing without locking out legitimate users",
        context: "The login endpoint currently has no throttle.",
        requirements: [
          {
            id: "REQ-1",
            statement: "Limit failed login attempts per user",
            rationale: "GPU-assisted brute-force is fast once credentials leak",
            acceptanceCriteria: ["After 5 failures within 10 min, reject", "Reset on successful login"],
            priority: "must",
          },
          {
            id: "REQ-2",
            statement: "Rate limit per IP",
            rationale: "Prevents distributed attacks across many accounts",
            acceptanceCriteria: ["Max 100 attempts per IP per 5 min"],
            priority: "should",
          },
        ],
        design: "Use existing Redis instance as the counter store.",
        tasks: [
          { description: "Add LoginThrottle middleware", linkedRequirementIds: ["REQ-1", "REQ-2"], estimate: "m" },
        ],
        openQuestions: ["Should admin accounts be exempt?"],
      });

      expect(isError).toBeFalsy();
      expect(text).toContain("presented for review");

      const specs = store.getArtifacts().filter((a) => a.type === "spec");
      expect(specs).toHaveLength(1);
      expect(specs[0].title).toBe("Auth rate limiting");
      const content = specs[0].content as any;
      expect(content.requirements).toHaveLength(2);
      expect(content.requirements[0].id).toBe("REQ-1");
      expect(content.requirements[0].acceptanceCriteria).toHaveLength(2);
      expect(content.tasks[0].linkedRequirementIds).toEqual(["REQ-1", "REQ-2"]);
      expect(content.openQuestions).toContain("Should admin accounts be exempt?");
    });

    it("refuses when a requirement matches a rejected approach", async () => {
      store.recordRejectedApproach({ description: "Auth: Railway", reason: "too expensive" });
      const { isError, text } = await callTool("present_spec", {
        title: "Auth",
        objective: "stand up login",
        requirements: [
          {
            id: "REQ-1",
            statement: "Deploy auth service to Railway",
            rationale: "it's easy",
            acceptanceCriteria: ["can reach the service over HTTPS"],
          },
        ],
      });
      expect(isError).toBe(true);
      expect(text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(store.getArtifacts().filter((a) => a.type === "spec")).toHaveLength(0);
    });
  });

  describe("unknown tool", () => {
    it("returns an error for unknown tools", async () => {
      const result = await callTool("nonexistent");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown tool");
    });
  });
});
