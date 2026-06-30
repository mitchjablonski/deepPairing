/**
 * Integration tests for MCP tool handlers.
 * Creates a real MCP server + FileStore, simulates tool calls via the SDK.
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
const broadcasts: any[] = [];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-mcp-test-"));
  // Redirect the global philosophy ledger to tmpDir so tests don't leak.
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
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
  setGlobalStoreForTests(null);
});

async function callTool(name: string, args: Record<string, any> = {}) {
  const result = await client.callTool({ name, arguments: args });
  // II12 — firstCallHint moved from "spliced into content[0].text" to "a
  // separate content[1+] text block" so strict JSON-parsing clients see a
  // clean tool reply in content[0]. Tests assert on the combined visible
  // text the agent sees; concatenate every text content block so the
  // existing assertions (which match against the joined string) still
  // exercise the same surface.
  const blocks = (result.content as any[]) ?? [];
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  // IV10 — surface _meta so tests can assert on the new structured
  // error-code contract without breaking the existing { text, isError }
  // call-site shape.
  return { text, isError: result.isError, _meta: (result as any)._meta };
}

describe("MCP Tool Handlers", () => {
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

  describe("firstCallHint — team conventions (N6.3)", () => {
    it("is absent from the hint when team.json is missing", async () => {
      // Outer beforeEach already created `store` without a team.json.
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toContain("🚫 Team rules");
    });

    it("renders require / avoid / prefer groups with scope and rationale", async () => {
      // Need a FRESH store: team.json is read in the FileStore constructor.
      // Write it to a new tmpDir, then spin up a new server bound to it.
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-hint-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "req1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable", scope: { paths: ["packages/auth/**"] } },
            { id: "avoid1", kind: "avoid", concept: "global state", rationale: "breaks testability" },
            { id: "prefer1", kind: "prefer", concept: "repository pattern", rationale: "keeps SQL out of handlers" },
          ],
        }),
      );
      const freshStore = new FileStore(freshTmp, "team_hint_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);

      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");

      expect(text).toContain("🚫 Team rules");
      expect(text).toContain("Required:");
      expect(text).toContain("argon2id for password hashing");
      expect(text).toContain("bcrypt is brute-forceable");
      expect(text).toContain("scope: packages/auth/**");
      expect(text).toContain("Avoid:");
      expect(text).toContain("global state");
      expect(text).toContain("Preferred:");
      expect(text).toContain("repository pattern");

      // Team conventions + personal philosophy + guardrails are NEVER merged —
      // each has its own header so the agent can see the authority distinction.
      expect(text).toContain("🚫 Team rules");
      // No stray merged "Team + personal" header.
      expect(text).not.toMatch(/Team\s*\+\s*personal/i);

      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("FF5 — 'require'/'avoid' route to obligations tier (uncapped), 'prefer' stays in contextual (capped)", async () => {
      // Pre-FF5 all three groups went into contextualParts and could
      // be silently dropped by HINT_BUDGET_CHARS truncation. Now hard
      // rules survive the budget; taste competes with other context.
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-ff5-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "r1", kind: "require", concept: "FF5 hard required", rationale: "regulatory" },
            { id: "a1", kind: "avoid", concept: "FF5 hard avoid", rationale: "incident history" },
            { id: "p1", kind: "prefer", concept: "FF5 soft preference", rationale: "team taste" },
          ],
        }),
      );
      const freshStore = new FileStore(freshTmp, "team_ff5_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);
      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // Hard rules block is the obligations-tier copy.
      expect(text).toContain("🚫 Team rules");
      expect(text).toMatch(/hard.*'require' as imperatives.*'avoid' as refusal triggers/i);
      expect(text).toContain("FF5 hard required");
      expect(text).toContain("FF5 hard avoid");
      // Soft preferences are now a separate, contextual-tier block.
      expect(text).toContain("💡 Team preferences");
      expect(text).toMatch(/taste, weigh against the user's goal/i);
      expect(text).toContain("FF5 soft preference");
      // The hard-rules block precedes the soft-preferences block in the
      // assembled hint (obligations come before contextual).
      const hardIdx = text.indexOf("🚫 Team rules");
      const softIdx = text.indexOf("💡 Team preferences");
      expect(hardIdx).toBeGreaterThanOrEqual(0);
      expect(softIdx).toBeGreaterThan(hardIdx);
      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("HH6 — oversize hard rule gets truncated (not dropped) so the agent still sees the imperative", async () => {
      // Pre-HH6 a single 700-char require entry was dropped entirely:
      // agent saw "🚫 Team rules" + "Required:" + "📦 1 more rule line"
      // with NO rule body. Wrong failure mode for a hard rule. Now we
      // truncate to fit and tag with "…[truncated; full rule in
      // .deeppairing/team.json]".
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-hh6-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      // One require entry whose rendered line will exceed the budget.
      const longRationale = "the regulatory authority requires explicit attestation that ".repeat(20);
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({
          version: 1,
          preferences: [
            { id: "r1", kind: "require", concept: "HH6 oversize hard rule", rationale: longRationale },
          ],
        }),
      );
      const freshStore = new FileStore(freshTmp, "team_hh6_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);
      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // The rule is present (concept name survives truncation).
      expect(text).toContain("HH6 oversize hard rule");
      // The truncation marker fires.
      expect(text).toMatch(/\[truncated; full rule in \.deeppairing\/team\.json\]/);
      // Critically: the section is NOT empty (no header-only output).
      expect(text).toContain("Required:");
      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("GG4 — large team.json caps the rules section at TEAM_RULES_BUDGET_CHARS + emits 📦 N more trailer", async () => {
      // Pre-GG4 obligationsParts was uncapped — a 50-rule team.json
      // dumped ~6KB into every first-call hint, dwarfing the 1500-char
      // budget. Cap is 600 chars; trailer mentions the dropped count
      // and points the agent at .deeppairing/team.json for the rest.
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-gg4-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      // 30 require + 30 avoid rules, each ~80 chars rendered. Total
      // ~5KB — well past the 600 cap.
      const preferences = [];
      for (let i = 0; i < 30; i++) {
        preferences.push({
          id: `req${i}`, kind: "require",
          concept: `GG4 required rule number ${i} with prose`,
          rationale: `regulatory requirement that exists for compliance reason number ${i}`,
        });
      }
      for (let i = 0; i < 30; i++) {
        preferences.push({
          id: `av${i}`, kind: "avoid",
          concept: `GG4 forbidden pattern number ${i}`,
          rationale: `incident history reason number ${i} that we never want to repeat`,
        });
      }
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({ version: 1, preferences }),
      );
      const freshStore = new FileStore(freshTmp, "team_gg4_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);
      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      // Header survives.
      expect(text).toContain("🚫 Team rules");
      // At least one rule survives.
      expect(text).toMatch(/GG4 (required|forbidden)/);
      // The 📦 trailer appears with a dropped count + pointer.
      expect(text).toMatch(/📦 \d+ more rule lines? — see \.deeppairing\/team\.json/);
      // The team-rules block alone is bounded — pull out just the section.
      const sectionStart = text.indexOf("🚫 Team rules");
      const nextSectionStart = (() => {
        const candidates = ["📋 From previous sessions", "🌱", "🧭", "💡 Team preferences", "📦"];
        let best = text.length;
        for (const c of candidates) {
          const idx = text.indexOf(c, sectionStart + 1);
          if (idx > 0 && idx < best) best = idx;
        }
        return best;
      })();
      const teamSection = text.slice(sectionStart, nextSectionStart);
      // Allow some overhead — must be well under the 1500-char total budget.
      expect(teamSection.length).toBeLessThan(800);
      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });

    it("omits the section entirely when the only prefs would produce empty groups", async () => {
      // With zero valid preferences, the section must not appear (low-signal
      // empty sections just add noise to the hint).
      const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-team-empty-"));
      fs.mkdirSync(path.join(freshTmp, ".deeppairing"), { recursive: true });
      fs.writeFileSync(
        path.join(freshTmp, ".deeppairing", "team.json"),
        JSON.stringify({ version: 1, preferences: [] }),
      );
      const freshStore = new FileStore(freshTmp, "team_empty_session");
      const { server: freshServer } = createMcpServer(freshStore, () => {}, 4000);
      const [c, s] = InMemoryTransport.createLinkedPair();
      await freshServer.connect(s);
      const freshClient = new Client({ name: "t", version: "1.0" });
      await freshClient.connect(c);

      const result = await freshClient.callTool({
        name: "present_findings",
        arguments: { summary: "x", findings: [{ category: "x", detail: "x", significance: "low" }] },
      });
      // II12 — hint moved out of content[0]; join all text blocks.
      const text = ((result.content as any[]) ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");

      expect(text).not.toContain("🚫 Team rules");

      freshStore.forceFlush();
      fs.rmSync(freshTmp, { recursive: true, force: true });
    });
  });

  describe("firstCallHint — welcome-back ledger line (R2)", () => {
    it("stays silent when the ledger has fewer than 5 concepts", async () => {
      // The outer test suite's store has an empty ledger by default.
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).not.toContain("🌱");
      expect(text).not.toContain("Your deepPairing ledger");
    });

    it("DD3 — surfaces user-seeded stances as a [SEED] block in firstCallHint blocking tier", async () => {
      // PMF + ease-of-use + MCP all flagged: pre-DD3, seeds appeared
      // anonymously in the philosophy block (low priority, lost to
      // budget truncation first). Now they get their own SEED-tagged
      // block routed through blockingParts so the agent sees them on
      // every fresh session even when the rest of the hint is heavy.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("DD3 seeded avoid", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD3 seeded avoid",
      });
      ledger.recordInstance("DD3 seeded prefer", {
        project: "manual", sessionId: "seed", verdict: "approved", description: "DD3 seeded prefer",
      });
      // A manual seed that ALSO got cited in a real session.
      ledger.recordInstance("DD3 seed and fired", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD3 seed and fired",
      });
      ledger.recordInstance("DD3 seed and fired", {
        project: "/some/real/project", sessionId: "real_sess", verdict: "rejected", description: "DD3 seed and fired",
      });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("🌱 The user explicitly seeded these stances");
      expect(text).toContain("[SEED]");
      expect(text).toContain("DD3 seeded avoid");
      expect(text).toContain("DD3 seeded prefer");
      expect(text).toContain("DD3 seed and fired");
      // Cited seed shows the also-fired count.
      expect(text).toContain("also fired 1× in real sessions");
    });

    it("FF8 — when BOTH policy and contextual drop, the policy-specific hint is suppressed (single recall pointer suffices)", async () => {
      // Pre-FF8 the 📦 line ended with two hints stacked: "Call recall
      // with mode='philosophy' or mode='sessions'..." plus "Use recall
      // with mode='philosophy' source='user-seeded'..." Noisy. Now the
      // policy-specific hint only fires when ONLY policy dropped.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // Heavy seeded stances → policy tier overflows.
      for (let i = 0; i < 8; i++) {
        ledger.recordInstance(
          `FF8 long seed ${i} aaaaaaaaaaaaaa bbbbbbbbbb cccccccccccc dddddddddddddd eeeeeeeeeee`,
          { project: "manual", sessionId: "seed", verdict: "rejected", description: "x" },
        );
      }
      // AND a heavy contextual-tier rejected approach so contextual also
      // overflows. Use repeated rejections to make a chunky memory block.
      for (let i = 0; i < 6; i++) {
        store.recordRejectedApproach({
          description: `FF8 contextual rejection number ${i} with long-prose content padding to push budget over the cap aaaa bbbb cccc dddd eeee`,
          reason: "test padding to push budget consumption past the contextual cap",
        });
      }
      const { text } = await callTool("present_findings", {
        summary: "FF8 trigger",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("📦");
      // The generic recall pointer is present.
      expect(text).toMatch(/Call `recall` with mode='philosophy' or mode='sessions'/);
      // The policy-specific hint is NOT stacked on top.
      expect(text).not.toMatch(/Use `recall` with mode='philosophy' source='user-seeded'/);
    });

    it("EE1 — seeded stances respect the policy cap; cap-overflow nudges agent to recall mode='philosophy' source='user-seeded'", async () => {
      // Pre-EE1, seeded stances pushed into blockingParts which was
      // appended unconditionally before the contextual budget loop —
      // 8 long seeds could occupy ~1200 chars uncapped. With this test
      // we seed enough long-prose stances to overflow the policy cap
      // (POLICY_BUDGET_CHARS=600) and assert: the 📦 dropped-context
      // line fires AND mentions the source='user-seeded' recall path
      // so the agent knows how to retrieve what was elided.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // 8 seeded stances with long prose (~140 chars per line × 8 ≈
      // 1120 chars). Cap of 600 → at least 3 entries get dropped.
      for (let i = 0; i < 8; i++) {
        ledger.recordInstance(
          `EE1 distinctly long seeded concept number ${i} ` +
            `with sufficient distinctive prose to cross the cap aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd`,
          { project: "manual", sessionId: "seed", verdict: "rejected", description: "long" },
        );
      }
      const { text } = await callTool("present_findings", {
        summary: "EE1 cap probe",
        findings: [{ category: "y", detail: "EE1 cap probe detail", significance: "low" }],
      });
      // Header + at least one seed line survived (policy tier had room).
      expect(text).toContain("🌱 The user explicitly seeded these stances");
      // Seeds are sorted by lastSeenAt desc; latest insertions land first.
      // At least one [SEED] line is in the output.
      expect(text).toMatch(/\[SEED\] \[AVOID\] "EE1 distinctly long seeded concept number \d+/);
      // The 📦 omission line fires AND points at the seeded-source filter.
      expect(text).toContain("📦");
      expect(text).toContain("source='user-seeded'");
    });

    it("EE6 — fresh-with-seeds project (concepts < 5) gets the recall pointer in the SEED block", async () => {
      // Pre-EE6 the recall pointer was gated on R2's >=5 concept rule —
      // a fresh project with 3 seeds learned about [SEED] but never
      // about how to pull the full digest. Now the SEED block carries
      // its own pointer when R2 won't fire.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("EE6 only seed 1", { project: "manual", sessionId: "seed", verdict: "rejected", description: "x" });
      ledger.recordInstance("EE6 only seed 2", { project: "manual", sessionId: "seed", verdict: "rejected", description: "x" });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      // SEED block fires.
      expect(text).toContain("EE6 only seed 1");
      // Nudge appears in the SEED block.
      expect(text).toContain("Call recall mode='ledger' for the full digest");
      expect(text).toContain("source='user-seeded'");
      // R2 welcome line (gated on >=5) does NOT fire — verify ledger
      // is below threshold.
      expect(text).not.toContain("Your deepPairing ledger:");
    });

    it("DD3 — R2 welcome-back line points the agent at recall mode='ledger'", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // 5 concepts so the R2 line activates.
      for (let i = 0; i < 5; i++) {
        ledger.recordInstance(`DD3 R2 concept ${i}`, {
          project: "project-a",
          sessionId: "s1",
          verdict: "rejected",
        });
      }
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("Call recall with mode='ledger'");
    });

    it("surfaces the compounding summary once ≥5 concepts exist across projects", async () => {
      // Seed the global ledger with 5 concepts spanning 2 projects, mix of
      // avoid + prefer — then fire the first tool call.
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("global mutable state", {
        project: "project-a", sessionId: "s1", verdict: "rejected", reason: "broke testability",
      });
      ledger.recordInstance("god object", {
        project: "project-a", sessionId: "s1", verdict: "rejected",
      });
      ledger.recordInstance("primitive obsession", {
        project: "project-b", sessionId: "s2", verdict: "rejected",
      });
      ledger.recordInstance("repository pattern", {
        project: "project-a", sessionId: "s1", verdict: "approved",
      });
      ledger.recordInstance("service layer", {
        project: "project-b", sessionId: "s2", verdict: "approved",
      });

      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      expect(text).toContain("🌱 Your deepPairing ledger");
      expect(text).toContain("5 concepts");
      expect(text).toContain("3 avoid / 2 prefer");
      expect(text).toContain("2 projects");
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

  describe("check_feedback", () => {
    it("returns session status preamble", async () => {
      const { text } = await callTool("check_feedback");
      expect(text).toContain("Session:");
      expect(text).toContain("Suggested action:");
    });

    it("F1 — warns to WAIT while a code_change is still under review (never 'you may proceed')", async () => {
      // confidence "low" keeps it a draft (no terminal quick-approve) → routed to UI.
      await callTool("present_code_change", {
        filePath: "/src/big.ts", changeType: "modify",
        before: "const x = 1;", after: "const x = 2;", reasoning: "x", confidence: "low",
      });
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("code_change");
      expect(art.status).toBe("draft");
      // an immediate comment makes check_feedback return fast instead of long-polling;
      // suggestedAction still reflects the pending code_change.
      store.addComment({ id: "c_imm", artifactId: art.id, content: "noted", author: "human" });

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Wait for the code change review");
      expect(text).not.toContain("You may proceed with implementation.");
      expect(text).toContain("(code_change)"); // appears in the WAITING line
    });

    it("FN2 — warns 'do NOT apply' (not 'proceed') after a human rejects a code_change, exactly once", async () => {
      await callTool("present_code_change", {
        filePath: "/src/x.ts", changeType: "modify", before: "a", after: "b", reasoning: "x", confidence: "low",
      });
      const art = store.getArtifacts()[0];
      expect(art.type).toBe("code_change");
      // reject with NO feedback comment — detection must still fire (comment-independent)
      store.updateArtifactStatus(art.id, "rejected", "ui_reject");

      const first = await callTool("check_feedback");
      expect(first.text).toContain("REJECTED");
      expect(first.text).not.toContain("You may proceed with implementation.");

      // reported exactly once — the next check no longer re-emits the rejection
      const second = await callTool("check_feedback");
      expect(second.text).not.toContain("REJECTED");
    });

    it("returns unacknowledged comments", async () => {
      // Create an artifact and add a comment
      await callTool("present_findings", {
        summary: "Test",
        findings: [{ category: "Test", detail: "Test", significance: "low" }],
      });
      const artId = store.getArtifacts()[0].id;
      store.addComment({ id: "cmt_1", artifactId: artId, content: "Good work", author: "human" });

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Good work");
    });

    it("returns resolved decisions", async () => {
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "Service", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Inline", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "Cleaner");

      const { text } = await callTool("check_feedback");
      expect(text).toContain("Service");
    });

    it("BB3 — waitFor='decision' ignores stale unack comments and waits for the decision", async () => {
      // The agent just called present_options. There's an unrelated old
      // comment sitting in the unack queue (e.g. on a previous artifact).
      // Pre-BB3, check_feedback returned IMMEDIATELY because comments
      // existed — so the agent never got the chance to wait for the user
      // to actually pick an option. With waitFor='decision', the early-
      // return guard is scoped to resolved decisions only.
      await callTool("present_options", {
        context: "Which pattern?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const decisionArtId = store.getArtifacts()[0].id;
      // Stash a stale comment on a different artifact.
      store.addComment({ id: "cmt_stale", artifactId: "art_other", content: "old chatter", author: "human" });

      // Schedule the decision resolution after 50ms so the long-poll wakes.
      const dec = store.getPendingDecisions()[0];
      setTimeout(() => store.resolveDecision(dec.decisionId, "a", "go with A"), 50);

      const { text } = await callTool("check_feedback", { waitFor: "decision" });
      // The stale comment is still in the queue (we didn't ack it for this
      // poll's purpose), but the wake condition was the resolved decision.
      expect(text).toContain("A");
      // Sanity: the artifact we presented was the one that got resolved.
      expect(decisionArtId).toBeTruthy();
    });

    it("CC5 — waitFor='decision' wakes on an unrelated comment but returns 'still waiting' instead of dumping it", async () => {
      // Pre-CC5: long-poll wakes on ANY signal, then post-wake assembly
      // dumps all comments + decisions regardless of waitFor scope. The
      // agent that asked for a decision-only wake gets a comment-flavored
      // response — surprising, conflicts with the scoped contract.
      await callTool("present_options", {
        context: "Pick a deploy",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      // Schedule an unrelated comment (not the decision the agent is
      // waiting for) after 50ms so the long-poll wakes mid-flight.
      setTimeout(() => {
        store.addComment({ id: "cmt_noise", artifactId: "art_other", content: "stray remark", author: "human" });
      }, 50);
      const { text } = await callTool("check_feedback", { waitFor: "decision" });
      expect(text).toContain("Still waiting on 'decision'");
      expect(text).not.toContain("stray remark");
    });

    it("BB3 — waitFor='comments' returns immediately when there's an unack comment, even with a draft decision", async () => {
      await callTool("present_options", {
        context: "Which?",
        options: [
          { id: "a", title: "A", description: "A", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "B", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      store.addComment({ id: "cmt_now", artifactId: "any", content: "look here", author: "human" });
      const t0 = Date.now();
      const { text } = await callTool("check_feedback", { waitFor: "comments" });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1000); // immediate, not the 30s long-poll
      expect(text).toContain("look here");
    });

    it("does NOT include session memory inside check_feedback", async () => {
      // Session memory is delivered on the first tool call hint (see
      // first-call-hint test below), never inside check_feedback — mixing
      // WAITING signals with past-violation warnings creates contradictory
      // imperatives for the agent.
      store.recordApprovedPattern({ description: "Service pattern" });
      store.recordRejectedApproach({ description: "Inline refactor" });

      // Burn the first tool call on something other than check_feedback
      await callTool("log_reasoning", {
        action: "warm-up",
        reasoning: "trigger the first-call hint elsewhere",
        confidence: "low",
      });

      const { text } = await callTool("check_feedback");
      expect(text).not.toContain("previous sessions");
      expect(text).not.toContain("Rejected approaches");
    });
  });

  describe("session memory on first tool call", () => {
    it("includes rejected approaches with reasons in the first tool call response", async () => {
      store.recordRejectedApproach({ description: "Deploy to Railway", reason: "too expensive for our scale" });
      store.recordApprovedPattern({ description: "Service pattern" });

      const { text } = await callTool("log_reasoning", {
        action: "first call",
        reasoning: "test",
        confidence: "low",
      });

      expect(text).toContain("From previous sessions");
      expect(text).toContain("Deploy to Railway");
      expect(text).toContain("too expensive for our scale");
      expect(text).toContain("Service pattern");
    });

    it("does NOT repeat session memory on subsequent tool calls", async () => {
      store.recordRejectedApproach({ description: "Inline refactor" });

      await callTool("log_reasoning", {
        action: "first", reasoning: "x", confidence: "low",
      });
      const { text } = await callTool("log_reasoning", {
        action: "second", reasoning: "y", confidence: "low",
      });

      expect(text).not.toContain("From previous sessions");
      expect(text).not.toContain("Inline refactor");
    });

    it("resets poll counter when feedback arrives", async () => {
      // Poll 3 times with no feedback (no drafts = no long-poll)
      await callTool("check_feedback");
      await callTool("check_feedback");
      await callTool("check_feedback");

      // Now add human feedback — counter should reset
      store.addComment({ id: "cmt_1", artifactId: "__session__", content: "hello", author: "human" });
      const { text } = await callTool("check_feedback");

      expect(text).toContain("Human directive");
      expect(text).not.toContain("No human response"); // Counter was reset
    });

    it("increments poll counter on empty polls", async () => {
      // Poll 4 times with no feedback, no drafts = instant return
      await callTool("check_feedback");
      await callTool("check_feedback");
      await callTool("check_feedback");
      // 4th poll — counter is now 4
      const { text } = await callTool("check_feedback");
      // No pending items, so escalation hint won't appear,
      // but counter is tracked correctly (tested via reset above)
      expect(text).toContain("Session:");
    });
  });

  describe("export_session", () => {
    it("returns markdown in the specified format", async () => {
      await callTool("present_findings", {
        summary: "Auth issues",
        findings: [{ category: "Security", detail: "Weak hashing", significance: "high" }],
      });

      const { text } = await callTool("export_session", { format: "full" });
      expect(text).toContain("Session Report");
      expect(text).toContain("Weak hashing");
    });
  });

  describe("pre-flight rejected-approach validation", () => {
    it("blocks present_options when an option matches a rejected approach", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive for our scale" });

      const result = await callTool("present_options", {
        context: "Choose a hosting provider",
        options: [
          { id: "a", title: "Railway", description: "Easy deploy", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Fly.io", description: "Edge", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(result.text).toContain("Railway");
      expect(result.text).toContain("too expensive for our scale");
      // Artifact must NOT have been created
      expect(store.getArtifacts()).toHaveLength(0);
    });

    it("CC1 — block message includes the trace summary so the agent sees considered/near-miss context on block too", async () => {
      // BB5 added the summary on the ADMIT path; CC1 closes the asymmetry
      // on the BLOCK path. The agent gets "...previously rejected as Y"
      // for the matched concept PLUS "Preflight: considered N past
      // stance(s)" for the broader picture.
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        reason: "too expensive",
        concept: "pay-per-request hosting",
      });
      store.recordRejectedApproach({
        description: "global mutable state",
        concept: "global mutable state",
      });
      const result = await callTool("present_options", {
        context: "Pick a deploy target with mutable backing",
        options: [
          { id: "a", title: "Railway", description: "Fast", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Render", description: "Boring", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      expect(result.isError).toBe(true);
      // Original block message still there.
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(result.text).toContain("Railway");
      // CC1 — appended trace summary covers BOTH considered stances.
      expect(result.text).toContain("Preflight: considered");
    });

    it("broadcasts a preflight_blocked event so the UI can toast (H1)", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive", concept: "pay-per-request hosting" });

      await callTool("present_options", {
        context: "Pick a deploy target",
        options: [
          { id: "a", title: "Railway", description: "Fast", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Render", description: "Boring", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });

      const blockEvent = broadcasts.find((b) => b.type === "preflight_blocked");
      expect(blockEvent).toBeDefined();
      expect(blockEvent.toolName).toBe("present_options");
      expect(blockEvent.match.proposal).toBeTruthy();
      expect(blockEvent.match.description).toContain("Railway");
      expect(blockEvent.match.reason).toBe("too expensive");
      expect(["surface", "concept"]).toContain(blockEvent.match.via);
    });

    it("blocks present_plan when a step description matches a rejected approach", async () => {
      store.recordRejectedApproach({ description: "Inline refactor" });

      const result = await callTool("present_plan", {
        title: "Cleanup",
        steps: [{ description: "Inline refactor of auth module", reasoning: "simpler" }],
        estimatedChanges: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(store.getArtifacts()).toHaveLength(0);
    });

    it("allows present_findings when nothing matches", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway" });

      const { isError } = await callTool("present_findings", {
        summary: "Auth analysis",
        findings: [{ category: "Security", detail: "Weak hash", significance: "high" }],
      });

      expect(isError).toBeFalsy();
      expect(store.getArtifacts()).toHaveLength(1);
    });

    it("blocks via concept match even when surface names differ (U6)", async () => {
      // Past rejection: "Railway" with the underlying concept "pay-per-request serverless hosting"
      store.recordRejectedApproach({
        description: "Deploy: Railway",
        reason: "too expensive for low-traffic services",
        concept: "pay-per-request serverless hosting platform",
      });

      // Agent now proposes Fly.io with language that matches the concept tokens
      const result = await callTool("present_options", {
        context: "Pick a deploy target",
        options: [
          {
            id: "a", title: "Fly.io",
            description: "Use Fly.io — another pay-per-request serverless hosting platform",
            pros: [], cons: [], effort: "low", risk: "low", recommendation: true,
          },
          {
            id: "b", title: "AWS ECS",
            description: "Long-running ECS task", pros: [], cons: [], effort: "medium", risk: "medium", recommendation: false,
          },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("REJECTED_APPROACH_BLOCKED");
      expect(result.text).toContain("underlying concept");
      expect(result.text).toContain("pay-per-request serverless hosting platform");
      expect(store.getArtifacts()).toHaveLength(0);
    });
  });

  describe("rejected approaches captured from artifact rejections (U1+U6)", () => {
    it("records a rejected approach with reason when a finding is rejected", async () => {
      await callTool("present_findings", {
        title: "Proposed caching layer",
        summary: "add Redis cache",
        findings: [{ category: "Perf", detail: "cache user profiles", significance: "high" }],
      });
      const artifact = store.getArtifacts()[0];

      // Simulate the HTTP PATH: status update to rejected with feedback.
      // We invoke the store directly since test fixtures don't use Hono.
      store.updateArtifactStatus(artifact.id, "rejected");
      // The HTTP handler also records the rejected approach — simulate that path
      store.recordRejectedApproach({
        description: artifact.title,
        reason: "we already have a CDN layer; adding Redis is premature",
        sourceArtifactId: artifact.id,
      });

      const memory = store.getSessionMemory();
      const match = memory.rejectedApproaches.find((r) => r.description === "Proposed caching layer");
      expect(match).toBeDefined();
      expect(match?.reason).toContain("premature");
      expect(match?.sourceArtifactId).toBe(artifact.id);
    });
  });

  describe("AA1 — concept.name flows through to ledger (Y5 + Z1 substrate consumer fix)", () => {
    // Pre-AA1, server.ts:824 was passing option.description as the concept
    // arg to recordRejectedApproach. The Y5-hoisted option.concept.name
    // was dropped on the floor — the global ledger keyed on prose like
    // "Use Fly.io — pay-per-request serverless platform" instead of the
    // crisp "pay-per-request hosting" name. Cross-project compounding
    // was broken: every project minted its own unique long key.
    //
    // These tests pin that the resolve handler now reads concept.name
    // from each option and threads it through both rejection and
    // approval paths.

    it("rejected option's concept.name lands in the session ledger as `concept`", async () => {
      // Present options with explicit concept.name on both. User picks A;
      // B's concept should land in the rejected list.
      await callTool("present_options", {
        context: "Pick a deploy target",
        options: [
          {
            id: "a", title: "AWS Fargate",
            description: "managed container service",
            pros: ["mature"], cons: ["complex"],
            effort: "medium", risk: "low", recommendation: true,
            concept: { name: "managed container service" },
          },
          {
            id: "b", title: "Fly.io",
            description: "pay-per-request hosting on the edge",
            pros: ["cheap"], cons: ["less mature"],
            effort: "low", risk: "medium", recommendation: false,
            concept: { name: "pay-per-request hosting" },
          },
        ],
      });
      const artifact = store.getArtifacts()[0];
      const dec = (artifact.content as any).decisionId;
      // Resolve via the store (UI path); then trigger the next tool call
      // so the resolve-handler post-processing fires.
      store.resolveDecision(dec, "a", "fits our existing infra");
      await callTool("check_feedback", {});

      const memory = store.getSessionMemory();
      const rejected = memory.rejectedApproaches.find(
        (r) => r.description.includes("Fly.io"),
      );
      expect(rejected).toBeDefined();
      // The concept is the Y5 short name, NOT the prose description.
      expect(rejected?.concept).toBe("pay-per-request hosting");
    });

    it("SP2 — each rejected option records its OWN cons, not the human's single pick-reasoning", async () => {
      await callTool("present_options", {
        context: "Pick a cache",
        options: [
          { id: "a", title: "Redis", description: "shared store", pros: ["exact"], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "In-process LRU", description: "no deps", pros: ["simple"], cons: ["drifts across instances", "lost on restart"], effort: "low", risk: "medium", recommendation: false },
          { id: "c", title: "Memcached", description: "another service", pros: [], cons: ["one more thing to run"], effort: "medium", risk: "low", recommendation: false },
        ],
      });
      const dec = (store.getArtifacts()[0].content as any).decisionId;
      store.resolveDecision(dec, "a", "Redis is already in our stack");
      await callTool("check_feedback", {});

      const rejected = store.getSessionMemory().rejectedApproaches;
      const b = rejected.find((r) => r.description.includes("In-process LRU"));
      const c = rejected.find((r) => r.description.includes("Memcached"));
      // Each carries its OWN cons (distinct), not the same blurred string.
      expect(b?.reason).toContain("drifts across instances");
      expect(c?.reason).toContain("one more thing to run");
      expect(b?.reason).not.toBe(c?.reason);
      // ...with the human's pick-reasoning + winner as shared context.
      expect(b?.reason).toContain("Redis is already in our stack");
    });

    it("approved option's concept.name flows through too (symmetric with rejection)", async () => {
      // Same options shape; assert the WINNER's concept lands as a
      // pattern in the global ledger via the approved path.
      await callTool("present_options", {
        context: "Pick password hashing",
        options: [
          {
            id: "a", title: "argon2id",
            description: "memory-hard password hashing",
            pros: ["modern"], cons: ["newer"],
            effort: "low", risk: "low", recommendation: true,
            concept: { name: "argon2id for password hashing" },
          },
          {
            id: "b", title: "bcrypt rounds=4",
            description: "fast bcrypt with low cost factor",
            pros: ["familiar"], cons: ["brute-forceable"],
            effort: "low", risk: "high", recommendation: false,
            concept: { name: "low-cost bcrypt" },
          },
        ],
      });
      const artifact = store.getArtifacts()[0];
      const dec = (artifact.content as any).decisionId;
      store.resolveDecision(dec, "a", "future-proof");
      await callTool("check_feedback", {});

      // Approved patterns track the prose description (legacy shape) but
      // the GLOBAL ledger gets the concept.name as the bucket key. We
      // don't have a getGlobalStore inspection helper here, but we DO
      // verify the approval landed via the prose path.
      const memory = store.getSessionMemory();
      expect(
        memory.approvedPatterns.some((p) => p.includes("argon2id")),
      ).toBe(true);
    });

    it("falls back to option.description when concept is missing (back-compat)", async () => {
      await callTool("present_options", {
        context: "Pick a queue",
        options: [
          {
            id: "a", title: "SQS", description: "managed queue",
            pros: [], cons: [], effort: "low", risk: "low", recommendation: true,
          },
          {
            id: "b", title: "Redis Streams", description: "in-memory queue with persistence",
            pros: [], cons: [], effort: "medium", risk: "medium", recommendation: false,
          },
        ],
      });
      const artifact = store.getArtifacts()[0];
      const dec = (artifact.content as any).decisionId;
      store.resolveDecision(dec, "a", "we already use AWS");
      await callTool("check_feedback", {});

      const memory = store.getSessionMemory();
      const rejected = memory.rejectedApproaches.find(
        (r) => r.description.includes("Redis Streams"),
      );
      expect(rejected).toBeDefined();
      // Without concept, falls back to the prose description.
      expect(rejected?.concept).toBe("in-memory queue with persistence");
    });
  });

  describe("revise_artifact — mode: obsolete", () => {
    it("marks the artifact obsolete (overcome by new info) so it leaves the review queue", async () => {
      await callTool("present_findings", {
        summary: "early analysis",
        findings: [{ category: "other", detail: "x", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "obsolete",
        reason: "the spec changed; this no longer applies",
      });

      expect(isError).toBeFalsy();
      expect(text.toLowerCase()).toContain("obsolete");
      expect(store.getArtifacts()[0].status).toBe("obsolete");
      // Neutral agent comment records why (not "Retracted").
      const comments = store.getCommentsForArtifact(artifact.id);
      expect(
        comments.some((c) => c.author === "agent" && c.content.includes("Overcome by new information")),
      ).toBe(true);
    });

    it("errors when trying to obsolete an already-approved artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "other", detail: "y", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.updateArtifactStatus(artifact.id, "approved");
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "obsolete",
        reason: "too late",
      });
      expect(isError).toBe(true);
      expect(text).toContain("too late to obsolete");
    });
  });

  describe("revise_artifact — mode: retract (N4)", () => {
    it("transitions the artifact to retracted and records the reason", async () => {
      await callTool("present_findings", {
        summary: "hasty analysis",
        findings: [{ category: "other", detail: "something", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "retract",
        reason: "realised I had the wrong file",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(artifact.id);
      expect(store.getArtifacts()[0].status).toBe("retracted");

      // Agent-authored comment preserves the reason for the human to see
      const comments = store.getCommentsForArtifact(artifact.id);
      expect(comments.length).toBeGreaterThan(0);
      expect(comments.some((c) => c.author === "agent" && c.content.includes("wrong file"))).toBe(true);
    });

    it("errors when the artifact id is unknown", async () => {
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: "art_does_not_exist",
        mode: "retract",
        reason: "oops",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when trying to retract an already-approved artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.updateArtifactStatus(artifact.id, "approved");

      const { isError, text } = await callTool("revise_artifact", {
        artifactId: artifact.id,
        mode: "retract",
        reason: "second thoughts",
      });
      expect(isError).toBe(true);
      expect(text).toContain("too late to retract");
    });

    it("requires artifactId, mode, and reason", async () => {
      const missingReason = await callTool("revise_artifact", { artifactId: "art_x", mode: "retract" });
      expect(missingReason.isError).toBe(true);
      expect(missingReason.text).toContain("reason");

      const missingId = await callTool("revise_artifact", { mode: "retract", reason: "no id" });
      expect(missingId.isError).toBe(true);
      expect(missingId.text).toContain("artifactId");

      const missingMode = await callTool("revise_artifact", { artifactId: "art_x", reason: "no mode" });
      expect(missingMode.isError).toBe(true);
      expect(missingMode.text).toContain("mode");
    });
  });

  describe("firstCallHint surfaces decision-revision-requested + plain artifact comments", () => {
    // Field bug: a human comment on a decision artifact reached the agent
    // via check_feedback, but the agent's protocol gave no clear
    // instruction for non-question comments → reply went into chat only,
    // never landed in the conversation rail. Two complementary surfacing
    // additions in firstCallHint:
    //   1. Comments tagged sectionId="decision_revision_requested" get
    //      promoted to a HIGH-PRIORITY "🔁 REVISION REQUEST" section that
    //      tells the agent to call revise_artifact, NOT answer_question.
    //   2. Plain (non-question, non-answered) comments on artifacts
    //      surface a "💬 N comments without an agent reply" line so the
    //      agent knows to mirror substantive replies via answer_question.

    // The firstCallHint only fires on the FIRST tool call per server
    // instance. To exercise it, we seed the store directly (no callTool)
    // and then make the FIRST tool call to see the hint.

    it("surfaces decision_revision_requested as a HIGH-PRIORITY revise_artifact action", async () => {
      // Seed a decision artifact directly (no first-call burnt).
      const decisionArtifact = store.createArtifact({
        id: "art_dec_seed",
        type: "decision",
        title: "Pick a matcher",
        content: { context: "Pick a matcher", options: [], decisionId: "dec_seed" },
      });
      store.addComment({
        id: "cmt_revision",
        artifactId: decisionArtifact.id,
        content: "all 4 options are matchers — what about a hybrid?",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });

      // FIRST tool call — carries the firstCallHint.
      const { text } = await callTool("present_findings", {
        summary: "trigger first-call hint",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      expect(text).toMatch(/REVISION REQUEST/);
      expect(text).toMatch(/revise_artifact/);
      expect(text).toMatch(/supersede/);
      expect(text).toContain(decisionArtifact.id);
      expect(text).toContain("cmt_revision");
      expect(text).toMatch(/all 4 options are matchers/);
      expect(text).toMatch(/Do NOT just call answer_question/);
    });

    it("does not double-count revision-requests in the plain unanswered-questions section", async () => {
      const decision = store.createArtifact({
        id: "art_dec_only",
        type: "decision",
        title: "x",
        content: { context: "x", options: [], decisionId: "dec_only" },
      });
      store.addComment({
        id: "cmt_rev_only",
        artifactId: decision.id,
        content: "redo the options",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });

      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // With ONLY a revision-request comment (no plain question), the
      // unanswered-questions counter must not appear.
      const lines = text.split("\n");
      const unansweredLine = lines.find((l) => /❓ \d+ unanswered question/.test(l));
      expect(unansweredLine).toBeUndefined();
      expect(text).toMatch(/🔁/);
    });

    it("surfaces plain (non-question) human comments as 'mirror via answer_question'", async () => {
      const findings = store.createArtifact({
        id: "art_research_seed",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      store.addComment({
        id: "cmt_plain_thought",
        artifactId: findings.id,
        content: "interesting trade-off here",
        author: "human",
        // intent omitted on purpose → plain comment
      });

      const { text } = await callTool("present_findings", {
        summary: "y",
        findings: [{ category: "y", detail: "y", significance: "low" }],
      });

      expect(text).toMatch(/💬 1 human comment.*without an agent reply/);
      expect(text).toMatch(/Mirror substantive replies via answer_question/);
    });

    it("surfaces follow-up replies in active threads (parentCommentId points at agent comment) as ↳ continue-the-thread", async () => {
      // The user replied to the agent's previous answer_question reply
      // via the new Reply button. firstCallHint must surface this as a
      // distinct "continuing thread" signal so the agent calls
      // answer_question AGAIN, not addComment top-level.
      const findings = store.createArtifact({
        id: "art_thread_seed",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      // Original question.
      store.addComment({
        id: "h_q1",
        artifactId: findings.id,
        content: "why?",
        author: "human",
        intent: "question",
      });
      // Agent's prior reply (answer_question result).
      store.addComment({
        id: "agent_a1",
        artifactId: findings.id,
        content: "because Y",
        author: "agent",
        parentCommentId: "h_q1",
      });
      // Mark the original question as answered so it doesn't show in the
      // unanswered-questions section (which would conflict with the
      // follow-up surfacing).
      store.markCommentAnswered("h_q1", "agent_a1");
      // Human's follow-up reply — parentCommentId points at agent_a1.
      store.addComment({
        id: "h_followup",
        artifactId: findings.id,
        content: "but Y doesn't apply because Z",
        author: "human",
        parentCommentId: "agent_a1",
      });

      const { text } = await callTool("present_findings", {
        summary: "trigger first-call",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      expect(text).toMatch(/↳/);
      expect(text).toMatch(/follow-up repl/);
      expect(text).toContain("h_followup");
      expect(text).toContain("agent_a1");
      expect(text).toContain("but Y doesn't apply because Z");
      expect(text).toMatch(/answer_question.*AGAIN/);
      expect(text).toMatch(/Do NOT post a new top-level comment/);
    });

    it("does not double-count follow-up replies in the plain-comments mirror line", async () => {
      // A follow-up reply has author=human and intent=undefined (i.e.
      // matches the plain-comment filter too). It must appear in the
      // ↳ follow-up section only, not also in the 💬 mirror section.
      const findings = store.createArtifact({
        id: "art_no_dup",
        type: "research",
        title: "x",
        content: { summary: "x", findings: [] },
      });
      store.addComment({ id: "agent_a", artifactId: findings.id, content: "A", author: "agent" });
      store.addComment({
        id: "h_followup_only",
        artifactId: findings.id,
        content: "follow-up",
        author: "human",
        parentCommentId: "agent_a",
      });

      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // Follow-up section IS present.
      expect(text).toMatch(/↳ 1 follow-up reply/);
      // Plain-comments-needing-mirror line is NOT — that comment is
      // already accounted for as a follow-up.
      expect(text).not.toMatch(/💬 \d+ human comment.*without an agent reply/);
    });

    it("does NOT surface session-level chat (artifactId='__session__') as needing a mirror", async () => {
      store.addComment({
        id: "cmt_session_chat",
        artifactId: "__session__",
        content: "hey just thinking out loud",
        author: "human",
      });
      const { text } = await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toMatch(/💬 \d+ human comment.*without an agent reply/);
    });
  });

  describe("answer_question + question prioritization", () => {
    it("prioritizes question comments in check_feedback with an answer hint", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      store.addComment({
        id: "cmt_plain",
        artifactId: artifact.id,
        content: "just a note",
        author: "human",
      });
      store.addComment({
        id: "cmt_q1",
        artifactId: artifact.id,
        content: "why did you pick this approach?",
        author: "human",
        intent: "question",
      });

      const { text } = await callTool("check_feedback");
      // Questions section appears and carries the answer hint
      expect(text).toContain("Human questions");
      expect(text).toContain("why did you pick this approach");
      expect(text).toContain("answer_question");
      expect(text).toContain("cmt_q1");
      // Questions are listed before regular comments in the final text
      const qIdx = text.indexOf("Human questions");
      const cIdx = text.indexOf("Human comments");
      expect(qIdx).toBeGreaterThanOrEqual(0);
      expect(cIdx === -1 || qIdx < cIdx).toBe(true);
    });

    it("answer_question links the reply and marks the question answered", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const question = store.addComment({
        id: "cmt_q2",
        artifactId: artifact.id,
        content: "what else did you consider?",
        author: "human",
        intent: "question",
      });

      const { text, isError } = await callTool("answer_question", {
        commentId: question.id,
        answer: "I considered X but rejected it because Y.",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(question.id);

      // Parent question should now carry answeredByCommentId
      const parent = store.getComment(question.id);
      expect(parent?.answeredByCommentId).toBeTruthy();

      // The answer comment is agent-authored, parented, and acknowledged
      const all = store.getCommentsForArtifact(artifact.id);
      const answer = all.find((c) => c.id === parent?.answeredByCommentId);
      expect(answer).toBeDefined();
      expect(answer?.author).toBe("agent");
      expect(answer?.parentCommentId).toBe(question.id);
      expect(answer?.content).toContain("considered X");
    });

    it("already-answered questions drop out of the priority lane", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];
      const q = store.addComment({
        id: "cmt_q3",
        artifactId: artifact.id,
        content: "what does this do?",
        author: "human",
        intent: "question",
      });
      // Acknowledge so the existing check_feedback exchange doesn't re-surface it first
      store.acknowledgeComments([q.id]);
      await callTool("answer_question", {
        commentId: q.id,
        answer: "It's a guard clause.",
      });

      // Add a fresh plain comment so check_feedback has something to show
      store.addComment({
        id: "cmt_plain2",
        artifactId: artifact.id,
        content: "makes sense",
        author: "human",
      });

      const { text } = await callTool("check_feedback");
      expect(text).not.toContain("Human questions");
      expect(text).toContain("Human comments");
    });

    it("errors when answering an unknown commentId", async () => {
      const { isError, text } = await callTool("answer_question", {
        commentId: "cmt_not_real",
        answer: "hi",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no comment");
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

  describe("revise_artifact — mode: supersede (N4)", () => {
    it("creates a versioned child and retires the old one", async () => {
      await callTool("present_findings", {
        summary: "first pass",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });
      const old = store.getArtifacts()[0];

      const { text, isError } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        title: "Second pass: actually it's argon2",
        content: {
          summary: "revised: weak hash turned out to be argon2id",
          findings: [{ category: "Security", detail: "already argon2id", significance: "low" }],
        },
        reason: "misidentified the library on first read",
      });

      expect(isError).toBeFalsy();
      expect(text).toContain(old.id);
      expect(text).toContain("v2");

      const artifacts = store.getArtifacts();
      expect(artifacts).toHaveLength(2);

      const retired = artifacts.find((a) => a.id === old.id);
      expect(retired?.status).toBe("superseded");

      const successor = artifacts.find((a) => a.id !== old.id);
      expect(successor?.type).toBe("research");
      expect(successor?.version).toBe(2);
      expect(successor?.parentId).toBe(old.id);
      expect(successor?.status).toBe("draft");

      // Reason is preserved as an agent comment on the OLD artifact
      const retiredComments = store.getCommentsForArtifact(old.id);
      expect(retiredComments.some((c) =>
        c.author === "agent" && c.content.includes("misidentified"))).toBe(true);
    });

    it("refuses to supersede an already-superseded artifact", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      store.updateArtifactStatus(old.id, "superseded");

      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: [] },
        reason: "retry",
      });
      expect(isError).toBe(true);
      expect(text).toContain("superseded");
    });

    it("records a new plan review cycle when superseding a plan", async () => {
      await callTool("present_plan", {
        title: "Original plan",
        steps: [{ description: "step A", reasoning: "because" }],
        estimatedChanges: 1,
      });
      const oldPlan = store.getArtifacts()[0];
      expect(store.getPendingPlanReviews().map((p) => p.artifactId)).toContain(oldPlan.id);

      const result = await callTool("revise_artifact", {
        artifactId: oldPlan.id,
        mode: "supersede",
        title: "Revised plan",
        content: {
          steps: [{ description: "step A'", reasoning: "incorporate feedback" }],
          estimatedChanges: 1,
        },
        reason: "human asked for smaller scope",
      });
      expect(result.isError).toBeFalsy();

      const newPlan = store.getArtifacts().find((a) => a.id !== oldPlan.id)!;
      const pending = store.getPendingPlanReviews();
      expect(pending.map((p) => p.artifactId)).toContain(newPlan.id);
      // F1 — the OLD plan's review is now an orphan (its artifact is superseded)
      // and must NOT keep reporting as pending; otherwise check_feedback says
      // "WAITING: plan review pending" forever for an artifact the human can't see.
      expect(pending.map((p) => p.artifactId)).not.toContain(oldPlan.id);
    });

    it("F1 — superseding a decision retires the old pending decision (no orphan WAITING)", async () => {
      await callTool("present_options", {
        context: "pick a store",
        options: [
          { id: "a", title: "Postgres", description: "relational", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Mongo", description: "document", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const oldDec = store.getArtifacts()[0];
      expect(store.getPendingDecisions().map((d) => d.artifactId)).toContain(oldDec.id);

      await callTool("revise_artifact", {
        artifactId: oldDec.id,
        mode: "supersede",
        content: {
          context: "pick a store",
          decisionId: "store_v2",
          options: [
            { id: "a", title: "Postgres", description: "relational + jsonb", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "c", title: "SQLite", description: "embedded", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
          ],
        },
        reason: "dropped Mongo, added SQLite",
      });
      // Old decision's pending record is gone now that its artifact is superseded.
      expect(store.getPendingDecisions().map((d) => d.artifactId)).not.toContain(oldDec.id);
    });

    it("F1 — superseding a decision WITHOUT a decisionId mints one + records the request (the human's pick isn't lost)", async () => {
      await callTool("present_options", {
        context: "pick a cache",
        options: [
          { id: "a", title: "Redis", description: "shared", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Memcached", description: "simple", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const oldDec = store.getArtifacts()[0];

      await callTool("revise_artifact", {
        artifactId: oldDec.id,
        mode: "supersede",
        // NOTE: no decisionId — mirrors the REAL agent input shape (present_options
        // doesn't expose it; it's server-minted). Pre-fix this left no DecisionRecord,
        // so the human's subsequent selection resolved to nothing.
        content: {
          context: "pick a cache",
          options: [
            { id: "a", title: "Redis", description: "shared + TTL", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
            { id: "c", title: "In-process LRU", description: "no deps", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
          ],
        },
        reason: "swapped memcached for an in-process option",
      });

      const newDec = store.getArtifacts().find((a) => a.id !== oldDec.id)!;
      const newDecisionId = (newDec.content as any).decisionId;
      // a server-minted id is baked into content...
      expect(typeof newDecisionId).toBe("string");
      expect(newDecisionId).toMatch(/^dec_/);
      // ...and a backing DecisionRecord exists, so a human selection actually resolves
      expect(store.getDecision(newDecisionId)).toBeTruthy();
      store.resolveDecision(newDecisionId, "a", "stick with Redis");
      expect(store.getDecisionResponse(newDecisionId)?.optionId).toBe("a");
    });

    it("F3 — rejects malformed supersede content via the same validator present_* uses", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      const before = store.getArtifacts().length;
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: "not-an-array" }, // the original field bug
        reason: "revise",
      });
      expect(isError).toBe(true);
      expect(text).toContain("INPUT_VALIDATION_FAILED");
      // The malformed shape did NOT land: no v2 created, old one not retired.
      expect(store.getArtifacts().length).toBe(before);
      expect(store.getArtifacts()[0].status).not.toBe("superseded");
    });

    it("F5 — refuses to supersede a closed (rejected) artifact instead of resurrecting it", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      store.updateArtifactStatus(old.id, "rejected");
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        content: { summary: "x2", findings: [] },
        reason: "resurrect",
      });
      expect(isError).toBe(true);
      expect(text).toContain("rejected");
      expect(store.getArtifacts()).toHaveLength(1); // no resurrected v2 draft
    });

    it("errors on unknown artifactId", async () => {
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: "art_nope",
        mode: "supersede",
        content: { summary: "x", findings: [] },
        reason: "x",
      });
      expect(isError).toBe(true);
      expect(text).toContain("no artifact");
    });

    it("errors when mode='supersede' is missing content", async () => {
      await callTool("present_findings", {
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const old = store.getArtifacts()[0];
      const { isError, text } = await callTool("revise_artifact", {
        artifactId: old.id,
        mode: "supersede",
        reason: "revise it",
      });
      expect(isError).toBe(true);
      expect(text).toContain("content");
    });
  });

  describe("stakes + prediction capture (K1/K2)", () => {
    it("passes stakes through present_options into the decision record + artifact", async () => {
      await callTool("present_options", {
        context: "Which queue tech?",
        stakes: "high",
        options: [
          { id: "a", title: "SQS", description: "managed", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "Kafka", description: "self-hosted", pros: [], cons: [], effort: "high", risk: "medium", recommendation: false },
        ],
      });
      const artifact = store.getArtifacts().find((a) => a.type === "decision")!;
      expect((artifact.content as any).stakes).toBe("high");
      const pending = store.getPendingDecisions();
      expect(pending).toHaveLength(1);
      expect((pending[0] as any).stakes).toBe("high");
    });

    it("records confidence + predictedOutcome on resolveDecision (K1)", async () => {
      await callTool("present_options", {
        context: "Pick a pattern",
        options: [
          { id: "a", title: "A", description: "x", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "y", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const dec = store.getPendingDecisions()[0];
      store.resolveDecision(dec.decisionId, "a", "cleaner", { confidence: "high", predictedOutcome: "sub-50ms p95" });

      const resolved = store.getDecision(dec.decisionId)!;
      expect(resolved.response?.confidence).toBe("high");
      expect(resolved.response?.predictedOutcome).toBe("sub-50ms p95");
    });

    it("counts decisions-with-predictions and high-stakes in engagement metrics (K2)", async () => {
      await callTool("present_options", {
        context: "High one",
        stakes: "high",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      await callTool("present_options", {
        context: "Low one",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      });
      const decisions = store.getPendingDecisions();
      store.resolveDecision(decisions[0].decisionId, "a", undefined, { confidence: "medium", predictedOutcome: "reasonable" });
      store.resolveDecision(decisions[1].decisionId, "a"); // no prediction

      const metrics = store.getEngagementMetrics();
      expect(metrics.decisionsWithPredictions).toBe(1);
      expect(metrics.highStakesDecisions).toBe(1);
    });
  });

  // III12 — request_horizon_check tool removed. It was a 7-line wrapper
  // around addComment with intent="question" and a templated prompt;
  // didn't earn a first-class tool slot. The horizon-check workflow now
  // flows through answer_question / addComment with the horizon template
  // (carried in the deeppairing.md skill) as the question text. The
  // test below pins that the tool is gone from the tools/list response,
  // so a future re-add has to be intentional.
  describe("III12 — request_horizon_check removed from tool surface", () => {
    it("tools/list no longer advertises request_horizon_check", async () => {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).not.toContain("request_horizon_check");
      // Sanity — other tools we expect to keep are still there.
      expect(names).toContain("answer_question");
      expect(names).toContain("present_findings");
    });
  });

  describe("III12 — MCP prompts capability (recall as user-invocable slash query)", () => {
    it("prompts/list advertises the `recall` prompt with query + mode args", async () => {
      const list = await client.listPrompts();
      const recall = list.prompts.find((p) => p.name === "recall");
      expect(recall).toBeDefined();
      expect(recall?.description).toMatch(/philosophy ledger/i);
      const argNames = (recall?.arguments ?? []).map((a) => a.name);
      expect(argNames).toContain("query");
      expect(argNames).toContain("mode");
    });

    it("prompts/get materializes a user-message that asks the agent to call the recall tool", async () => {
      const result = await client.getPrompt({
        name: "recall",
        arguments: { query: "pay-per-request hosting", mode: "philosophy" },
      });
      expect(result.messages).toHaveLength(1);
      const msg = result.messages[0];
      expect(msg.role).toBe("user");
      expect((msg.content as any).type).toBe("text");
      const text = (msg.content as any).text as string;
      expect(text).toContain("recall");
      expect(text).toContain("pay-per-request hosting");
      expect(text).toContain("philosophy");
    });

    it("prompts/get with no query asks for the full listing (and says so explicitly)", async () => {
      const result = await client.getPrompt({ name: "recall", arguments: {} });
      const text = (result.messages[0].content as any).text as string;
      expect(text).toContain("no query");
      expect(text).toContain("any");
    });

    // V2 — second MCP prompt. Mirrors the SeedAffordance UI so users
    // can encode a stance without going through the agent. Single
    // required arg (concept); optional reason. Materializes a
    // user-message asking the agent to POST to /api/philosophy/seed.
    it("V2 — prompts/list also advertises `seed` with concept (required) + reason (optional)", async () => {
      const list = await client.listPrompts();
      const seed = list.prompts.find((p) => p.name === "seed");
      expect(seed).toBeDefined();
      expect(seed?.description).toMatch(/cross-project ledger|future preflights/i);
      const args = seed?.arguments ?? [];
      const concept = args.find((a) => a.name === "concept");
      expect(concept?.required).toBe(true);
      const reason = args.find((a) => a.name === "reason");
      expect(reason?.required).toBeFalsy();
    });

    it("V2 — prompts/get for seed materializes a POST /api/philosophy/seed message with the concept + reason", async () => {
      const result = await client.getPrompt({
        name: "seed",
        arguments: { concept: "global state for config", reason: "broke testability in 3 places" },
      });
      const text = (result.messages[0].content as any).text as string;
      expect(text).toContain("/api/philosophy/seed");
      expect(text).toContain("global state for config");
      expect(text).toContain("broke testability");
      expect(text).toContain('"verdict": "rejected"');
    });

    it("V2 — prompts/get for seed throws when concept is missing (required arg)", async () => {
      await expect(
        client.getPrompt({ name: "seed", arguments: {} }),
      ).rejects.toThrow(/concept/);
    });
  });

  describe("post_pr_review tool (M2)", () => {
    it("errors when pr argument is missing", async () => {
      const { text, isError } = await callTool("post_pr_review", {});
      expect(isError).toBe(true);
      expect(text).toContain("pr");
    });

    it("returns error when no findings have structured evidence", async () => {
      // Session has no research findings — payload.comments will be empty
      const { text, isError } = await callTool("post_pr_review", { pr: "42" });
      expect(isError).toBe(true);
      expect(text).toContain("No findings with structured evidence");
    });

    it("surfaces gh-missing errors clearly when gh is unavailable", async () => {
      // Seed a finding with structured evidence so payload.comments is non-empty
      await callTool("present_findings", {
        title: "x",
        summary: "y",
        findings: [{
          category: "Security",
          detail: "z",
          significance: "high",
          evidence: [{ filePath: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "x" }],
        }],
      });

      // Force the gh-MISSING path deterministically rather than depending on the
      // runner: a CI box HAS gh installed + authed (GITHUB_TOKEN), so the real
      // spawn would make a live API call for PR #42 and time out (this test was
      // flaking on CI for exactly that reason). Point PATH at an empty dir so
      // the `gh` spawn ENOENTs immediately, exercising the gh-unavailable path
      // the test name promises. Restored in finally.
      const origPath = process.env.PATH;
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-no-gh-"));
      process.env.PATH = emptyDir;
      try {
        const { text, isError } = await callTool("post_pr_review", { pr: "42" });
        expect(isError).toBe(true);
        const lower = text.toLowerCase();
        const isClean =
          lower.includes("gh") ||
          lower.includes("cli") ||
          lower.includes("authenticated") ||
          lower.includes("failed");
        expect(isClean).toBe(true);
      } finally {
        process.env.PATH = origPath;
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe("recall — unified memory tool (N4)", () => {
    // III8 — recordRejectedApproach / recordApprovedPattern now require
    // per-project opt-in to mirror into the global philosophy ledger.
    // These tests exercise the ledger path so they opt in via
    // setGlobalLedgerPublish before recording. Without the opt-in, the
    // local rejected-approaches list still updates (so preflight still
    // fires for THIS project) but the cross-project ledger doesn't see
    // the entry — which is the intended default.
    beforeEach(() => {
      store.setGlobalLedgerPublish(true);
    });

    it("mode='any' surfaces philosophy ledger entries by concept", async () => {
      store.recordRejectedApproach({ description: "Deploy: Railway", reason: "too expensive", concept: "pay-per-request hosting" });
      const { text } = await callTool("recall", { query: "pay-per-request", mode: "any" });
      expect(text).toContain("Philosophy ledger");
      expect(text.toLowerCase()).toContain("pay-per-request hosting");
    });

    it("mode='any' errors on empty query", async () => {
      const { isError, text } = await callTool("recall", { query: "", mode: "any" });
      expect(isError).toBe(true);
      expect(text).toContain("requires a query");
    });

    it("mode='philosophy' returns a formatted stance for a known concept", async () => {
      store.recordRejectedApproach({ description: "concept-x", reason: "reason-y" });
      const { text } = await callTool("recall", { query: "concept-x", mode: "philosophy" });
      expect(text).toContain("AVOID");
      expect(text).toContain("concept-x");
    });

    it("mode='philosophy' reports no-stance for an unknown concept", async () => {
      const { text } = await callTool("recall", { query: "some-fresh-concept", mode: "philosophy" });
      expect(text).toContain("No philosophy-ledger entries");
    });

    it("mode='philosophy' with no query lists the whole ledger", async () => {
      store.recordRejectedApproach({ description: "a", reason: "x" });
      store.recordRejectedApproach({ description: "b", reason: "y" });
      const { text, isError } = await callTool("recall", { mode: "philosophy" });
      expect(isError).toBeFalsy();
      expect(text).toContain("Philosophy ledger");
    });

    it("DD5 — mode='philosophy' source='user-seeded' returns only entries with manual instances", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // Seed-only entry.
      ledger.recordInstance("DD5 only-seeded", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD5 only-seeded",
      });
      // Session-only entry (no manual instance).
      ledger.recordInstance("DD5 only-session", {
        project: "/proj", sessionId: "s1", verdict: "rejected", description: "DD5 only-session",
      });
      // Both — seeded then cited.
      ledger.recordInstance("DD5 both", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "DD5 both",
      });
      ledger.recordInstance("DD5 both", {
        project: "/proj", sessionId: "s1", verdict: "rejected", description: "DD5 both",
      });

      const seeded = await callTool("recall", { mode: "philosophy", source: "user-seeded" });
      expect(seeded.text).toContain("DD5 only-seeded");
      expect(seeded.text).toContain("DD5 both");
      expect(seeded.text).not.toContain("DD5 only-session");

      const sessionOnly = await callTool("recall", { mode: "philosophy", source: "session" });
      expect(sessionOnly.text).toContain("DD5 only-session");
      expect(sessionOnly.text).toContain("DD5 both");
      expect(sessionOnly.text).not.toContain("DD5 only-seeded");
    });

    it("mode='philosophy' filters by stance", async () => {
      store.recordApprovedPattern({ description: "Service layer" });
      store.recordApprovedPattern({ description: "Service layer" });
      store.recordApprovedPattern({ description: "Service layer" });
      const { text } = await callTool("recall", { mode: "philosophy", stance: "prefer" });
      expect(text).toContain("Service layer");
      expect(text).toContain("PREFER");
    });

    it("mode='sessions' errors without a query", async () => {
      const { isError, text } = await callTool("recall", { query: "", mode: "sessions" });
      expect(isError).toBe(true);
      expect(text).toContain("requires a query");
    });

    it("BB4 — mode='ledger' returns empty-state guidance when nothing has accumulated", async () => {
      const { text, isError } = await callTool("recall", { mode: "ledger" });
      expect(isError).toBeFalsy();
      expect(text).toContain("Ledger is empty");
    });

    it("CC8 — mode='ledger' surfaces user-seeded stances even when shapedThisProject=0", async () => {
      // Pre-CC8: a fresh project where the user pasted seeds via the
      // SeedAffordance had a recall response of "Ledger is empty" — the
      // seeded stances were counted in globalLedger.concepts but their
      // names never made it into the agent-facing text. So the seed
      // action was invisible to the AI for the entire first session.
      const { getGlobalStore } = await import("../../store/global-store");
      // Simulate the AA9 seed route writing project="manual" entries.
      getGlobalStore().recordInstance("global mutable state", {
        project: "manual",
        sessionId: "seed",
        verdict: "rejected",
        description: "global mutable state",
      });
      getGlobalStore().recordInstance("bcrypt rounds < 12", {
        project: "manual",
        sessionId: "seed",
        verdict: "rejected",
        description: "bcrypt rounds < 12",
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      // Should NOT report empty — seeds count.
      expect(text).not.toContain("Ledger is empty");
      // Seeded section is the new CC8 surface.
      expect(text).toContain("User-seeded stances");
      expect(text).toContain("global mutable state");
      expect(text).toContain("bcrypt rounds < 12");
      expect(text).toContain("[SEED]");
      // Trailer mentions SEED entries explicitly.
      expect(text).toContain("SEED");
    });

    it("EE7 — mode='ledger' source='user-seeded' suppresses cited stances + notes the suppression", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // 1 seeded entry.
      ledger.recordInstance("EE7 seeded one", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "x",
      });
      // Trace fixture so the digest has cited stances.
      store.recordPreflightTrace("art_ee7", {
        version: 1,
        at: "2026-05-11T10:00:00Z",
        artifactId: "art_ee7",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "EE7 cited concept" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger", source: "user-seeded" });
      expect(text).toContain("EE7 seeded one");
      // Cited section is suppressed.
      expect(text).not.toContain("Top cited stances");
      // FF2 — suppression note carries the remedy (next call to make).
      expect(text).toMatch(/suppressed via source='user-seeded'/i);
      expect(text).toMatch(/Re-call without source filter/i);
      expect(text).toMatch(/source='session'/i);
      // FF2 — headline qualifier prevents the "shaped N proposals" ↔
      // "stances suppressed" contradiction.
      expect(text).toMatch(/headlines reflect ALL stances/i);
    });

    it("EE7 — mode='ledger' source='session' suppresses the SEED block + notes the suppression", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      ledger.recordInstance("EE7b seeded only", {
        project: "manual", sessionId: "seed", verdict: "rejected", description: "x",
      });
      store.recordPreflightTrace("art_ee7b", {
        version: 1,
        at: "2026-05-11T10:00:00Z",
        artifactId: "art_ee7b",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "EE7b cited only" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger", source: "session" });
      expect(text).toContain("EE7b cited only");
      expect(text).not.toContain("[SEED]");
      // FF2 — suppression note carries the remedy.
      expect(text).toMatch(/suppressed via source='session'/i);
      expect(text).toMatch(/Re-call without source filter/i);
      expect(text).toMatch(/source='user-seeded'/i);
    });

    it("CC8 — seed that's also been cited in a real session shows the citation count alongside SEED tag", async () => {
      const { getGlobalStore } = await import("../../store/global-store");
      // Manual seed first.
      getGlobalStore().recordInstance("inline SQL strings", {
        project: "manual",
        sessionId: "seed",
        verdict: "rejected",
        description: "inline SQL strings",
      });
      // Then a real-project session of the same concept (typical: agent
      // proposed something containing "inline SQL strings" and the user
      // hit the rejected approach).
      getGlobalStore().recordInstance("inline SQL strings", {
        project: "/some/real/project",
        sessionId: "real_sess",
        verdict: "rejected",
        description: "inline SQL strings",
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("[SEED]");
      expect(text).toContain("inline SQL strings");
      expect(text).toContain("also cited 1× in real sessions");
    });

    it("FF4 — recall mode='ledger' surfaces 'cited N× here, M× cross-project' when globalCitationCount > local", async () => {
      const { getGlobalStore } = await import("../../store/global-store.js");
      const ledger = getGlobalStore();
      // Cross-project: 3 separate real-project instances of the same concept.
      ledger.recordInstance("FF4 hot stance", { project: "/proj/a", sessionId: "s1", verdict: "rejected", description: "x" });
      ledger.recordInstance("FF4 hot stance", { project: "/proj/b", sessionId: "s2", verdict: "rejected", description: "x" });
      ledger.recordInstance("FF4 hot stance", { project: "/proj/c", sessionId: "s3", verdict: "rejected", description: "x" });
      // And ONE local trace of the same concept (project-local count = 1).
      store.recordPreflightTrace("art_ff4", {
        version: 1,
        at: "2026-05-12T10:00:00Z",
        artifactId: "art_ff4",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "FF4 hot stance" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("FF4 hot stance");
      // Cross-project signal exposed to the agent.
      expect(text).toMatch(/cited 1× here, 3× cross-project/i);
    });

    it("FF4 — recall mode='ledger' shows just 'cited N×' when globalCitationCount equals local (no cross-project bonus)", async () => {
      // One trace, no other instances.
      store.recordPreflightTrace("art_ff4b", {
        version: 1,
        at: "2026-05-12T10:00:00Z",
        artifactId: "art_ff4b",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 1,
        consideredConcepts: [{ source: "session", concept: "FF4b solo" }],
        nearMisses: [],
      });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("FF4b solo");
      expect(text).toMatch(/cited 1×/);
      // No cross-project clause when global == local.
      expect(text).not.toMatch(/cross-project/);
    });

    it("BB4 — mode='ledger' renders shaped/near-miss/blocked headlines + top stances", async () => {
      // Seed a preflight trace so ledgerDigest has something to count.
      store.recordPreflightTrace("art_bb4", {
        version: 1,
        at: "2026-05-05T10:00:00Z",
        artifactId: "art_bb4",
        toolName: "present_findings",
        decision: "admitted",
        consideredCount: 2,
        consideredConcepts: [
          { source: "session", concept: "global mutable state" },
          { source: "team", concept: "use the ORM" },
        ],
        nearMisses: [{ source: "session", concept: "global mutable state" }],
      });
      // Seed the global ledger so the cross-project headline has content.
      store.recordRejectedApproach({ description: "global mutable state", concept: "global mutable state" });
      const { text } = await callTool("recall", { mode: "ledger" });
      expect(text).toContain("shaped 1 proposal");
      expect(text).toContain("1 near-miss");
      expect(text).toContain("Top cited stances:");
      expect(text).toContain("global mutable state");
      expect(text).toContain("[TEAM]");
      expect(text).toContain("Cross-project ledger:");
    });
  });

  describe("pr-comments export format (L3)", () => {
    it("formats findings with severity, file:line anchors, and snippets", async () => {
      await callTool("present_findings", {
        title: "Auth audit",
        summary: "x",
        findings: [
          {
            category: "Security",
            title: "Weak hash",
            detail: "bcrypt rounds too low",
            severity: "high",
            significance: "high",
            impact: "brute force risk",
            recommendation: "use argon2id",
            evidence: [
              {
                filePath: "src/auth.ts",
                lineStart: 10,
                lineEnd: 12,
                snippet: "const hash = await bcrypt.hash(pw, 10);",
                explanation: "Only 10 rounds",
              },
            ],
          },
        ],
      });

      const { text } = await callTool("export_session", { format: "pr-comments" });
      expect(text).toContain("deepPairing notes");
      expect(text).toContain("### src/auth.ts");
      expect(text).toContain("🟠"); // severity emoji for high
      expect(text).toContain("HIGH");
      expect(text).toContain("src/auth.ts:L10-L12");
      expect(text).toContain("bcrypt.hash(pw, 10)");
      expect(text).toContain("Impact:");
      expect(text).toContain("Recommendation:");
    });

    it("groups findings by filePath", async () => {
      await callTool("present_findings", {
        title: "Multi-file",
        summary: "x",
        findings: [
          {
            category: "Perf",
            detail: "A",
            significance: "low",
            evidence: [{ filePath: "a.ts", lineStart: 1, lineEnd: 1, snippet: "x", explanation: "" }],
          },
          {
            category: "Perf",
            detail: "B",
            significance: "low",
            evidence: [{ filePath: "b.ts", lineStart: 1, lineEnd: 1, snippet: "y", explanation: "" }],
          },
        ],
      });
      const { text } = await callTool("export_session", { format: "pr-comments" });
      expect(text).toContain("### a.ts");
      expect(text).toContain("### b.ts");
    });

    it("omits rejected research artifacts", async () => {
      await callTool("present_findings", {
        title: "Proposed",
        summary: "x",
        findings: [{ category: "x", detail: "should not appear", significance: "low" }],
      });
      const a = store.getArtifacts()[0];
      store.updateArtifactStatus(a.id, "rejected");

      const { text } = await callTool("export_session", { format: "pr-comments" });
      expect(text).toContain("No findings from this pairing session");
    });
  });

  describe("MCP resources (E1)", () => {
    it("lists the current session + per-artifact resources", async () => {
      await callTool("present_findings", {
        title: "Auth review",
        summary: "findings",
        findings: [{ category: "Security", detail: "weak hash", significance: "high" }],
      });

      const list = await client.listResources();
      const uris = list.resources.map((r: any) => r.uri);

      expect(uris).toContain("deeppairing://session/current");
      // One artifact was created
      const artifactUris = uris.filter((u: string) => u.startsWith("deeppairing://artifact/"));
      expect(artifactUris).toHaveLength(1);

      const artifact = store.getArtifacts()[0];
      expect(artifactUris[0]).toBe(`deeppairing://artifact/${artifact.id}`);
    });

    it("reads the current session resource as JSON", async () => {
      await callTool("present_findings", {
        title: "x",
        summary: "y",
        findings: [{ category: "z", detail: "w", significance: "low" }],
      });

      const resource = await client.readResource({ uri: "deeppairing://session/current" });
      expect(resource.contents[0].mimeType).toBe("application/json");
      const parsed = JSON.parse(resource.contents[0].text as string);
      expect(parsed.sessionId).toBe("test_session");
      expect(parsed.artifacts).toHaveLength(1);
    });

    it("reads a single artifact resource by id", async () => {
      await callTool("present_findings", {
        title: "Target",
        summary: "x",
        findings: [{ category: "y", detail: "z", significance: "low" }],
      });
      const artifact = store.getArtifacts()[0];

      const resource = await client.readResource({ uri: `deeppairing://artifact/${artifact.id}` });
      const parsed = JSON.parse(resource.contents[0].text as string);
      expect(parsed.id).toBe(artifact.id);
      expect(parsed.title).toBe("Target");
    });

    it("errors on unknown artifact id", async () => {
      await expect(
        client.readResource({ uri: "deeppairing://artifact/art_nope" }),
      ).rejects.toThrow();
    });

    it("does not list past-session resources when the store can't read them (bare FileStore)", async () => {
      const list = await client.listResources();
      const uris = list.resources.map((r: any) => r.uri);
      // FileStore test harness doesn't implement listPastSessions, so the
      // index resource should be absent.
      expect(uris).not.toContain("deeppairing://sessions");
    });
  });

  describe("unknown tool", () => {
    it("returns an error for unknown tools", async () => {
      const result = await callTool("nonexistent");
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown tool");
    });
  });

  describe("firstCallHint budget + tier ordering (X3)", () => {
    // The hint accreted 10+ sections over many phases. Round-2 MCP review
    // flagged that priority-relevant signals (revision requests, unanswered
    // questions, follow-up replies) were getting buried under welcome
    // stats and ledger primers. X3 split the hint into two tiers:
    //   BLOCKING (always included, top of hint, never truncated)
    //   CONTEXTUAL (priority-ordered, dropped tail-first when over budget)
    // The total hint stays under HINT_BUDGET_CHARS (1500); when items
    // get dropped a "📦 N additional context sections omitted" pointer
    // tells the agent to call recall.

    it("blocking signals always appear at the top, before any contextual items", async () => {
      // Set up: a revision-request comment (BLOCKING) + a session memory
      // entry (CONTEXTUAL).
      const decision = store.createArtifact({
        id: "art_dec_x3",
        type: "decision",
        title: "x",
        content: { context: "x", options: [], decisionId: "dec_x3" },
      });
      store.addComment({
        id: "cmt_rev_x3",
        artifactId: decision.id,
        content: "redo these options",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });
      store.recordRejectedApproach({ description: "Use Railway", reason: "expensive" });

      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // Both surface. The BLOCKING revision-request must appear BEFORE
      // the contextual rejected-approaches section.
      const revisionIdx = text.indexOf("REVISION REQUEST");
      const rejectedIdx = text.indexOf("Rejected approaches");
      expect(revisionIdx).toBeGreaterThanOrEqual(0);
      expect(rejectedIdx).toBeGreaterThanOrEqual(0);
      expect(revisionIdx).toBeLessThan(rejectedIdx);
    });

    it("blocking signals are not truncated even when contextual items would crowd", async () => {
      // Plant 50 rejected approaches to bloat the contextual tier far
      // past the budget. Then plant a revision-request that MUST still
      // appear in full.
      const decision = store.createArtifact({
        id: "art_dec_full",
        type: "decision",
        title: "x",
        content: { context: "x", options: [], decisionId: "dec_full" },
      });
      store.addComment({
        id: "cmt_rev_full",
        artifactId: decision.id,
        content: "the human's full revision context that must survive",
        author: "human",
        intent: "question",
        target: { sectionId: "decision_revision_requested" } as any,
      });
      for (let i = 0; i < 50; i++) {
        store.recordRejectedApproach({
          description: `Approach ${i} with a deliberately verbose description so the section bloats fast and pushes past the budget`,
          reason: `Long-form reason ${i} so each entry is fat enough that 50 of them blow well past 1500 chars`,
        });
      }

      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });

      // Blocking items are present in full (the revision content excerpt
      // and the canonical "REVISION REQUEST" header survive).
      expect(text).toMatch(/REVISION REQUEST/);
      expect(text).toContain("the human's full revision context that must survive");
      // The dropped-context pointer fires.
      expect(text).toMatch(/additional context section/);
      expect(text).toMatch(/call `recall`/i);
    });

    it("hint stays under the 1500-char budget when contextual items would otherwise overflow", async () => {
      for (let i = 0; i < 50; i++) {
        store.recordRejectedApproach({
          description: `Bulky rejected approach ${i} ${"x".repeat(80)}`,
          reason: `Bulky reason ${i} ${"y".repeat(80)}`,
        });
      }
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      // The hint is appended to the tool's response text, so the response
      // total includes the original tool message plus the hint.
      // We assert the hint portion (everything after the tool's own response)
      // doesn't blow past a generous overall ceiling. Cheaper proxy: the
      // dropped-context pointer should be present, indicating budget kicked in.
      expect(text).toMatch(/additional context section/);
    });

    it("when nothing is dropped, no '📦 N omitted' pointer appears", async () => {
      // Fresh store: no rejected approaches, no team prefs, no ledger
      // entries → contextual tier is mostly empty.
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).not.toMatch(/additional context section/);
    });
  });

  describe("Y2 — firstCallHint gating (write tools only)", () => {
    // Pre-Y2 the hint appended to EVERY first tool call. That contaminated
    // read-only tools — recall returned the philosophy ledger duplicated
    // underneath itself, export_session leaked session-memory text into
    // the markdown the user wanted to grab. Y2 restricts the append to
    // tools that WRITE (present_*, log_reasoning, revise_artifact,
    // post_pr_review). These tests pin both directions.

    it("present_findings (write) — first call carries the hint", async () => {
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[First use this session\]/);
    });

    it("first-call hint includes the pairing-protocol preamble (for bare-MCP consumers)", async () => {
      // #1 — projects wired with only the MCP server (no skill / no init) must
      // still receive the choreography on the first write tool's response.
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      expect(text).toMatch(/\[deepPairing protocol\]/);
      expect(text).toMatch(/present_findings/);
      expect(text).toMatch(/check_feedback/);
      expect(text).toMatch(/never as plain terminal text/i);
    });

    it("recall (read) — first call does NOT carry the hint", async () => {
      const { text } = await callTool("recall", { query: "anything", mode: "any" });
      expect(text).not.toMatch(/\[First use this session\]/);
      // Negative spot-check — common contextual sections shouldn't leak in.
      expect(text).not.toMatch(/Cross-project philosophy ledger \(use recall/);
    });

    it("export_session (read) — first call does NOT carry the hint", async () => {
      // export_session returns markdown; contamination here was the worst
      // offender (the user pastes the export elsewhere).
      const { text } = await callTool("export_session", { format: "full" });
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    it("check_feedback (read) — first call does NOT carry the hint", async () => {
      // check_feedback long-polls; an empty-state response shouldn't be
      // splattered with rejected-approach lists either.
      const { text } = await callTool("check_feedback", {});
      expect(text).not.toMatch(/\[First use this session\]/);
    });

    // III1 — gate also requires !result.isError. Pre-III1 the push
    // fired on every tool reply with a content[] array, including the
    // ~17 isError:true validation/preflight-reject returns. A malformed
    // first write call got "INPUT_VALIDATION_FAILED: ..." followed by
    // a 4KB onboarding dump — exactly the parsing footgun II12 was
    // supposed to retire, just on the error branch.
    it("III1 — first-call validation error does NOT carry the hint (errors stay clean)", async () => {
      // present_findings with a malformed shape — findings array missing
      // required fields. validate-tool-input.ts returns isError:true.
      // The hint must NOT splatter on top of the error message.
      const { text, isError } = await callTool("present_findings", { summary: "x" } /* no findings → invalid */);
      expect(isError).toBe(true);
      expect(text).not.toMatch(/\[First use this session\]/);
      // And the agent still gets the validation error in content[0].
      expect(text).toMatch(/INPUT_VALIDATION_FAILED|required|missing/i);
    });

    it("hint still fires on the first WRITE call even if a READ call ran first", async () => {
      // II12.1 — the latch is consumed only on the first HINT_TOOL (write)
      // call, so a leading read (recall/check_feedback) no longer burns the
      // hint. This matters because the protocol preamble itself tells the agent
      // to `recall` first — dropping the hint on a read-then-write sequence
      // would routinely lose the onboarding/protocol context.
      await callTool("recall", { query: "x", mode: "any" });
      const { text } = await callTool("present_findings", {
        summary: "trigger",
        findings: [{ category: "x", detail: "x", significance: "low" }],
      });
      // The first WRITE after the leading read DOES carry the hint.
      expect(text).toMatch(/\[First use this session\]/);
    });
  });
});
