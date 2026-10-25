/**
 * #572 slice A — check_feedback's resolved-decision echo of the brief pin.
 * Sourced from the SAVED decision artifact and the exact pinned brief in that
 * artifact's session: never the current brief, never a successor. A missing
 * brief echoes the saved id + grains with "version unknown"; a missing
 * decision artifact omits only the echo — the choice, reason and ack order
 * are unchanged. Fakes, not mocks (real FileStore + MCP server).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { BriefRef } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { savedBriefAdvisory } from "../brief-ref.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => { store = ctx.store; });

const OPTIONS = [
  { id: "a", title: "Inject config", description: "pass config explicitly", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: "Keep the module", description: "status quo", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
];
const SPEC = {
  objective: "Ship auth",
  requirements: [{ id: "REQ-1", statement: "s", rationale: "r", acceptanceCriteria: ["a"] }, { id: "REQ-2", statement: "s", rationale: "r", acceptanceCriteria: ["a"] }],
  edgePaths: [{ path: "id-less", risk: "r" }],
};

const seedSpec = (id: string, over: { parentId?: string; version?: number } = {}) =>
  store.createArtifact({ id, type: "spec", title: "Auth brief", content: SPEC, ...over });

/** A decision card saved with `briefRef`, created directly (as a store
 *  holding an older or not-yet-hydrated brief would have it). */
function seedDecision(id: string, decisionId: string, briefRef: BriefRef | undefined) {
  store.createArtifact({ id, type: "decision", title: "Logger", content: { context: "Which logger?", title: "Logger", options: OPTIONS, decisionId }, ...(briefRef ? { briefRef } : {}) });
  store.recordDecisionRequest({ decisionId, artifactId: id, context: "Which logger?", title: "Logger", options: OPTIONS } as Parameters<FileStore["recordDecisionRequest"]>[0]);
}

