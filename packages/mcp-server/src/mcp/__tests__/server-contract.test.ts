/**
 * D2 — split from the 3,009-line server.test.ts along tool-surface seams.
 * Test bodies are verbatim from the monolith; only the harness wiring is new.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let client: Client;
beforeEach(() => {
  store = ctx.store;
  client = ctx.client;
});

describe("MCP Tool Handlers — protocol contract", () => {
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

  describe("C1 — ToolAnnotations on every tool", () => {
    it("all 13 tools carry honest annotations; only post_pr_review is open-world; only pure reads claim readOnlyHint", async () => {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(13);
      for (const t of list.tools) {
        expect(t.annotations, `${t.name} missing annotations`).toBeDefined();
        expect(typeof (t.annotations as any).openWorldHint).toBe("boolean");
      }
      const byName = Object.fromEntries(list.tools.map((t) => [t.name, t.annotations as any]));
      // The one tool that leaves the machine.
      expect(byName.post_pr_review.openWorldHint).toBe(true);
      expect(list.tools.filter((t) => (t.annotations as any).openWorldHint).map((t) => t.name)).toEqual(["post_pr_review"]);
      // Pure reads.
      expect(byName.recall.readOnlyHint).toBe(true);
      expect(byName.export_session.readOnlyHint).toBe(true);
      // check_feedback ACKNOWLEDGES + writes ledger patterns — it must NOT
      // claim read-only, whatever its name suggests.
      expect(byName.check_feedback.readOnlyHint).toBe(false);
      expect(byName.check_feedback.idempotentHint).toBe(false);
    });
  });

  describe("C6b — visuals schema contract per tool (the dedupe must not tighten options)", () => {
    it("options advertises id-OPTIONAL visuals (auto-assigned); spec/plan require id", async () => {
      const list = await client.listTools();
      const schemaOf = (name: string) => list.tools.find((t) => t.name === name)!.inputSchema as any;
      const optVisuals = schemaOf("present_options").properties.options.items.properties.visuals.items;
      const specVisuals = schemaOf("present_spec").properties.visuals.items;
      const planVisuals = schemaOf("present_plan").properties.visuals.items;
      // The options wire validator extends PlanVisualSchema with id OPTIONAL —
      // the advertised schema must not demand what the server doesn't.
      expect(optVisuals.required).toEqual(["kind"]);
      expect(specVisuals.required).toEqual(["id", "kind"]);
      expect(planVisuals.required).toEqual(["id", "kind"]);
      // The dedupe upgraded options to advertise the FULL shape it accepts.
      expect(Object.keys(optVisuals.properties)).toEqual(Object.keys(specVisuals.properties));
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
});

describe("D4 — write-tool inputSchemas derive from the validator zod shapes", () => {
  it("advertised schemas carry the zod contracts (required sets + described fields), not hand-written copies", async () => {
    const list = await client.listTools();
    const schemaOf = (name: string) => list.tools.find((t) => t.name === name)!.inputSchema as any;

    // Root required sets — the validator's word, verbatim.
    expect(schemaOf("present_findings").required).toEqual(["summary", "findings"]);
    expect(schemaOf("present_spec").required).toContain("title"); // spec titles are validator-required
    expect(schemaOf("present_plan").required).toEqual(expect.arrayContaining(["steps", "estimatedChanges", "title"]));
    // code_change: `before` must NOT be required (validator fills ?? "") —
    // a naive derivation from the content schema would have tightened it.
    expect(schemaOf("present_code_change").required).not.toContain("before");

    // Emission must stay $ref/$defs-free: MCP clients vary in ref support,
    // and zod's `reused` default changing would silently break them.
    expect(JSON.stringify(list.tools.map((t) => t.inputSchema))).not.toMatch(/\$ref|\$defs/);

    // .describe() metadata survives into the advertisement.
    expect(schemaOf("present_findings").properties.title.description).toContain("Descriptive title");
    const finding = schemaOf("present_findings").properties.findings.items.properties;
    expect(typeof finding.significance.description).toBe("string");
  });
});
