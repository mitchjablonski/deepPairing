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
 * gate matches on. Changing what NEW entries record must not change what the
 * gate MATCHES ON — an OLD long-format entry already on disk has to keep
 * blocking exactly as before, and a NEW short-format entry has to block the
 * same re-proposal. The matcher splits a description on its first colon and
 * matches the POST-colon noun (the option title), which is identical under both
 * formats — that's the property pinned below, at the unit level AND end-to-end
 * through a real present_options call.
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

  it("unit: both formats match the same proposal via the post-colon noun", () => {
    const proposals = ["Let's keep it in an In-process LRU instead"];
    const oldHit = findRejectedApproachMatch(proposals, [
      { description: OLD_FORMAT, rejectedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const newHit = findRejectedApproachMatch(proposals, [
      { description: NEW_FORMAT, rejectedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(oldHit?.via).toBe("surface");
    expect(newHit?.via).toBe("surface");
    // Same matched proposal — the format change is invisible to the matcher.
    expect(oldHit?.proposal).toBe(newHit?.proposal);
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
