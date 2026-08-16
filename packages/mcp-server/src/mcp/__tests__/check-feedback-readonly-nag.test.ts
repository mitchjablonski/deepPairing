/**
 * P3 — read-only artifacts must not read as "awaiting your verdict".
 *
 * An EXPLAINER is acknowledge-only: its companion-UI footer is an acknowledge
 * bar ("Got it" / "Ask more" — ArtifactStatusActions' `acknowledgeMode`), with
 * no Reject and no Request-changes, and rejecting one captures no ledger
 * stance. Yet a draft explainer sat in check_feedback's "⏳ WAITING: N
 * artifact(s) still under review" nag next to a changeset genuinely awaiting a
 * verdict — so a walk-through the human ASKED for read as a blocking review
 * obligation (round-11 LOW).
 *
 * Treatment: explainers move to a distinct "📖 TO READ" line that says outright
 * that nothing awaits a verdict. Everything else stays put — the DEBRIEF and
 * RESEARCH surfaces keep the full verdict triad (the debrief only suppresses
 * the reject-CONCEPT ledger write), so they are NOT acknowledge-only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { FileStore } from "../../store/file-store.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";
import { ACKNOWLEDGE_ONLY_DRAFT_TYPES, WAITING_DRAFT_TYPES, PENDING_DRAFT_TYPES } from "../tools/types.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
beforeEach(() => {
  store = ctx.store;
});

async function presentExplainer(): Promise<void> {
  await callTool("present_explainer", {
    title: "How session auth works here",
    overview: "A walk of the request path for an authenticated route.",
    sections: [{ heading: "1. The cookie is read at the edge", body: "requireSession pulls the id out of the cookie." }],
    suggestedQuestions: ["Where is the session created?"],
  });
}

/** Something unrelated so the poll returns immediately instead of long-polling. */
function stirTheQueue(): void {
  store.addComment({ id: `cmt_${Math.random().toString(36).slice(2, 8)}`, artifactId: "art_other", content: "stray", author: "human" });
}

describe("P3 — the acknowledge-only set", () => {
  it("is a strict subset of the WAITING/PENDING draft types", () => {
    for (const t of ACKNOWLEDGE_ONLY_DRAFT_TYPES) {
      expect(WAITING_DRAFT_TYPES as readonly string[]).toContain(t);
      expect(PENDING_DRAFT_TYPES as readonly string[]).toContain(t);
    }
    // EXPLAINER only — adding a type here means its UI footer dropped the
    // verdict triad. Debrief/research keep it, so they must NOT be listed.
    expect([...ACKNOWLEDGE_ONLY_DRAFT_TYPES]).toEqual(["explainer"]);
  });
});

describe("P3 — a draft explainer is 'to read', not 'under review'", () => {
  it("lists the explainer under 📖 TO READ and raises NO verdict nag", async () => {
    await presentExplainer();
    stirTheQueue();

    const res = await callTool("check_feedback");
    expect(res.text).toContain("📖 TO READ");
    expect(res.text).toContain("How session auth works here");
    expect(res.text).toContain("await no verdict");
    // The verdict nag is absent entirely — nothing here awaits one.
    expect(res.text).not.toContain("artifact(s) still under review");
  });

  it("keeps a verdict-bearing draft in ⏳ WAITING while the explainer sits in TO READ", async () => {
    await presentExplainer();
    await callTool("present_plan", {
      title: "Rollout plan",
      objective: "ship the cache",
      steps: [{ description: "add the cache", reasoning: "p95" }],
      estimatedChanges: 2,
    });
    stirTheQueue();

    const res = await callTool("check_feedback");
    const waitingLine = res.text.split("\n").find((l) => l.includes("artifact(s) still under review"))!;
    expect(waitingLine).toContain("Rollout plan");
    expect(waitingLine).not.toContain("How session auth works here");
    const toReadLine = res.text.split("\n").find((l) => l.includes("📖 TO READ"))!;
    expect(toReadLine).toContain("How session auth works here");
    expect(toReadLine).not.toContain("Rollout plan");
  });

  it("a DEBRIEF still counts as awaiting a verdict (it keeps the triad)", async () => {
    await callTool("present_debrief", {
      title: "Debrief — the cache work",
      summary: "We put a cache in front of the session read so the p95 stops tracking Postgres.",
      sections: [{ title: "The cache", body: "requireSession reads through the cache now." }],
    });
    stirTheQueue();

    const res = await callTool("check_feedback");
    const waitingLine = res.text.split("\n").find((l) => l.includes("artifact(s) still under review"));
    expect(waitingLine).toBeDefined();
    expect(waitingLine!).toContain("Debrief — the cache work");
    expect(res.text).not.toContain("📖 TO READ");
  });
});
