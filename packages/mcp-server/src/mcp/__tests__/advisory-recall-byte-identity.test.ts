import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { IStore } from "../../store/store-interface.js";
import { getGlobalStore } from "../../store/global-store.js";
import { preflightRejectedApproaches, formatPreflightTraceSummary } from "../tool-helpers.js";
import { runPreflight, meaningfulTokens } from "../preflight-validator.js";

/**
 * #143 step 3 — byte-identity pin for the advisory-recall adapter refactor.
 *
 * The cross-project advisory read (global ledger → `globalAdvisoryConcepts` →
 * `source:"global"` near-misses in the preflight trace) moved from an inline
 * `getGlobalStore()` block in tool-helpers into the AdvisoryRecall adapter
 * (mcp/advisory-recall.ts). The refactor MUST be behavior-preserving: for the
 * same ledger contents, the advisory output `present_*` emits must be
 * byte-identical before and after.
 *
 * Two proofs, both against a fixed-timestamp ledger fixture (importLedger, so
 * query()'s lastSeenAt-desc ordering is deterministic run-to-run):
 *
 *  1. GOLDEN SHA — the sha256 of the full emitted advisory payload (the
 *     preflight trace + the agent-facing summary line) was captured by running
 *     this exact test against the PRE-refactor inline implementation. The
 *     post-refactor path must reproduce it byte-for-byte. Any rewording of the
 *     advisory strings ("You avoided this in ... — still want it here?"),
 *     any dropped/reordered hit, any lost dedup fails this hash.
 *
 *  2. BOTH-PATHS — a verbatim copy of the legacy inline recall (query +
 *     token-set dedup + last-non-manual-instance attribution) lives in this
 *     file as the reference implementation. The same scenario runs through
 *     runPreflight once with the legacy-recalled concepts and once through the
 *     production preflightRejectedApproaches path; the two emitted traces must
 *     be byte-identical (JSON.stringify equality, not just deep-equal).
 *
 * Fakes-not-mocks: minimal IStore fake; the global-store singleton is
 * redirected to an isolated tmp ledger by global-store-guard.setup.ts.
 */

// Captured against the pre-refactor inline implementation (commit before the
// AdvisoryRecall adapter landed). Do NOT update this without re-deriving it
// from the legacy path — a changed hash means the advisory output changed.
const GOLDEN_SHA256 = "3d6ac24d97b36237bec685469b516166980ee68bedb2042129d3aab4ad805a1a";

/** Fixed-timestamp ledger fixture. Ordering matters: query() sorts by
 *  lastSeenAt desc, so hits emit as [pay-per-request hosting (Jan 2),
 *  global mutable state for config (Jan 1)]. */