describe("#572 — the resolved-decision echo", () => {
  it("echoes the saved pin (id, version, grains) in text and structured output; choice and reason preserved", async () => {
    seedSpec("art_brief1");
    const res0 = await callTool("present_options", { context: "Which logger?", title: "Logger", options: OPTIONS, briefRef: { artifactId: "art_brief1", requirementIds: ["REQ-2", "REQ-9"], edgePathIds: ["0"] } });
    const decisionId = (res0.structuredContent as { decisionId: string }).decisionId;
    store.resolveDecision(decisionId, "a", "fits the CLI");
    const res = await callTool("check_feedback");
    expect(res.text).toContain('- Decision "Logger": selected "Inject config" (reasoning: fits the CLI)');
    expect(res.text).toContain('Exception to "Auth brief" v1 · REQ-2, REQ-9 (unknown), edge path 0 (unknown) (the link saved on this card; context, not an acceptance).');
    const d = (res.structuredContent as { decisions: Array<Record<string, unknown>> }).decisions[0]!;
    expect(d).toMatchObject({ decisionId, selectedOptionId: "a", reasoning: "fits the CLI" });
    expect(d.briefRef).toEqual({
      artifactId: "art_brief1", version: 1, status: "draft",
      requirementIds: ["REQ-2", "REQ-9"], edgePathIds: ["0"],
      grains: [
        { kind: "requirement", id: "REQ-2", match: "known" },
        { kind: "requirement", id: "REQ-9", match: "unknown" },
        { kind: "edgePath", id: "0", match: "unknown" },
      ],
    });
  });

  it("a brief superseded after the card keeps echoing the PINNED v1 with its status, never v2", async () => {
    seedSpec("art_v1");
    seedDecision("art_d1", "dec_d1", { artifactId: "art_v1", requirementIds: ["REQ-1"] });
    seedSpec("art_v2", { parentId: "art_v1", version: 2 });
    store.updateArtifactStatus("art_v1", "superseded", "agent_supersede");
    store.resolveDecision("dec_d1", "b");
    const res = await callTool("check_feedback");
    expect(res.text).toContain('Exception to "Auth brief" v1 · REQ-1 (superseded)');
    const d = (res.structuredContent as { decisions: Array<{ briefRef?: Record<string, unknown> }> }).decisions[0]!;
    expect(d.briefRef).toMatchObject({ artifactId: "art_v1", version: 1, status: "superseded" });
  });

  it("brief missing (not hydrated, removed, or another session's): id + raw grains + version unknown", async () => {
    seedDecision("art_d1", "dec_d1", { artifactId: "art_gone", requirementIds: ["REQ-1"] });
    store.resolveDecision("dec_d1", "a", "why");
    const res = await callTool("check_feedback");
    expect(res.text).toContain('selected "Inject config" (reasoning: why)');
    expect(res.text).toContain("Exception to brief art_gone (version unknown, brief unavailable) · REQ-1");
    const d = (res.structuredContent as { decisions: Array<{ briefRef?: Record<string, unknown> }> }).decisions[0]!;
    expect(d.briefRef).toEqual({
      artifactId: "art_gone", version: "unknown", status: "unavailable",
      requirementIds: ["REQ-1"], edgePathIds: [],
      grains: [{ kind: "requirement", id: "REQ-1", match: "unavailable" }],
    });
  });

  it("decision artifact missing: the choice and reason are delivered, only the echo is omitted", async () => {
    store.recordDecisionRequest({ decisionId: "dec_lost", artifactId: "art_lost", context: "Which logger?", title: "Logger", options: OPTIONS } as Parameters<FileStore["recordDecisionRequest"]>[0]);
    store.resolveDecision("dec_lost", "a", "still counts");
    const res = await callTool("check_feedback");
    expect(res.text).toContain('selected "Inject config" (reasoning: still counts)');
    expect(res.text).not.toContain("Exception to");
    const d = (res.structuredContent as { decisions: Array<Record<string, unknown>> }).decisions[0]!;
    expect(d).toMatchObject({ decisionId: "dec_lost", selectedOptionId: "a" });
    expect("briefRef" in d).toBe(false);
  });

  it("a card without a pin echoes nothing (legacy output unchanged)", async () => {
    seedDecision("art_d1", "dec_d1", undefined);
    store.resolveDecision("dec_d1", "a");
    const res = await callTool("check_feedback");
    expect(res.text).not.toContain("Exception to");
    expect("briefRef" in (res.structuredContent as { decisions: Array<Record<string, unknown>> }).decisions[0]!).toBe(false);
  });

  it("a malformed stored pin is echoed raw as unavailable, never dropping the decision", async () => {
    seedDecision("art_d1", "dec_d1", undefined);
    // Written as an older/foreign writer might have left it on disk.
    store.getArtifacts().find((a) => a.id === "art_d1")!.briefRef = { artifactId: "art_odd", requirementIds: "REQ-1" };
    store.resolveDecision("dec_d1", "a");
    const res = await callTool("check_feedback");
    expect(res.text).toContain('selected "Inject config"');
    expect(res.text).toContain("Exception to an unreadable or out-of-policy brief link (art_odd), version unknown");
    const d = (res.structuredContent as { decisions: Array<{ briefRef?: Record<string, unknown> }> }).decisions[0]!;
    expect(d.briefRef).toMatchObject({ artifactId: "art_odd", version: "unknown", status: "unavailable", malformed: true });
  });

  it("a shape-valid but out-of-policy stored pin loads unchanged, echoes version unknown, and no advisory claims a valid pin", async () => {
    seedSpec("art_brief1");
    const cases = [
      { artifactId: "art_brief1", requirementIds: ["REQ-1", "REQ-1"] },
      { artifactId: "art_brief1", requirementIds: ["  "] },
      { artifactId: "art_brief1", requirementIds: Array.from({ length: 9 }, (_, i) => `REQ-${i}`) },
      { artifactId: "art_brief1", edgePathIds: ["a".repeat(65)] },
    ];
    for (const [i, briefRef] of cases.entries()) {
      seedDecision(`art_p${i}`, `dec_p${i}`, undefined);
      // As an older writer might have left it on disk (shape-valid, out of policy).
      store.getArtifacts().find((a) => a.id === `art_p${i}`)!.briefRef = briefRef;
      store.resolveDecision(`dec_p${i}`, "a");
    }
    const res = await callTool("check_feedback");
    const ds = (res.structuredContent as { decisions: Array<{ artifactId: string; briefRef?: Record<string, unknown> }> }).decisions;
    expect(ds).toHaveLength(cases.length);
    for (const d of ds) {
      expect(d.briefRef).toMatchObject({ artifactId: "art_brief1", version: "unknown", status: "unavailable", malformed: true });
    }
    expect(res.text).not.toContain('Exception to "Auth brief" v1');
    for (const [i, briefRef] of cases.entries()) {
      const art = store.getArtifacts().find((a) => a.id === `art_p${i}`)!;
      expect(art.briefRef).toEqual(briefRef); // unchanged
      const advisory = savedBriefAdvisory(art, { briefRef }, store.getArtifacts());
      expect(advisory).toContain("unreadable or out of policy");
      expect(advisory).not.toContain('"Auth brief" v1');
    }
  });
});
