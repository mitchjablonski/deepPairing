/**
 * P3 — the SELF-CONTRADICTING payload (round-11 dogfood): one check_feedback
 * reply reported a decision SELECTION and "⏳ WAITING: 1 decision(s) pending"
 * in the same breath, which reads as the same decision being resolved AND
 * still open. Two things made that possible, both pinned here:
 *
 *   (a) the nag was ANONYMOUS — a bare count — so a genuinely DIFFERENT open
 *       decision was indistinguishable from the one just delivered. It now
 *       NAMES each pending decision (short M1.1 title when present, else the
 *       context, bounded) with its dec_ id.
 *   (b) the ORPHAN class — the store's pending filter excludes records whose
 *       artifact is superseded/retracted/rejected/obsolete but NOT `approved`,
 *       so a response-less record whose artifact reached a terminal state by
 *       any other path (the /api/decisions no-record fallback, a straight
 *       Approve on the card) nagged forever.
 *
 * The invariant: a decision whose selection this poll DELIVERS is never also
 * counted pending in the same poll.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

const opts = (a: string, b: string) => [
  { id: "a", title: a, description: `${a} approach`, pros: ["x"], cons: ["y"], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: b, description: `${b} approach`, pros: ["x"], cons: ["y"], effort: "low", risk: "low", recommendation: false },
];

describe("P3 — a delivered selection is never also counted pending", () => {
  it("reports the pick of decision A and names ONLY the still-open decision B", async () => {
    await callTool("present_options", { context: "Which cache backend?", title: "Cache backend", options: opts("Redis", "LRU") });
    await callTool("present_options", { context: "Which queue?", title: "Queue backend", options: opts("SQS", "Rabbit") });
    const [decA, decB] = store.getPendingDecisions();
    store.resolveDecision(decA!.decisionId, "a", "already running it");

    const res = await callTool("check_feedback");

    // The selection is delivered…
    expect(res.text).toContain(`- Decision "Cache backend": selected "Redis"`);
    // …and the WAITING line names the OTHER decision only — never the one just
    // delivered, and never an anonymous count the agent can't reconcile.
    expect(res.text).toContain("decision(s) pending");
    expect(res.text).toContain(`"Queue backend" (${decB!.decisionId})`);
    expect(res.text).toContain("⏳ WAITING: 1 decision(s) pending");
    expect(res.text).not.toContain(decA!.decisionId);
  });

  it("a single resolved decision leaves NO pending-decision nag at all", async () => {
    await callTool("present_options", { context: "Which cache backend?", title: "Cache backend", options: opts("Redis", "LRU") });
    const dec = store.getPendingDecisions()[0]!;
    store.resolveDecision(dec.decisionId, "a");

    const res = await callTool("check_feedback");
    expect(res.text).toContain("selected");
    expect(res.text).not.toContain("decision(s) pending");
  });

  it("ORPHAN: a response-less record whose artifact is already terminal stops nagging", async () => {
    await callTool("present_options", { context: "Which cache backend?", title: "Cache backend", options: opts("Redis", "LRU") });
    const art = store.getArtifacts().find((a) => a.type === "decision")!;
    // The human approved the CARD instead of picking an option (or the
    // no-record HTTP fallback advanced it): the artifact is terminal, but the
    // decision record never got a response.
    store.updateArtifactStatus(art.id, "approved", "ui_approve_button");
    // The STORE drops it at the source now (`approved` joined the closed set —
    // see list-all-decisions.test.ts for the store/session-scan parity pin)…
    expect(store.getPendingDecisions()).toHaveLength(0);

    const res = await callTool("check_feedback");
    // …and check_feedback doesn't nag about a decision the human can no longer
    // act on. check_feedback's own filter stays as belt-and-braces: it would
    // drop this row even if a store (or a stale daemon read) still returned it.
    expect(res.text).not.toContain("decision(s) pending");
  });

  it("a genuinely open decision is still nagged (fail-on-over-filtering)", async () => {
    await callTool("present_options", { context: "Which cache backend?", title: "Cache backend", options: opts("Redis", "LRU") });
    const dec = store.getPendingDecisions()[0]!;
    // Something else makes the poll return immediately (a stray comment) so we
    // read the nag without sitting in the 30s long-poll.
    store.addComment({ id: "cmt_x", artifactId: "art_other", content: "stray", author: "human" });

    const res = await callTool("check_feedback");
    expect(res.text).toContain("⏳ WAITING: 1 decision(s) pending");
    expect(res.text).toContain(`"Cache backend" (${dec.decisionId})`);
  });

  it("names a title-less decision by its context, bounded to a header length", async () => {
    const long =
      "We need to decide where the per-request session blobs live, given the p95 " +
      "is dominated by the Postgres read we already do on every single request.";
    await callTool("present_options", { context: long, options: opts("Redis", "LRU") });
    store.addComment({ id: "cmt_y", artifactId: "art_other", content: "stray", author: "human" });

    const res = await callTool("check_feedback");
    expect(res.text).toContain("decision(s) pending");
    // Truncated with an ellipsis — the paragraph never rides the nag whole.
    expect(res.text).not.toContain(long);
    expect(res.text).toContain(`${long.slice(0, 79)}…`);
  });
});
