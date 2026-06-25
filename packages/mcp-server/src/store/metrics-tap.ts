import { recordMetricEvent } from "./metrics-store.js";

/**
 * R1 — the daemon taps its own `broadcast` once and maps the broadcast events
 * that pass through it to metric counters. Extracted from daemon.ts (which is a
 * self-executing module, so its internals weren't unit-testable) into this pure
 * function: given the daemon's projectRoot + a broadcast event, record the
 * matching metric.
 *
 * What is NOT here, deliberately: `preflight_blocked` and `question_answered`.
 * Both are broadcast ONLY by the MCP-server process, whose broadcast fn is a
 * no-op in standalone — so this daemon-side tap never saw a real one
 * (preflightBlocks / questions.answered sat at 0 in production, and the demo's
 * synthetic preflight_blocked was the *only* block ever counted). They're now
 * recorded at their daemon-side truth points instead: the `/metrics` route
 * (real preflight blocks, via DaemonClient.recordMetric) and the `/answered`
 * route (question_answered).
 */
export function recordBroadcastMetric(projectRoot: string, event: any): void {
  switch (event?.type) {
    case "ledger_write":
      recordMetricEvent(projectRoot, {
        kind: "ledger_write",
        verdict: event.kind === "approved" ? "approved" : "rejected",
      });
      break;
    case "retrospective_recorded":
      if (event.verdict === "right" || event.verdict === "wrong" || event.verdict === "mixed") {
        recordMetricEvent(projectRoot, { kind: "retrospective", verdict: event.verdict });
      }
      break;
    case "feedback_received":
      if (event.intent === "question") {
        recordMetricEvent(projectRoot, { kind: "question_asked" });
      }
      // Horizon-check requests come through as comments with a specific
      // sectionId. The feedback_received broadcast carries only intent, not the
      // full target, so routes.ts records that one inline.
      break;
    case "comment_added":
      // Count HUMAN comments only (agent replies go through answer_question, a
      // different surface). Tells us whether the human engages, not the agent.
      if (event.comment?.author === "human") {
        recordMetricEvent(projectRoot, { kind: "comment_added" });
      }
      break;
    case "artifact_created": {
      // Count by type + each attached visual by kind (the #29/#31 adoption
      // question). F2 — a revision (supersede) re-broadcasts artifact_created
      // with a parentId; counting it would inflate the "is this surface used?"
      // metric (revise a 2-visual plan 3× → 4× the visuals). Only count originals.
      const a = event.artifact;
      if (a?.parentId) break;
      if (a?.type) recordMetricEvent(projectRoot, { kind: "artifact_created", artifactType: String(a.type) });
      const visuals = a?.content?.visuals;
      if (Array.isArray(visuals)) {
        for (const v of visuals) {
          if (v?.kind) recordMetricEvent(projectRoot, { kind: "visual_attached", visualKind: String(v.kind) });
        }
      }
      break;
    }
  }
}
