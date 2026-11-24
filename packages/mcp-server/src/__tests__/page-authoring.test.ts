/**
 * #714 gap 6 — page-authoring guidance is single-sourced in page-authoring.ts.
 * The standalone guide renders it, the present_page tool description renders
 * its compressed note, and the plugin SKILL mirrors its constraints.
 *
 * Fakes, not mocks: a real in-memory MCP client/server for the live tool list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PAGE_AUTHORING_TOOL_NOTE, PAGE_CONSTRAINT_RULES, PAGE_DECISION_ATTR, PAGE_QUESTION_ATTR,
  PAGE_SKELETON_HTML, PAGE_STRUCTURE_RULES,
} from "../page-authoring.js";
import { renderStandaloneGuide, standaloneGuideJson } from "../cli/standalone-guide.js";
import { createMcpServer } from "../mcp/server.js";
import { FileStore } from "../store/file-store.js";
import { withGlobalStore } from "./global-store-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const guide = renderStandaloneGuide("node /fake/dist/cli/init.js");

/** The key constraints every surface must carry. */
const KEY_CONSTRAINTS = [/NO network|No network/, /clicks Run/, /data: URIs/, PAGE_DECISION_ATTR, PAGE_QUESTION_ATTR, /<details>/, /<section id=/, /TL;DR/, /inline SVG/];

describe("page-authoring guidance (#714 gap 6)", () => {
  it("the standalone guide carries every rule and the skeleton, verbatim", () => {
    const flat = guide.replace(/\s+/g, " ");
    for (const rule of [...PAGE_STRUCTURE_RULES, ...PAGE_CONSTRAINT_RULES]) expect(flat).toContain(rule);
    for (const line of PAGE_SKELETON_HTML.split("\n")) expect(guide).toContain(`    ${line}`);
    expect(guide).toContain("3a. WRITE A REVIEWABLE PAGE");
    expect(guide).toMatch(/Warnings never refuse a page/);
    const json = standaloneGuideJson("node /fake/dist/cli/init.js");
    expect(json.pageAuthoring.skeleton).toBe(PAGE_SKELETON_HTML);
    expect(json.pageAuthoring.structure).toEqual([...PAGE_STRUCTURE_RULES]);
  });

  it("the skeleton has no external assets and marks a decision and a question", () => {
    expect(PAGE_SKELETON_HTML).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(PAGE_SKELETON_HTML).toMatch(/<section id="/);
    expect(PAGE_SKELETON_HTML).toContain(`id="decide-ttl" ${PAGE_DECISION_ATTR}`);
    expect(PAGE_SKELETON_HTML).toContain(`id="ask-budget" ${PAGE_QUESTION_ATTR}`);
    expect(PAGE_SKELETON_HTML).toContain("<svg");
    expect(PAGE_SKELETON_HTML).toContain("<details");
  });

  it("the live present_page tool description carries the key constraints", async () => {
    const fx = withGlobalStore("dp-page-authoring-");
    const store = fx.track(new FileStore(fx.dir, "page_authoring_session"));
    try {
      const { server } = createMcpServer(store, () => {}, 4000);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(clientT);
      const { tools } = await client.listTools();
      const desc = tools.find((t) => t.name === "present_page")!.description!;
      expect(desc).toContain(PAGE_AUTHORING_TOOL_NOTE);
      for (const c of KEY_CONSTRAINTS) expect(desc).toMatch(c);
      expect(desc).toMatch(/non-blocking warnings/);
      await client.close();
    } finally {
      fx.dispose();
    }
  });

  it("the plugin SKILL mirrors the key constraints", () => {
    const skill = fs.readFileSync(path.join(repoRoot, "claude-plugin", "skills", "pairing-protocol", "SKILL.md"), "utf8").replace(/\s+/g, " ");
    for (const c of KEY_CONSTRAINTS) expect(skill).toMatch(c);
    expect(skill).toContain("page-authoring.ts");
    expect(skill).toMatch(/non-blocking warnings/);
  });
});
