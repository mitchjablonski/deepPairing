import fs from "node:fs";
import path from "node:path";
import type { PreflightTrace } from "@deeppairing/shared";
import { writeJsonAtomic } from "./atomic-write.js";
import { meaningfulTokens } from "../mcp/preflight-validator.js";
import { recordMetricEvent } from "./metrics-store.js";

/**
 * Phase-1 (D) — instrument the "gate escape": the strongest signal that a
 * PURELY-LEXICAL gate is leaving value on the table and Phase 2 (embeddings)
 * is justified.
 *
 * The signal: the human MANUALLY re-flags (rejects) an artifact the gate had
 * ADMITTED, and the newly-rejected concept has ZERO stemmed-token overlap with
 * everything the gate weighed (its considered concepts + near-misses). No
 * lexical clue existed, yet the human's taste said "this is the same thing I
 * rejected before" — exactly the case a semantic matcher would catch.
 *
 * We persist BOTH a metrics counter (gateEscapes, the measurable headline) and
 * an append-only detail sidecar (`.deeppairing/preflight-residual.json`, capped)
 * so Phase 2 has the concrete zero-overlap concept strings to train/evaluate on.
 * Deterministic + local + fail-open — this is telemetry, never a blocker.
 */

const RESIDUAL_CAP = 100;

interface ResidualEntry {
  at: string;
  artifactId: string;
  /** The concept/description the human just rejected. */
  concept: string;
  reason?: string;
  /** How many stances the gate had weighed when it admitted (all zero-overlap). */
  consideredCount: number;
}

interface ResidualFile {
  version: 1;
  escapes: ResidualEntry[];
}

function residualPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", "preflight-residual.json");
}

function appendResidual(projectRoot: string, entry: ResidualEntry): void {
  const p = residualPath(projectRoot);
  let file: ResidualFile = { version: 1, escapes: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (raw?.version === 1 && Array.isArray(raw.escapes)) file = raw;
  } catch {
    // No prior file (or unreadable) — start fresh.
  }
  file.escapes.push(entry);
  // Keep the most recent RESIDUAL_CAP so the file stays bounded.
  file.escapes = file.escapes.slice(-RESIDUAL_CAP);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeJsonAtomic(p, file);
  } catch {
    // Non-fatal — losing a telemetry row never breaks the rejection write.
  }
}

/**
 * Detect + record a gate escape. Returns true when this rejection was a
 * zero-lexical-overlap escape of an admitted trace (for tests/inspection).
 *
 * Guards (why it's NOT an escape):
 *   - no trace, or the trace BLOCKED — the gate did its job.
 *   - the trace considered NOTHING (bootstrap) — there was no prior stance for
 *     embeddings to have matched either, so it's not a residual signal.
 *   - the rejected concept shares ANY stemmed token with a considered concept
 *     or near-miss — the lexical gate had a signal (it near-missed / a token
 *     matched); that's a threshold-tuning case, not an embeddings case.
 */
export function detectAndRecordGateEscape(args: {
  projectRoot: string;
  rejectedConcept: string;
  reason?: string;
  trace: PreflightTrace | null;
}): boolean {
  const { projectRoot, rejectedConcept, reason, trace } = args;
  if (!trace || trace.decision !== "admitted") return false;
  const considered = trace.consideredConcepts ?? [];
  if (considered.length === 0) return false; // nothing was weighed → not a residual signal

  const rejTokens = new Set(meaningfulTokens(rejectedConcept));
  if (rejTokens.size === 0) return false;

  const weighedTexts = [
    ...considered.map((c) => c.concept),
    ...(trace.nearMisses ?? []).map((n) => n.concept),
  ];
  for (const text of weighedTexts) {
    if (meaningfulTokens(text).some((tok) => rejTokens.has(tok))) {
      return false; // some lexical overlap existed → not a zero-overlap escape
    }
  }

  try {
    // recordMetricEvent runs IN-PROCESS wherever FileStore.recordRejectedApproach
    // runs — i.e. the daemon AND the standalone (non-daemon) FileStore path. So
    // gate_escape is counted in both deployments, unlike the wire-routed
    // preflight_block / preflight_near_miss (which FileStore omits).
    recordMetricEvent(projectRoot, { kind: "gate_escape" });
  } catch {
    // Non-fatal telemetry.
  }
  appendResidual(projectRoot, {
    at: new Date().toISOString(),
    artifactId: trace.artifactId,
    concept: rejectedConcept,
    reason,
    consideredCount: considered.length,
  });
  return true;
}