const LEDGER_FIXTURE = {
  version: 1 as const,
  concepts: {
    "pay-per-request hosting": {
      key: "pay-per-request hosting",
      concept: "pay-per-request hosting",
      instances: [
        {
          project: "project-a",
          sessionId: "s1",
          verdict: "rejected" as const,
          reason: "expensive at scale",
          at: "2026-01-02T00:00:00.000Z",
        },
      ],
      firstSeenAt: "2026-01-02T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    },
    "global mutable state for config": {
      key: "global mutable state for config",
      concept: "global mutable state for config",
      instances: [
        // manual-only → no non-manual instance → the "another project"
        // why-branch, and project/reason stay undefined on the hit.
        {
          project: "manual",
          sessionId: "seed",
          verdict: "rejected" as const,
          reason: "seeded stance",
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
    "premature caching layer": {
      key: "premature caching layer",
      concept: "premature caching layer",
      instances: [
        {
          project: "project-b",
          sessionId: "s2",
          verdict: "rejected" as const,
          reason: "cache invalidation pain",
          at: "2026-01-03T00:00:00.000Z",
        },
      ],
      firstSeenAt: "2026-01-03T00:00:00.000Z",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    },
  },
};

// Locally APPROVED — must suppress the cross-project nudge for it (dedup).
const LOCALLY_APPROVED = "premature caching layer";
// Local rejection unrelated to the proposal — populates consideredConcepts
// (so the summary line is non-empty) without blocking or near-missing.
const LOCAL_REJECTION = {
  description: "ship the desktop app as an electron shell",
  concept: "electron wrapper",
  reason: "footprint",
};

const PROPOSAL_STRINGS = [
  "Add a global mutable state singleton for config, switch to pay-per-request " +
    "hosting, and add a premature caching layer in front of the API.",
];
const PROPOSAL_CONCEPTS = ["global mutable state for config"];

function fakeStore(): IStore {
  return {
    async getSessionMemory() {
      return {
        rejectedApproaches: [LOCAL_REJECTION],
        approvedPatterns: [LOCALLY_APPROVED],
      };
    },
  } as unknown as IStore;
}

function seedLedger() {
  getGlobalStore().importLedger(LEDGER_FIXTURE);
}

const noopBroadcast = () => {};

/**
 * LEGACY REFERENCE — verbatim copy of the pre-refactor inline recall from
 * tool-helpers.preflightRejectedApproaches (query stance:"avoid" limit:200,
 * token-set-key dedup against local rejections+approvals, attribution from the
 * most recent non-"manual" instance). Kept as the fixed reference the adapter
 * is compared against; do not "modernize" it.
 */
function legacyAdvisoryRecall(
  memory: { rejectedApproaches: Array<{ concept?: string; description: string }>; approvedPatterns: string[] },
): Array<{ concept: string; project?: string; reason?: string }> {
  const tokenSetKey = (s: string): string => {
    const toks = meaningfulTokens(s);
    return toks.length ? [...toks].sort().join(" ") : "";
  };
  const localKeys = new Set<string>();
  for (const r of memory.rejectedApproaches) {
    const k = tokenSetKey(r.concept ?? r.description);
    if (k) localKeys.add(k);
  }
  for (const a of memory.approvedPatterns) {
    const k = tokenSetKey(a);
    if (k) localKeys.add(k);
  }
  const globalAdvisoryConcepts: Array<{ concept: string; project?: string; reason?: string }> = [];
  try {
    for (const entry of getGlobalStore().query({ stance: "avoid", limit: 200 })) {
      const concept = entry.concept?.trim();
      if (!concept) continue;
      const k = tokenSetKey(concept);
      if (k && localKeys.has(k)) continue;
      const nonManual = [...entry.instances].reverse().find((i) => i.project && i.project !== "manual");
      globalAdvisoryConcepts.push({
        concept,
        project: nonManual?.project,
        reason: nonManual?.reason,
      });
    }
  } catch {
    // Non-fatal — mirrors the legacy fail-open.
  }
  return globalAdvisoryConcepts;
}

async function emitViaProductionPath(): Promise<string> {
  const res = await preflightRejectedApproaches(
    fakeStore(),
    noopBroadcast,
    "present_code_change",
    PROPOSAL_STRINGS,
    [],
    PROPOSAL_CONCEPTS,
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return JSON.stringify({
    trace: res.trace,
    summary: formatPreflightTraceSummary(res.trace),
  });
}

function emitViaLegacyPath(): string {
  const memory = {
    rejectedApproaches: [LOCAL_REJECTION],
    approvedPatterns: [LOCALLY_APPROVED],
  };
  const result = runPreflight({
    toolName: "present_code_change",
    proposalStrings: PROPOSAL_STRINGS,
    proposalPaths: [],
    proposalConcepts: PROPOSAL_CONCEPTS,
    rejectedApproaches: memory.rejectedApproaches,
    teamPreferences: [],
    globalAdvisoryConcepts: legacyAdvisoryRecall(memory),
  });
  expect(result.blocked).toBe(false);
  return JSON.stringify({
    trace: result.trace,
    summary: formatPreflightTraceSummary(result.trace),
  });
}

describe("#143 step 3 — advisory recall adapter is byte-identical to the inline implementation", () => {
  it("sanity: the scenario actually exercises the advisory path (2 hits, 1 deduped, both why-branches)", async () => {
    seedLedger();
    const payload = JSON.parse(await emitViaProductionPath()) as {
      trace: { nearMisses: Array<{ source: string; concept: string; project?: string; why?: string }> };
      summary: string;
    };
    const globalHits = payload.trace.nearMisses.filter((n) => n.source === "global");
    expect(globalHits.map((h) => h.concept)).toEqual([
      "pay-per-request hosting",
      "global mutable state for config",
    ]);
    expect(globalHits[0]?.project).toBe("project-a");
    expect(globalHits[0]?.why).toBe(
      'You avoided this in "project-a" — still want it here? (cross-project, advisory)',
    );
    // Manual-only entry: no project attribution → the "another project" branch.
    expect(globalHits[1]?.project).toBeUndefined();
    expect(globalHits[1]?.why).toBe(
      "You avoided this in another project — still want it here? (cross-project, advisory)",
    );
    // Locally-approved concept must NOT nudge.
    expect(globalHits.some((h) => h.concept === LOCALLY_APPROVED)).toBe(false);
    expect(payload.summary).toContain("Preflight: considered");
  });

  it("golden sha: emitted advisory payload matches the pre-refactor capture byte-for-byte", async () => {
    seedLedger();
    const payload = await emitViaProductionPath();
    const sha = createHash("sha256").update(payload).digest("hex");
    expect(
      sha,
      `Advisory output drifted from the pre-refactor byte capture.\nEmitted payload:\n${payload}`,
    ).toBe(GOLDEN_SHA256);
  });

  it("both paths: production adapter path === verbatim legacy inline path, byte-for-byte", async () => {
    seedLedger();
    const production = await emitViaProductionPath();
    const legacy = emitViaLegacyPath();
    expect(production).toBe(legacy);
  });
});
