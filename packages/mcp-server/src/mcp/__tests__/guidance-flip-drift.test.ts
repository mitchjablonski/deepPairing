/**
 * #190 — the DEFAULT-MODE FLIP wording drift guard.
 *
 * Same class-ending pattern as the tool-count drift guard (server-contract.test):
 * the flip lives across THREE guidance surfaces that must agree — SKILL.md, the
 * tool descriptions, and the first-call hint (incl. its per-dial FLOOR lines).
 * A stale sentence in ANY one makes the guidance self-contradict ("batch by
 * default" vs "present_code_change BEFORE every Write/Edit is still required"),
 * and the agent picks randomly — landing hardest in AUTONOMOUS, the debrief's own
 * target mode. This test would have caught that: it pins the flip's key phrases
 * PRESENT in SKILL.md + the assembled hint, and the stale per-edit mandates
 * ABSENT from both.
 *
 * Scoped to the two known guidance files (SKILL.md + the built first-call hint
 * across every dial), so the dated CHANGELOG's historical phrasings can't
 * false-fail. Needles are specific full sentences, not loose substrings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildFirstCallHint } from "../first-call-hint.js";
import { createMcpServer } from "../server.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fx: GlobalStoreFixture;
let tmpDir: string;
let store: FileStore;

beforeEach(() => {
  fx = withGlobalStore("dp-flip-drift-");
  tmpDir = fx.dir;
  store = fx.track(new FileStore(tmpDir, "flip_drift_session"));
});

afterEach(() => {
  fx.dispose();
});

/** Assemble the hint across EVERY dial + density so the per-dial FLOOR lines
 *  (balanced / autonomous) and the terse floor are all in the scanned text. */
async function assembleAllHints(): Promise<string> {
  const parts: string[] = [];
  parts.push(await buildFirstCallHint(store, 4000)); // supervised default
  store.setAutonomyLevel("balanced");
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("autonomous");
  parts.push(await buildFirstCallHint(store, 4000));
  store.setAutonomyLevel("supervised");
  store.setDetailDensity("terse");
  parts.push(await buildFirstCallHint(store, 4000));
  return parts.join("\n");
}

/** List the live MCP tool descriptions (the highest-visibility guidance surface —
 *  injected every tool-use turn) via an in-memory client, so the drift net covers
 *  the COMPILED tool-description strings too, not just SKILL.md + the hint. */
async function readToolDescriptions(): Promise<Record<string, string>> {
  const { server } = createMcpServer(store, () => {}, 4000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "drift-test", version: "1.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const out: Record<string, string> = {};
  for (const t of tools) out[t.name] = t.description ?? "";
  await client.close();
  return out;
}

function readSkill(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // __tests__ → mcp → src → mcp-server → packages → repo root
  const repoRoot = path.resolve(here, "../../../../..");
  return fs.readFileSync(path.join(repoRoot, "claude-plugin/skills/pairing-protocol/SKILL.md"), "utf-8");
}

// The stale per-edit mandates the flip REPLACED. Their presence anywhere in the
// guidance re-introduces the contradiction Fix 1 closed.
const STALE_PHRASES: RegExp[] = [
  /present_code_change BEFORE every Write\/Edit is still required/i,
  /do NOT skip present_options or present_code_change/i,
  /BEFORE every Write\/Edit/i,
];

describe("#190 — default-mode flip: guidance wording is consistent (drift guard)", () => {
  it("SKILL.md carries the flip's key phrases", () => {
    const skill = readSkill();
    expect(skill).toMatch(/the DEFAULT for presenting code/); // changeset is default
    expect(skill).toMatch(/the \*\*exception\*\*, not the beat/); // code_change is the exception
    expect(skill).toMatch(/END EVERY feature or autonomous run/); // debrief at the end
    expect(skill).toMatch(/present_debrief/);
    expect(skill).toMatch(/\*\*sparingly\.\*\*/); // log_reasoning demoted
    // "details in chat" is a protocol violation (deliberation goes in the artifact)
    expect(skill).toMatch(/"details in chat"/);
    expect(skill).toMatch(/protocol violation/);
  });

  it("the assembled first-call hint (all dials) carries the flip's key phrases", async () => {
    const hint = await assembleAllHints();
    expect(hint).toMatch(/the DEFAULT is a batched present_changeset/);
    expect(hint).toMatch(/present_debrief — END every feature/);
    expect(hint).toMatch(/never 'details in chat'/);
    // The per-dial FLOORs mandate a review surface WITHOUT prescribing per-edit.
    expect(hint).toMatch(/PRESENTED FOR REVIEW BEFORE IT LANDS/);
    expect(hint).toMatch(/present_changeset at feature boundaries by default/);
  });

  it("#210 J2a — SKILL.md AND the assembled hint carry the size carve-out (trivial single-file close)", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    // The floor sentence stays absolute (also pinned above/below); the carve-out
    // drops ONLY the separate closing debrief for a single-file, no-decision,
    // surgical fix. Pin the carve-out present in BOTH guidance surfaces so a
    // future edit can't silently re-absolutize the debrief obligation.
    expect(skill).toMatch(/single-file, no-decision,? surgical fix/);
    expect(skill).toMatch(/self-summarizing `present_code_change`/);
    expect(hint).toMatch(/single-file, no-decision surgical fix closes with its own self-summarizing present_code_change/);
    // …and the carve-out is present in EVERY dial's FLOOR restatement (balanced +
    // autonomous each restate "end the feature with present_debrief").
    const carveOuts = hint.match(/single-file, no-decision surgical fix closes with its own self-summarizing present_code_change/g) ?? [];
    // preamble headline + step 7 + balanced FLOOR + autonomous FLOOR = at least 4.
    expect(carveOuts.length).toBeGreaterThanOrEqual(4);
  });

  it("#215 K1 — the present_debrief tool description carries the size carve-out (tool-desc drift net)", async () => {
    // F1-class fix: the tool description is injected every tool-use turn — the
    // highest-visibility guidance surface. It must honor the trivial-task carve-out
    // the preamble/SKILL/nags already carry, not re-absolutize "END EVERY … debrief".
    const descriptions = await readToolDescriptions();
    const debrief = descriptions["present_debrief"] ?? "";
    expect(debrief).toMatch(/single-file, no-decision surgical fix closes with its own self-summarizing present_code_change/);
  });

  it("NEITHER SKILL.md NOR the assembled hint contains a stale per-edit mandate", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    for (const stale of STALE_PHRASES) {
      expect(skill, `SKILL.md still contains stale phrasing: ${stale}`).not.toMatch(stale);
      expect(hint, `the first-call hint still contains stale phrasing: ${stale}`).not.toMatch(stale);
    }
  });
});
