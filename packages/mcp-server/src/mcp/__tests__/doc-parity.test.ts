/**
 * R5 (round-13 MED) — PROSE IS NOT A GATE, pointed at the docs.
 *
 * Round-13 named the drift class that MIGRATED from code↔code to code↔doc: the
 * guardrail exclusion list is hand-copied into SECURITY.md and SKILL.md and
 * disagreed with guardrail-rules.ts (25 segments) AND with each other (22 / 19);
 * SKILL.md instructed the agent to call `reject_approach`, a tool that does not
 * exist. The round-13 meta-recommendation was to GENERALIZE the review-
 * authorization mutation test's principle ("delete the guidance, see if the
 * guarantee survives") into standing instruments for the doc-drift class.
 *
 * This is that instrument. It parses the enumerations OUT of the prose and
 * compares them to the code constants they claim to mirror, so a doc that drifts
 * from the code fails CI — the same pattern Q1's guardrail superset test uses,
 * pointed at prose:
 *
 *   1. the guardrail EXCLUSION LIST in SECURITY.md + SKILL.md === GUARDRAIL_
 *      EXCLUDED_SEGMENTS (guardrail-rules.ts).
 *   2. every TOOL NAMED in SKILL.md + the assembled first-call hint exists in
 *      the live registered tool set (the ghost-tool guard).
 *   3. the "N tools" count in CLAUDE.md === the live registered tool count.
 *
 * Fakes-not-mocks: a real in-memory MCP server for the live tool list; the docs
 * are read off disk from the repo root (same resolution guidance-flip-drift uses).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server.js";
import { buildFirstCallHint } from "../first-call-hint.js";
import { GUARDRAIL_EXCLUDED_SEGMENTS } from "../../guardrail-rules.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fx: GlobalStoreFixture;
let store: FileStore;

beforeEach(() => {
  fx = withGlobalStore("dp-doc-parity-");
  store = fx.track(new FileStore(fx.dir, "doc_parity_session"));
});

afterEach(() => {
  fx.dispose();
});

const REPO_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // __tests__ → mcp → src → mcp-server → packages → repo root
  return path.resolve(here, "../../../../..");
})();

function readDoc(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
}

/** The authoritative exclusion segments, parsed out of the shipped regex. */
function codeExcludedSegments(): string[] {
  // .source is `(^|\/)(node_modules|bower_components|...|example)(\/)`. Grab the
  // alternation body starting at node_modules and split it.
  const m = GUARDRAIL_EXCLUDED_SEGMENTS.source.match(/node_modules[^)]*/);
  if (!m) throw new Error("could not parse GUARDRAIL_EXCLUDED_SEGMENTS");
  return m[0].split("|").map((s) => s.replace(/\\/g, "")).sort();
}

/** The `seg/` tokens a doc enumerates inside its exclusion sentence. */
function docExcludedSegments(text: string): string[] {
  const span = text.match(/nothing under `node_modules\/`[\s\S]*?ever (?:prompts|asks)/);
  if (!span) throw new Error("could not find the exclusion sentence in the doc");
  const segs = new Set<string>();
  for (const t of span[0].matchAll(/`([A-Za-z0-9_.\-]+)\/`/g)) segs.add(t[1]);
  return [...segs].sort();
}

