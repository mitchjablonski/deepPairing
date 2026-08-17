/**
 * P3 — finish M1.1's HALF-landed short-title fix, and PIN that finishing it
 * did not move the preflight gate.
 *
 * Round-8 filed the bloat: present_options grew an optional short `title`
 * naming the fork, and the stored ARTIFACT title started using it — but two
 * surfaces kept echoing the whole `context` PARAGRAPH:
 *   (a) present_options' own success text (`Decision "<paragraph>" presented…`),
 *   (b) the ledger keys check_feedback mints when the human picks — the
 *       approved pattern and every unchosen option's rejection — both keyed
 *       `${context}: ${option.title}`, which is what export-learnings renders.
 *
 * THE BACKWARD-COMPAT INVARIANT (the reason this test exists): the rejection
 * `description` is ALSO the session-ledger key the preflight rejected-approach
 * gate matches on, so an OLD long-format entry already on disk must keep
 * blocking a re-proposal, and a NEW short-format entry must block the same one.
 *
 * Stated PRECISELY (the first cut of this docstring overclaimed "identical
 * under both formats", and the adversarial review executed the counterexamples):
 * `findRejectedApproachMatch` runs THREE surface checks, not one.
 *   - forward phrase (proposal contains the whole description) and the
 *     post-colon `specificNoun` lane are key-length-invariant: the option title
 *     is the post-colon noun under BOTH formats, so a genuine re-proposal of a
 *     rejected option blocks either way. This is the moat lane.
 *   - the REVERSE phrase lane read the WHOLE description as its haystack, which
 *     made it sensitive to the category PREFIX rather than to the stance:
 *       (a) an old paragraph-prefixed key spuriously blocked any short proposal
 *           appearing in that background paragraph — including the option the
 *           human CHOSE;
 *       (b) a new title-prefixed key would spuriously block a later option
 *           TITLED with the generic fork words ("Cache backend", "Error
 *           handling").
 *     P3 scopes that lane to `specificNoun` too (preflight-validator.ts),
 *     killing both classes and making the key change genuinely behavior-neutral
 *     for legitimate proposals. A colon-less key (artifact title, human-named
 *     reject concept) is untouched — specificNoun === the description there.
 *
 * The divergence cases (a)-(d) are pinned explicitly below, at the unit level
 * AND end-to-end through real present_options calls.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { findRejectedApproachMatch } from "../preflight-validator.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

/** The full-paragraph background that used to be used as the decision's NAME. */
const CONTEXT =
  "We need somewhere to keep the per-request session blobs. Today they live in " +
  "the Postgres row we already read on every request, which is why the p95 is " +
  "dominated by that query, and the team has asked for a cache in front of it.";
const TITLE = "Which cache backend?";

const OPTIONS = [
  {
    id: "a",
    title: "Redis",
    description: "a network cache service",
    pros: ["fast"],
    cons: ["another service to operate"],
    effort: "medium",
    risk: "medium",
    recommendation: true,
    concept: { name: "redis for session caching" },
  },
  {
    id: "b",
    title: "In-process LRU",
    description: "keep it in the node heap",
    pros: ["no new service"],
    cons: ["per-node, cold after deploys"],
    effort: "low",
    risk: "low",
    recommendation: false,
    concept: { name: "in-process lru session cache" },
  },
];

describe("P3 — present_options success text names the fork, not the paragraph", () => {
  it("echoes the SHORT title when one is given", async () => {
    const res = await callTool("present_options", { context: CONTEXT, title: TITLE, options: OPTIONS });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain(`Decision "${TITLE}" presented to human`);
    // The paragraph does NOT ride in the success text any more.
    expect(res.text).not.toContain(CONTEXT);
    // The stored artifact title already used the short title (M1.1) — the
    // success text now AGREES with it.
    expect(store.getArtifacts().find((a) => a.type === "decision")!.title).toBe(TITLE);
  });

  it("falls back to context verbatim when no title is given (byte-compat)", async () => {
    const res = await callTool("present_options", { context: "Which pattern?", options: OPTIONS });
    expect(res.text).toContain(`Decision "Which pattern?" presented to human`);
  });
});

describe("P3 — the pick records the short label in BOTH ledger keys", () => {
  it("approved pattern + unchosen rejection key on the title, not the paragraph", async () => {
    await callTool("present_options", { context: CONTEXT, title: TITLE, options: OPTIONS });
    const dec = store.getPendingDecisions()[0]!;
    // The record carries the M1.1 title (present_options passes it through).
    expect(dec.title).toBe(TITLE);
    store.resolveDecision(dec.decisionId, "a", "we already run redis");

    const res = await callTool("check_feedback");
    // Prose names the fork.
    expect(res.text).toContain(`- Decision "${TITLE}": selected "Redis"`);
    expect(res.text).not.toContain(CONTEXT);

    // Session ledger: the UNCHOSEN option's key is short.
    const memory = store.getSessionMemory();
    expect(memory.rejectedApproaches.map((r) => r.description)).toContain(`${TITLE}: In-process LRU`);
    expect(memory.rejectedApproaches.every((r) => !r.description.includes(CONTEXT))).toBe(true);
    // The cross-project concept key is UNCHANGED (the option's own concept).
    expect(memory.rejectedApproaches.find((r) => r.description === `${TITLE}: In-process LRU`)!.concept)
      .toBe("in-process lru session cache");
    // Approved pattern too.
    expect(memory.approvedPatterns).toContain(`${TITLE}: Redis`);
  });

  it("with NO title the keys stay exactly as before (context-prefixed)", async () => {
    await callTool("present_options", { context: "Which cache?", options: OPTIONS });
    const dec = store.getPendingDecisions()[0]!;
    store.resolveDecision(dec.decisionId, "a");
    await callTool("check_feedback");
    const memory = store.getSessionMemory();
    expect(memory.rejectedApproaches.map((r) => r.description)).toContain("Which cache?: In-process LRU");
    expect(memory.approvedPatterns).toContain("Which cache?: Redis");
  });
});

