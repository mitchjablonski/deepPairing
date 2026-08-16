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
  // P1 (round-11) — the OVER-CLAIMS. Round-11 verified these described a mechanism
  // that did not exist ("the preflight gate escalates guardrail-path edits
  // itself regardless" — the hook had zero guardrail logic). The backstop is
  // built now, but it ASKS, it does not escalate on the agent's behalf, and it
  // is silent while the arc is in flight. Re-introducing an "…regardless"
  // formulation would re-open the gap between promise and mechanism.
  /the preflight gate escalates/i,
  /escalates the edit itself regardless/i,
  /escalates guardrail-path edits regardless/i,
  // P1 — the wrong touchpoint pair. The changeset is the never-skipped floor,
  // so the real pair is changeset + debrief; a decision makes it 3.
  /\(a decision if one comes up \+ the debrief\)/i,
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

  it("#229 O1 — SKILL.md AND the assembled hint teach the risk-adaptive LOW-RISK-FEATURE class (with the floor kept absolute)", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    // The three-class, RISK-keyed framing (replaces the old size-only framing).
    expect(skill).toMatch(/Ceremony scales with RISK, not size/);
    expect(hint).toMatch(/Ceremony scales with RISK, not size/);
    // The new class itself — the centerpiece phrase, pinned in both surfaces so a
    // future prose-trim can't silently drop the risk-adaptive middle.
    expect(skill).toMatch(/Low-risk feature/);
    expect(hint).toMatch(/LOW-RISK FEATURE/);
    // Its defining predicate: multi-file work, NO guardrail path, MAY skip the
    // synchronous pre-work gates.
    expect(skill).toMatch(/skip[\s\S]*present_findings[\s\S]*spec\/plan gate/);
    expect(hint).toMatch(/skip the synchronous pre-work gates \(present_findings and the spec\/plan gate\)/);
    // The FLOOR stays absolute in BOTH surfaces — the license trims pre-work
    // ceremony, never the changeset review of the code itself.
    expect(skill).toMatch(/floor is absolute at every class/i);
    expect(hint).toMatch(/THE FLOOR IS ABSOLUTE at every class/);
  });

  it("P1 (round-11) — SKILL.md AND the assembled hint describe the guardrail BACKSTOP exactly as built", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    // The four defining facts of the shipped mechanism, pinned in both surfaces.
    // Behaviour itself is pinned in cli/__tests__/guardrail-backstop*.test.ts;
    // these keep the WORDS from drifting away from that behaviour again.
    // 1. it ASKS (never denies, never blocks).
    expect(skill).toMatch(/permissionDecision: "ask"/);
    expect(skill).toMatch(/never `deny`s, it never blocks the edit outright/);
    expect(hint).toMatch(/pauses the edit and asks your pair to confirm/);
    expect(hint).toMatch(/never blocks the edit outright/);
    // 2. the TRIGGER: a guardrail-path write with no live pre-work ceremony.
    expect(skill).toMatch(/NO `research` \(findings\), `decision`\s*\n?\s*\(options\), `spec`, or `plan` artifact is live in the session/);
    expect(hint).toMatch(/while NO findings, options, spec, or plan is live in the session/);
    // 3. the SILENCE condition — the escalated arc in flight passes.
    expect(skill).toMatch(/the write passes silently/);
    expect(hint).toMatch(/stays SILENT once that pre-work arc is in flight/);
    // 4. the dedup + fail-open contract.
    expect(skill).toMatch(/once per\s*\n?\s*guardrail class per 30 minutes/);
    expect(hint).toMatch(/at most once per guardrail class per 30 minutes/);
    expect(skill).toMatch(/fail-open/);
    expect(hint).toMatch(/fails open/);
  });

  it("P1 (round-11) — both surfaces name the corrected touchpoint arithmetic (changeset + debrief, a decision makes 3)", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    expect(skill).toMatch(/the changeset\s*\n?\s*\(the never-skipped floor\) and the debrief; a decision, if one comes up, makes 3/);
    expect(hint).toMatch(/the changeset \(the never-skipped floor\) and the debrief; a decision, if one comes up, makes 3/);
  });

  it("P1 (round-11) — the happy-path list marks the ESCALATED-ONLY steps (it agrees with the three classes above it)", async () => {
    const hint = await assembleAllHints();
    // The list header says what the list IS…
    expect(hint).toMatch(/Happy path, in order — this is the ESCALATED arc in full/);
    // …and the two pre-work gates the other classes skip carry the tag.
    expect(hint).toMatch(/2\. present_findings — \[ESCALATED ONLY\]/);
    expect(hint).toMatch(/5\. present_spec and\/or present_plan — \[ESCALATED ONLY\]/);
  });

  it("P1 (round-11) — the documented step-1 recall invocation is VALID (mode='any' requires a query)", async () => {
    const hint = await assembleAllHints();
    const skill = readSkill();
    const descriptions = await readToolDescriptions();
    expect(hint).toMatch(/recall \(mode='any', query='<the concept you're about to propose>'\)/);
    expect(hint).toMatch(/mode='any' REQUIRES a query/);
    expect(skill).toMatch(/requires a `query`/);
    expect(descriptions["recall"] ?? "").toMatch(/a bare `recall\(mode='any'\)` errors/);
    // …and the bare, error-producing form is gone from the guidance.
    expect(hint).not.toMatch(/recall \(mode='any'\) —/);
  });

  it("P1 (round-11) — walk-me-through guidance identifies the affordance by INTENT, not by the button label", async () => {
    const skill = readSkill();
    const descriptions = await readToolDescriptions();
    const explainer = descriptions["present_explainer"] ?? "";
    // Referenced by request source/intent (P2 may relabel the button).
    expect(skill).toMatch(/explain-intent request raised from the UI's\s*\n?\s*Explain \/ walk-me-through affordance/);
    expect(explainer).toMatch(/explain-intent request raised from the UI's Explain \/ walk-me-through affordance/);
    // The grain instruction survives the relabel.
    expect(skill).toMatch(/SCOPED to exactly that hunk\/file\/item/);
    expect(explainer).toMatch(/scope the explainer to THAT hunk\/file\/item/);
    // The hard-coded label is no longer the identifying handle.
    expect(skill).not.toMatch(/clicking "walk me through this"/);
    expect(explainer).not.toMatch(/clicking \\?"walk me through this\\?"/);
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