async function registeredToolNames(): Promise<Set<string>> {
  const { server } = createMcpServer(store, () => {}, 4000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "doc-parity", version: "1.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

function readSkill(): string {
  return readDoc("claude-plugin/skills/pairing-protocol/SKILL.md");
}

/** Assemble the hint across every dial + density so the whole agent-facing
 *  surface is scanned (mirrors guidance-flip-drift's assembleAllHints). */
async function assembleAllHints(): Promise<string> {
  const parts: string[] = [];
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("balanced");
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("autonomous");
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("supervised");
  store.setDetailDensity("terse");
  parts.push(await buildFirstCallHint(store, 4000));
  return parts.join("\n");
}

// A token that READS as a tool call: <tool-verb>_<noun>. The verb set is the
// prefixes of the real tools plus the action-synonyms a hallucinated tool would
// most likely use (reject/record/create/…). Deliberately does NOT include nouns
// like `file`/`code`/`drop` so `file_map`, `code_change`, `002_drop_users.sql`
// and other non-tool snake_case in the prose are not false-flagged.
const TOOL_VERBS =
  "present|check|answer|revise|update|post|withdraw|export|log|get|reject|record|create|add|remove|delete|set|retract|approve";
const TOOL_LIKE = new RegExp(`\\b(?:${TOOL_VERBS})_[a-z][a-z_]*\\b`, "g");

function toolTokens(text: string): string[] {
  return [...new Set(text.match(TOOL_LIKE) ?? [])];
}

describe("R5 — doc-parity instruments (prose → code)", () => {
  it("the guardrail exclusion list in SECURITY.md matches GUARDRAIL_EXCLUDED_SEGMENTS", () => {
    expect(docExcludedSegments(readDoc("SECURITY.md"))).toEqual(codeExcludedSegments());
  });

  it("the guardrail exclusion list in SKILL.md matches GUARDRAIL_EXCLUDED_SEGMENTS", () => {
    expect(docExcludedSegments(readSkill())).toEqual(codeExcludedSegments());
  });

  it("SECURITY.md and SKILL.md agree with EACH OTHER (they mirror the same constant)", () => {
    expect(docExcludedSegments(readDoc("SECURITY.md"))).toEqual(docExcludedSegments(readSkill()));
  });

  it("every tool-shaped token named in SKILL.md exists in the registered tool set (ghost-tool guard)", async () => {
    const registered = await registeredToolNames();
    const named = toolTokens(readSkill());
    const ghosts = named.filter((t) => !registered.has(t));
    expect(ghosts, `SKILL.md names ${ghosts.join(", ")} which are not registered MCP tools`).toEqual([]);
  });

  it("every tool-shaped token in the assembled first-call hint exists in the registered tool set", async () => {
    const registered = await registeredToolNames();
    const named = toolTokens(await assembleAllHints());
    const ghosts = named.filter((t) => !registered.has(t));
    expect(ghosts, `the first-call hint names ${ghosts.join(", ")} which are not registered MCP tools`).toEqual([]);
  });

  it("the sanity floor: the verb regex actually catches a would-be ghost", () => {
    // Guards the guard — if TOOL_LIKE stopped matching, the ghost tests would
    // pass vacuously. `reject_approach` (the round-13 ghost) must still be seen.
    expect(toolTokens("record the refusal (`reject_approach`) if standing")).toContain("reject_approach");
  });

  it("the 'N tools' count in CLAUDE.md matches the live registered tool count", async () => {
    const registered = await registeredToolNames();
    const claudeMd = readDoc("CLAUDE.md");
    const m = claudeMd.match(/(\d+)\s+tools/);
    expect(m, "CLAUDE.md no longer states a tool count").not.toBeNull();
    expect(Number(m![1])).toBe(registered.size);
  });
});

// S4 (round-14) — the ENUMERATION→CLAIM extension.
//
// The R5 instruments above parse LISTS out of prose (exclusion segments, tool
// names, a count) and compare them to code constants. They are enumeration-
// scoped, and they caught nothing when a BEHAVIORAL claim drifted in the same
// release: README:73 said the shared page carries "no code or diffs" while the
// export default (export-session.ts) has shipped `includeCode` as default-
// INCLUDE since it was written — the diffs ARE the point. A false claim on the
// top of the funnel, invisible to a list-parity net.
//
// This pins the one high-value behavioral claim that is cheaply checkable: the
// README's share-page code/diff claim must agree with the export default. Broad
// prose parsing is out of reach; a single load-bearing claim tied to a single
// code default is not.
describe("S4 — behavioral-claim parity (README ↔ export default)", () => {
  const README = () => readDoc("README.md");
  const EXPORT_SESSION = () =>
    readDoc("packages/mcp-server/src/mcp/tools/export-session.ts");

  it("the export default is INCLUDE (includeCode defaults to not-false)", () => {
    // The default lives inline in the tool handler. If someone flips it to
    // opt-in (`=== true`, or any other predicate), this pin breaks and forces
    // the README claim below to be revisited in the same change.
    expect(EXPORT_SESSION()).toMatch(
      /includeCode\s*=\s*args\?\.includeCode\s*!==\s*false/,
    );
  });

  it("README does NOT repeat the retired 'no code or diffs' share-page claim", () => {
    // The exact false phrase from README:73. It described the opt-OUT as the
    // default. Its return would re-open the drift.
    expect(README()).not.toMatch(/no code or diffs/i);
  });

  it("README states the share page carries diffs by default (matches the code)", () => {
    // The claim must be present AND true: the page includes the diffs by
    // default. Pins direction, not exact wording.
    expect(README()).toMatch(/diffs by default/i);
  });

  // S1 seam RESOLVED: the description↔schema required-field parity test lands in
  // the "S1 — description ↔ schema required-field parity" describe block below,
  // now that S1's required-field description fixes (present_debrief/changeset
  // title-required) are in this branch.
});

// S1 (round-14) — DESCRIPTION ↔ SCHEMA required-field parity (the seam S4
// deferred). The dogfood found the tool descriptions LYING about required
// fields: present_debrief said "only `summary` is required" while `title` (and
// each section's `title`) is required; present_changeset never stated `title` is
// required. S1 rewrote both descriptions to be TRUE. This instrument keeps them
// true against the schema, in the same enumeration→claim spirit as the R5/S4
// nets above: parse the fields a description CLAIMS are required out of its
// "… is/are REQUIRED" clause, and assert that set EQUALS the advertised schema's
// own top-level required set. Over-claim (naming an optional field required) and
// under-claim (a schema-required field the description forgot) both fail here.
describe("S1 — description ↔ schema required-field parity (the seam S4 deferred)", () => {
  const flatten = (s: string) => s.replace(/\s+/g, " ");

  /** The fields a description CLAIMS are required — the backticked tokens inside
   *  its "… is/are REQUIRED" clause (the clause can't cross a sentence period). */
  function declaredRequired(desc: string): string[] {
    const m = flatten(desc).match(/([^.]*?)\s+(?:is|are) REQUIRED/);
    if (!m) return [];
    return [...new Set([...m[1]!.matchAll(/`([a-zA-Z_]+)`/g)].map((t) => t[1]!))].sort();
  }

  /** The advertised schema's own top-level required set (from ListTools). */
  async function toolsWithSchema(): Promise<Record<string, { description: string; required: string[] }>> {
    const { server } = createMcpServer(store, () => {}, 4000);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "doc-parity-required", version: "1.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    const out: Record<string, { description: string; required: string[] }> = {};
    for (const t of tools) {
      const req = Array.isArray((t.inputSchema as { required?: unknown })?.required)
        ? ((t.inputSchema as { required: string[] }).required).slice().sort()
        : [];
      out[t.name] = { description: t.description ?? "", required: req };
    }
    return out;
  }

  for (const tool of ["present_debrief", "present_changeset"] as const) {
    it(`${tool}'s description names exactly the schema's required fields`, async () => {
      const info = (await toolsWithSchema())[tool]!;
      // The description must actually make a required-field claim…
      const declared = declaredRequired(info.description);
      expect(declared.length, `${tool} description makes no "… REQUIRED" claim`).toBeGreaterThan(0);
      // …and every field it claims required is genuinely required in the schema,
      // and no schema-required field is left unclaimed. Set equality both ways.
      expect(declared, `${tool}: declared=${declared} vs schema.required=${info.required}`).toEqual(info.required);
    });
  }

  it("present_debrief no longer carries the false 'only summary is required' claim", async () => {
    const info = (await toolsWithSchema())["present_debrief"]!;
    expect(info.description).not.toContain("only `summary` is required");
    // title is genuinely required in the schema (the drift the dogfood found).
    expect(info.required).toContain("title");
  });
});
