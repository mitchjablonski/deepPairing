/**
 * U0.3 + U0.5 — pin the "single review surface" guidance in every present_*
 * tool description.
 *
 * Field bug context: after present_plan, Claude Code ALSO surfaced its
 * native plan-approval prompt. The user accepted in the terminal, the
 * agent proceeded, but the deepPairing artifact stayed `draft` — and the
 * Stop hook then trapped the agent in a check_feedback poll loop because
 * an unresolved draft existed. Two parallel approval surfaces is a
 * footgun; the LLM has to know to suppress the terminal-side one.
 *
 * The fix is in the tool description strings (server.ts) and in the
 * embedded CLAUDE.md protocol (init.ts). These tests pin both so a
 * future "let's clean up the descriptions" PR can't quietly drop the
 * guidance and re-open the bug.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-single-surface-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "single_surface_session");
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

describe("present_* tool descriptions carry single-review-surface guidance (U0.3)", () => {
  async function descFor(name: string): Promise<string> {
    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found in ListTools response`);
    return tool.description ?? "";
  }

  it("present_findings tells the LLM to use the companion UI as the only review surface", async () => {
    const d = await descFor("present_findings");
    expect(d).toMatch(/SINGLE REVIEW SURFACE/i);
    expect(d).toMatch(/companion UI/i);
    expect(d).toMatch(/check_feedback/i);
  });

  it("present_options tells the LLM not to also list options in chat / terminal", async () => {
    const d = await descFor("present_options");
    expect(d).toMatch(/SINGLE REVIEW SURFACE/i);
    expect(d).toMatch(/companion UI/i);
  });

  it("present_spec tells the LLM not to re-paste in chat or ask in-terminal", async () => {
    const d = await descFor("present_spec");
    expect(d).toMatch(/SINGLE REVIEW SURFACE/i);
  });

  it("present_plan tells the LLM that this REPLACES ExitPlanMode (the dual-prompt bug)", async () => {
    const d = await descFor("present_plan");
    expect(d).toMatch(/SINGLE REVIEW SURFACE/i);
    expect(d).toMatch(/ExitPlanMode/);
    expect(d).toMatch(/REPLACES/);
  });

  it("present_code_change tells the LLM not to also paste the diff into chat", async () => {
    const d = await descFor("present_code_change");
    expect(d).toMatch(/SINGLE REVIEW SURFACE/i);
  });

  // V1 — checkpoint cadence guidance, distinct from "single review surface".
  it("present_code_change is described as a per-edit checkpoint, not a one-shot for big diffs", async () => {
    const d = await descFor("present_code_change");
    expect(d).toMatch(/REQUIRED BEFORE EACH WRITE/i);
    expect(d).toMatch(/per-edit checkpoint/i);
    expect(d).toMatch(/Batched implementation .*protocol violation/i);
  });

  it("log_reasoning is described as the WHY half of the per-edit checkpoint pair", async () => {
    const d = await descFor("log_reasoning");
    expect(d).toMatch(/REQUIRED BEFORE EACH SIGNIFICANT EDIT/i);
    expect(d).toMatch(/per-edit checkpoint/i);
    expect(d).toMatch(/present_code_change/);
  });
});

describe("embedded CLAUDE.md protocol carries the same guidance (U0.5 + V3)", () => {
  // The init flow seeds CLAUDE.md with the deepPairing protocol so the agent
  // follows it on every session. The tool descriptions pin the LLM-visible
  // surface; this pins the human-readable / system-prompt-equivalent surface.
  it("init.ts EMBEDDED_PROTOCOL contains the Single Review Surface section", async () => {
    const initSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../cli/init.ts"),
      "utf-8",
    );
    expect(initSrc).toMatch(/## Single Review Surface/);
    expect(initSrc).toMatch(/ExitPlanMode/);
    expect(initSrc).toMatch(/Stop hook/);
  });

  // V3 — per-edit checkpoint cadence rule pinned in the embedded protocol.
  it("init.ts EMBEDDED_PROTOCOL contains the Per-Edit Checkpoint section", async () => {
    const initSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../cli/init.ts"),
      "utf-8",
    );
    expect(initSrc).toMatch(/## Per-Edit Checkpoint/);
    expect(initSrc).toMatch(/PostToolUse hook/);
    expect(initSrc).toMatch(/log_reasoning/);
    expect(initSrc).toMatch(/present_code_change/);
  });

  // Fix A + B — comment-reply mirror + decision-revision sections.
  it("init.ts EMBEDDED_PROTOCOL tells the agent to mirror comment replies via answer_question (Fix A)", async () => {
    const initSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../cli/init.ts"),
      "utf-8",
    );
    expect(initSrc).toMatch(/## Replying to Human Comments/);
    expect(initSrc).toMatch(/answer_question/);
    expect(initSrc).toMatch(/invisible to the conversation rail/);
  });

  it("init.ts EMBEDDED_PROTOCOL has a Decision Revision Requests section (Fix B)", async () => {
    const initSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../cli/init.ts"),
      "utf-8",
    );
    expect(initSrc).toMatch(/## Decision Revision Requests/);
    expect(initSrc).toMatch(/sectionId.*decision_revision_requested/);
    expect(initSrc).toMatch(/revise_artifact/);
    expect(initSrc).toMatch(/mode="supersede"/);
  });
});