describe("P3 — BACKWARD COMPAT: the gate matches old- and new-format keys alike", () => {
  const OLD_FORMAT = `${CONTEXT}: In-process LRU`;
  const NEW_FORMAT = `${TITLE}: In-process LRU`;
  const AT = "2026-01-01T00:00:00.000Z";
  const hit = (proposals: string[], description: string, concept?: string) =>
    findRejectedApproachMatch(proposals, [{ description, rejectedAt: AT, ...(concept ? { concept } : {}) }]);

  it("(c) THE MOAT LANE: a re-proposal of the rejected option blocks under BOTH formats", () => {
    const proposals = ["Let's keep it in an In-process LRU instead"];
    const oldHit = hit(proposals, OLD_FORMAT);
    const newHit = hit(proposals, NEW_FORMAT);
    expect(oldHit?.via).toBe("surface");
    expect(newHit?.via).toBe("surface");
    // Same matched proposal — the post-colon noun is the option title either way.
    expect(oldHit?.proposal).toBe(newHit?.proposal);
    // …and the bare option title alone blocks under both.
    expect(hit(["In-process LRU"], OLD_FORMAT)).not.toBeNull();
    expect(hit(["In-process LRU"], NEW_FORMAT)).not.toBeNull();
  });

  it("(d) the CONCEPT lane (paraphrase catch) is untouched by the key format", () => {
    // A paraphrase that shares NO surface phrase with either description still
    // blocks via the option's own concept — the lane the moat rests on.
    const paraphrase = ["Cache the sessions in the node heap with an lru per process"];
    expect(hit(paraphrase, OLD_FORMAT, "in-process lru session cache")?.via).toBe("concept");
    expect(hit(paraphrase, NEW_FORMAT, "in-process lru session cache")?.via).toBe("concept");
  });

  it("(b) an OLD paragraph-prefixed key no longer blocks the option the human CHOSE", () => {
    // The pre-P3 reverse-phrase lane used the WHOLE description as haystack, so
    // any short proposal appearing in the background paragraph matched — the
    // WINNER included. CONTEXT mentions "Postgres"; proposing it must pass.
    expect(hit(["Postgres"], OLD_FORMAT)).toBeNull();
    expect(hit(["the team"], OLD_FORMAT)).toBeNull();
    // The stance itself still blocks — this is a precision fix, not a recall loss.
    expect(hit(["In-process LRU"], OLD_FORMAT)).not.toBeNull();
  });

  it("(a) a NEW title-prefixed key does not block a later option TITLED with the fork words", () => {
    // "Cache backend: In-process LRU" must not block a later fork whose option
    // is literally titled "Cache backend" / whose prefix words recur.
    expect(hit(["Cache backend"], NEW_FORMAT)).toBeNull();
    expect(hit(["Error handling"], "Error handling: try/catch everywhere")).toBeNull();
    // …while the post-colon stance still blocks.
    expect(hit(["try/catch everywhere"], "Error handling: try/catch everywhere")).not.toBeNull();
  });

  it("a colon-less key (artifact title / human-named concept) is completely unchanged", () => {
    // specificNoun === the whole description here, so every lane behaves as
    // before: exact phrase blocks in both directions, unrelated prose passes.
    expect(hit(["we should add a redis cache"], "redis cache")).not.toBeNull();
    expect(hit(["redis"], "redis cache")).not.toBeNull(); // reverse lane, still live
    expect(hit(["a postgres index"], "redis cache")).toBeNull();
  });

  it("end-to-end: an OLD long-format ledger entry still BLOCKS a re-proposal", async () => {
    // Simulate a ledger written by a pre-P3 build.
    store.recordRejectedApproach({ description: OLD_FORMAT });
    const res = await callTool("present_options", {
      context: "Where should the session cache live?",
      title: "Cache placement",
      options: [
        { ...OPTIONS[1]!, id: "x" },
        { ...OPTIONS[0]!, id: "y" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    // Nothing was minted.
    expect(store.getArtifacts().filter((a) => a.type === "decision")).toHaveLength(0);
  });

  it("end-to-end: a NEW short-format ledger entry blocks the SAME re-proposal", async () => {
    store.recordRejectedApproach({ description: NEW_FORMAT });
    const res = await callTool("present_options", {
      context: "Where should the session cache live?",
      title: "Cache placement",
      options: [
        { ...OPTIONS[1]!, id: "x" },
        { ...OPTIONS[0]!, id: "y" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(store.getArtifacts().filter((a) => a.type === "decision")).toHaveLength(0);
  });
});
