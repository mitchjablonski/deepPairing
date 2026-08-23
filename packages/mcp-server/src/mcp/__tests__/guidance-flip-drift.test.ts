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
import { matchGuardrailPath } from "../../guardrail-rules.js";
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
  // P1 F1 — the backstop's liveness scan is PROJECT-wide, so describing it as
  // session-scoped over-narrows what the mechanism actually does.
  /is live in the session/i,
  /live in this session/i,
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
    //    F1 — liveness is PROJECT-scoped (readSessionCeremony iterates every
    //    session dir). Both surfaces must say so; "in the session" is the
    //    over-narrow claim the review caught and is a STALE_PHRASE below.
    expect(skill).toMatch(/is live in this project's recent\s*\n?\s*sessions/);
    expect(hint).toMatch(/while NO findings, options, spec, or plan is live in this project's recent sessions/);
    // 3. the SILENCE condition — the escalated arc in flight passes, and F2: a
    //    DRAFT counts immediately (the backstop catches the SKIP, not the
    //    un-reviewed landing), so the reader can't infer review is required.
    expect(skill).toMatch(/the write passes silently/);
    expect(skill).toMatch(/a spec you just presented\s*\n?\s*counts immediately/);
    expect(skill).toMatch(/catches the SKIP, not the un-reviewed/);
    expect(hint).toMatch(/stays SILENT once that pre-work arc is in flight/);
    expect(hint).toMatch(/a spec you JUST presented counts immediately/);
    // 4. the dedup grain (F3: per class, per FILE for the irreversible classes)
    //    + fail-open + the F7 opt-out.
    expect(skill).toMatch(/once per guardrail class per 30 minutes/);
    expect(skill).toMatch(/\*\*per\n  file\*\* for migrations and secrets/);
    expect(hint).toMatch(/at most once per guardrail class per 30 minutes \(per FILE for migrations and secrets/);
    expect(skill).toMatch(/fail-open/);
    expect(hint).toMatch(/fails open/);
    expect(skill).toMatch(/DEEPPAIRING_GUARDRAIL_BACKSTOP=off/);
    // F8 — the staleness window is documented, not folklore.
    expect(skill).toMatch(/older\s*\n?\s*than ~8 hours no longer counts as live/);
  });

  /**
   * M3 (round-12 adversarial review) — the guidance's DEPTH claims are
   * checkable, so check them against the shipped matcher.
   *
   * Q1 added sentences to SKILL.md and the hint making three falsifiable
   * promises: a monorepo path counts, a file merely named after a guardrail dir
   * does not, and vendored/fixture/example trees are excluded. Asserting only
   * that the SENTENCES exist is exactly the round-11 failure this file was
   * built to prevent (guidance describing a mechanism that isn't there), so
   * each claim is executed against matchGuardrailPath itself.
   */
  it("Q1/H1 — the depth + exclusion sentences are TRUE of the shipped matcher, not just present", async () => {
    const skill = readSkill();
    const hint = await assembleAllHints();
    const root = "/proj";
    const fires = (rel: string) => matchGuardrailPath(root, [`${root}/${rel}`]) !== null;

    // Claim 1: "matched at ANY depth, so packages/api/migrations/ counts".
    expect(skill).toMatch(/matches these at \*\*any depth\*\*/);
    expect(hint).toMatch(/matched at ANY depth, so packages\/api\/migrations\/ in a monorepo counts/);
    expect(fires("packages/api/migrations/002_drop_users.sql"), "the depth claim is false").toBe(true);
    expect(fires("services/web/Dockerfile"), "the depth claim is false for file rules").toBe(true);

    // Claim 2: "a file merely NAMED like one ... does not".
    expect(hint).toMatch(/while a file merely NAMED like one, e\.g\. src\/migrations\.js, does not/);
    expect(skill).toMatch(/`src\/migrations\.js`, `docs\/migrations\.md`/);
    for (const rel of ["src/migrations.js", "docs/migrations.md", "lib/helm.ts"]) {
      expect(fires(rel), `the named-after claim is false for ${rel}`).toBe(false);
    }

    // Claim 3 (H1): vendored / generated / fixture / example trees are excluded.
    expect(skill).toMatch(/\*\*Excluded trees\.\*\*/);
    expect(hint).toMatch(/vendored\/generated\/fixture\/example trees such as node_modules\/, dist\/, coverage\/, fixtures\/ and examples\/ are excluded entirely/);
    for (const rel of [
      "node_modules/somepkg/migrations/x.js",
      "dist/migrations/bundle.js",
      "coverage/lcov-report/.env",
      "test/fixtures/migrations/seed.sql",
      "examples/basic/docker-compose.yml",
    ]) {
      expect(fires(rel), `the exclusion claim is false for ${rel}`).toBe(false);
    }
    // …and the honest over-match the docs now admit to.
    expect(skill).toMatch(/extension-less file whose entire name is `migrations`/);
    expect(fires("packages/api/migrations")).toBe(true);
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
    // …and the structured scope the request may carry is described by ROLE, not
    // by field names (P2 owns the shape), with the artifact link called out.
    expect(skill).toMatch(/structured \*\*scope\*\*/);
    expect(skill).toMatch(/link `relatedArtifactIds` from the artifact it names/);
    expect(explainer).toMatch(/structured scope \(the artifact, file, and line range/);
  });

  it("P1 F13 — the LIVE TOOL DESCRIPTIONS carry no stale phrasing either (the third guidance surface)", async () => {
    // The tool descriptions are injected every tool-use turn — the
    // highest-visibility surface of the three — but the stale-phrase net only
    // ever swept SKILL.md and the hint. #215 K1 already showed a stale sentence
    // can survive there alone; this closes the hole for the whole net.
    const descriptions = await readToolDescriptions();
    for (const [name, text] of Object.entries(descriptions)) {
      for (const stale of STALE_PHRASES) {
        expect(text, `the ${name} tool description contains stale phrasing: ${stale}`).not.toMatch(stale);
      }
    }
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

/**
 * S1 (round-14) — THE PULL, pinned so it can't silently regress to the dead
 * routing. Round-14's dogfood verdict: v0.1.36 shipped concept/visuals/unknowns
 * but the guidance never told the agent to reach for them — SKILL.md mentioned
 * `unknowns` 0×, scoped `visuals` to plan/spec only, and routed concept-naming
 * to log_reasoning instead of finding.concept (the explainer death pattern). S1
 * rewired the guidance; these pins assert the LIVE routing is present across all
 * three guidance surfaces (SKILL.md, the tool descriptions, the flagship
 * review-pr command) and that the dead routing is gone, so a future prose-trim
 * can't reopen the graveyard.
 */
describe("S1 — the field-pull routes concept / visuals / unknowns to their live surfaces", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const readCommand = (name: string): string => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "../../../../..");
    return fs.readFileSync(path.join(repoRoot, "claude-plugin/commands", name), "utf-8");
  };

  it("SKILL.md names finding.concept as the PREFERRED place to name a pattern (ahead of log_reasoning)", () => {
    const skill = flat(readSkill());
    expect(skill).toContain("Name the `concept` on the finding");
    expect(skill).toMatch(/PREFERRED place to name a pattern, ahead of `log_reasoning`/);
  });

  it("SKILL.md broadens `visuals` beyond plan/spec — to explainer, changeset, debrief, and findings", () => {
    const skill = flat(readSkill());
    // The broadening thesis sentence.
    expect(skill).toContain("when explaining how something works or reviewing a change, a picture is the strongest transfer");
    // …and each live surface is named as a visuals host.
    expect(skill).toMatch(/attach\s+`visuals\[\]`\s+to `present_explainer`/);
    expect(skill).toContain("`present_changeset` (the blast radius / the shape of what this touches)");
    expect(skill).toMatch(/`present_debrief`.*and `present_findings`/);
  });

  it("SKILL.md teaches `unknowns` on the explainer (it appeared 0× before S1)", () => {
    const skill = flat(readSkill());
    expect(skill).toContain("unknowns[]");
    expect(skill).toContain("say what you're NOT sure about");
  });

  it("SKILL.md's log_reasoning entry redirects concept-naming AWAY from itself to the alive surfaces", () => {
    const skill = flat(readSkill());
    expect(skill).toContain("Concept-naming does NOT live here");
    expect(skill).toMatch(/`finding\.concept`.*the preferred place/);
    // The demotion phrasing the flip-drift net already pins stays intact.
    expect(readSkill()).toMatch(/\*\*sparingly\.\*\*/);
  });

  it("the tool descriptions carry the same routing (the highest-visibility surface)", async () => {
    const d = await readToolDescriptions();
    // findings — concept, preferred over log_reasoning; visuals for consistency (F2).
    expect(d["present_findings"]).toMatch(/PREFERRED place to name a pattern/);
    expect(d["present_findings"]).toContain("concept");
    expect(d["present_findings"]).toContain("visuals");
    // explainer — visuals + unknowns.
    expect(d["present_explainer"]).toContain("visuals");
    expect(d["present_explainer"]).toContain("unknowns");
    // changeset — the blast-radius visual.
    expect(d["present_changeset"]).toMatch(/BLAST RADIUS/i);
    expect(d["present_changeset"]).toContain("visuals");
    // debrief — visuals, AND the required-field claim is now TRUE (not "only summary").
    expect(d["present_debrief"]).toContain("visuals");
    expect(flat(d["present_debrief"]!)).toMatch(/`title` \(artifact-level\) and `summary` are REQUIRED/);
    expect(d["present_debrief"]).not.toContain("only `summary` is required");
  });

  it("changeset + debrief descriptions state their required fields TRUTHFULLY (doc↔schema drift the dogfood found)", async () => {
    const d = await readToolDescriptions();
    // changeset: title IS required — the description must say so.
    expect(flat(d["present_changeset"]!)).toMatch(/`title` \(artifact-level\) and `files` are REQUIRED/);
  });

  it("F3 — changeset.summary now has a PULL (it was rendered by S2 but nothing told the agent to populate it)", async () => {
    // The exact dormant-field trap this round exists to escape: S2 renders
    // changeset.summary, so the guidance must tell the agent to WRITE it.
    const d = await readToolDescriptions();
    const skill = flat(readSkill());
    // Tool description: a one-line summary, the WHAT-at-a-glance.
    expect(flat(d["present_changeset"]!)).toMatch(/one-line `summary`.*WHAT-at-a-glance/);
    // SKILL's changeset guidance carries the same pull.
    expect(skill).toMatch(/Give it a one-line `summary`.*WHAT-at-a-glance/);
  });

  it("U2 (round-15) — SKILL routes NON-CODE understanding through the DECISION, not the explainer", () => {
    const skill = flat(readSkill());
    // The routing thesis: a doc/request/message/design → decision, not a read-only walk.
    expect(skill).toContain("route through the DECISION, not a read-only walk");
    expect(skill).toMatch(/understanding without a decision dies/i);
    // The three live surfaces it names (options for interpretations, locator-anchored
    // findings, a doc_map/diagram) and the closing decision.
    expect(skill).toMatch(/Each interpretation or ambiguity is a `present_options` decision/);
    expect(skill).toMatch(/anchors to non-code text via a `locator`/);
    expect(skill).toMatch(/Close with the DECISION the human must rule on/);
    // The explicit anti-pattern: do NOT end on a read-only explainer walk.
    expect(skill).toMatch(/Do NOT end a\s*\n?\s*non-code understanding pass on a read-only explainer walk/);
  });

  it("U2 (round-15) — the doc_map visual kind is taught in SKILL and advertised in the findings tool desc's locator note", async () => {
    const skill = flat(readSkill());
    const d = await readToolDescriptions();
    // doc_map is in the visual picker.
    expect(skill).toMatch(/`kind: "doc_map"`/);
    expect(skill).toContain("the WHERE-locative for docs");
    // the findings tool description teaches the non-code locator anchor (kept
    // compact for the 700-char cap); the full locator-kind vocabulary lives in
    // SKILL's routing section, which isn't budget-capped.
    expect(d["present_findings"]).toMatch(/locator/);
    expect(skill).toContain('{ kind: "quote" | "heading" | "charRange" | "url", value }');
  });

  it("review-pr.md routes concept to finding.concept, blast-radius to visuals, and gaps to unknowns", () => {
    const cmd = flat(readCommand("review-pr.md"));
    // concept → the finding's own field, not a log_reasoning card.
    expect(cmd).toContain("each finding's own `concept` field");
    expect(cmd).toContain("not a separate `log_reasoning`");
    // blast radius → a visuals diagram on the changeset.
    expect(cmd).toContain("Draw the blast radius on it");
    expect(cmd).toMatch(/`visuals` diagram or `file_map`/);
    // what-you-couldn't-verify → unknowns.
    expect(cmd).toMatch(/record what you could NOT verify in `unknowns`/);
  });
});
