/**
 * P1 — scripted demo proving concept-aware rejection blocking in under a
 * minute. Extracted from daemon.ts so it can be unit-tested with fake timers
 * and a fake broadcast sink; the daemon wires in its real store + broadcast.
 */
import type { IStore } from "./store/store-interface.js";

export interface DemoScriptDeps {
  sessionId: string;
  store: IStore;
  broadcast: (sessionId: string, event: any) => void;
  /** Defaults to setTimeout; override in tests to use fake timers. */
  schedule?: (ms: number, fn: () => void | Promise<void>) => void | (() => void);
  /** Deterministic id generator override for tests. */
  makeArtifactId?: () => string;
}

// Exported so a test can prove the demo depicts a match the REAL token-matcher
// (conceptMatchesProposal) would actually make — the demo scripts its own
// broadcast, so without that guard it could dramatize a semantic match the
// substring matcher can't do (which would make the honest README a liar).
export const DEFAULT_REJECTION_CONCEPT = "global mutable state for config";
export const DEFAULT_REJECTION_REASON =
  "we tried global state for config last project — broke testability in 3 places";
export const DEFAULT_REJECTION_DESCRIPTION =
  "Config loader: global mutable ConfigStore singleton";
// The re-proposal MUST reuse every ≥4-char token of the concept (global,
// mutable, state, config) — that's exactly what conceptMatchesProposal keys
// on, so this is a block the real gate would also produce.
export const DEFAULT_REPROPOSAL =
  "Add a global mutable state singleton to hold config";

/** Run the demo script against the given store + broadcast. Fires broadcasts
 *  on a timeline; callers can observe them as they land. */
export function runDemoScript({
  sessionId,
  store,
  broadcast,
  schedule = defaultSchedule,
  makeArtifactId = defaultArtifactId,
}: DemoScriptDeps): { artifactId: string; cancel: () => void } {
  let cancelled = false;
  const cancellations: Array<() => void> = [];
  const scheduleStep = (ms: number, fn: () => void | Promise<void>) => {
    const cancel = schedule(ms, () => { if (!cancelled) return fn(); });
    if (cancel) cancellations.push(cancel);
  };
  const findingsArtifactId = makeArtifactId();

  // t=500ms — the agent "proposes" the first findings artifact
  scheduleStep(500, async () => {
    const artifact = await store.createArtifact({
      id: findingsArtifactId,
      type: "research",
      title: "Config loader refactor — proposed approach",
      content: {
        summary: "Add a global mutable state singleton for config access across services.",
        findings: [{
          category: "Architecture",
          title: "Introduce ConfigStore global singleton",
          detail: "A shared mutable ConfigStore would cache config across services without repeated loads. All modules import the same instance.",
          significance: "high",
          severity: "medium",
          recommendation: "Add a ConfigStore class exported as a singleton from config/index.ts.",
        }],
      },
    });
    broadcast(sessionId, { type: "artifact_created", artifact });
  });

  // t=2500ms — the user "rejects" it
  scheduleStep(2500, async () => {
    await store.updateArtifactStatus(findingsArtifactId, "rejected", "demo_script");
    await store.recordRejectedApproach({
      description: DEFAULT_REJECTION_DESCRIPTION,
      reason: DEFAULT_REJECTION_REASON,
      sourceArtifactId: findingsArtifactId,
      concept: DEFAULT_REJECTION_CONCEPT,
    });
    broadcast(sessionId, { type: "artifact_updated", artifactId: findingsArtifactId, status: "rejected" });
    broadcast(sessionId, {
      type: "ledger_write",
      kind: "rejected",
      description: DEFAULT_REJECTION_DESCRIPTION,
      concept: DEFAULT_REJECTION_CONCEPT,
      reason: DEFAULT_REJECTION_REASON,
      sourceArtifactId: findingsArtifactId,
    });
  });

  // t=5000ms — the agent tries again with a variant that REUSES the concept's
  // words; the token-matcher catches it and the hero toast fires. This is the
  // money shot — what the demo exists to show. The proposal is chosen so the
  // REAL conceptMatchesProposal would block it too (see demo-script.test.ts) —
  // the demo doesn't dramatize a match the substring matcher can't make.
  scheduleStep(5000, () => {
    broadcast(sessionId, {
      type: "preflight_blocked",
      toolName: "present_findings",
      source: "session",
      match: {
        proposal: DEFAULT_REPROPOSAL,
        description: DEFAULT_REJECTION_DESCRIPTION,
        reason: DEFAULT_REJECTION_REASON,
        concept: DEFAULT_REJECTION_CONCEPT,
        via: "concept",
      },
    });
  });

  // #194 E3 — the demo also shows the v0.1.22 COMPREHENSION headline, not just
  // the rejection gate. Two closing beats: a read-only EXPLAINER (how the safer
  // approach works) then the end-of-run DEBRIEF (the five lanes), both told
  // against THIS demo's own story so a fresh install feels the whole loop.
  const explainerArtifactId = makeArtifactId();
  // t=6500ms — comprehension surface #1: the narrated walk-through of the
  // dependency-injected loader the agent pivoted to after the rejection.
  scheduleStep(6500, async () => {
    const artifact = await store.createArtifact({
      id: explainerArtifactId,
      type: "explainer",
      title: "How config loading works after the pivot",
      content: {
        title: "How config loading works after the pivot",
        overview:
          "You rejected a global mutable ConfigStore singleton. Here's the read-only walk-through of the dependency-injected loader that replaced it — no shared mutable state, testable per module.",
        sections: [
          {
            heading: "Config is injected, not reached for",
            body: "Each service receives its config through its constructor instead of importing a shared singleton, so a test can hand in a fixture without touching global state.",
            evidence: [
              {
                filePath: "src/config/loader.ts",
                lineStart: 1,
                lineEnd: 8,
                snippet:
                  "export function loadConfig(env: Env): AppConfig {\n  return parse(env);\n}\n\nexport class OrderService {\n  constructor(private config: AppConfig) {}\n}",
                explanation: "loadConfig is a pure function; OrderService takes the resolved config — the pattern your rejection steered us to.",
              },
            ],
          },
          {
            heading: "Why this survives testing",
            body: "Because nothing mutates a shared instance, two tests can run with different configs in the same process — the exact failure ('broke testability in 3 places') that made you reject the singleton.",
          },
        ],
        suggestedQuestions: ["Where does env parsing happen?", "How do we handle a missing key?"],
      },
    });
    broadcast(sessionId, { type: "artifact_created", artifact });
  });

  const debriefArtifactId = makeArtifactId();
  // t=8000ms — comprehension surface #2: the DEBRIEF closes the loop with the
  // five lanes (narrative, decisions made alone, needs-your-eyes, deferred,
  // open questions), told against this demo's own story.
  scheduleStep(8000, async () => {
    const artifact = await store.createArtifact({
      id: debriefArtifactId,
      type: "debrief",
      title: "Debrief — config loader pivot",
      content: {
        summary:
          "You rejected the global mutable ConfigStore, so I pivoted to a dependency-injected loader. When I drifted back toward a global singleton, the rejection gate stopped me before the edit landed.",
        sections: [
          {
            title: "What changed",
            body: "Config now flows through constructors instead of a shared mutable singleton.",
            concepts: [{ name: "dependency injection", oneLineExplanation: "Pass collaborators in rather than reaching for a global." }],
          },
        ],
        decisionsMade: [
          {
            what: "Made config immutable + injected",
            why: "Your rejection reason was that global mutable config broke testability in 3 places.",
            alternative: "A read-through cache on the singleton (still shared mutable state).",
          },
        ],
        needsYourEyes: [
          {
            what: "The loader's env-parsing edge cases",
            why: "It's the one spot that can still throw at startup.",
            artifactRef: explainerArtifactId,
          },
        ],
        deferred: [
          {
            what: "Migrating the two legacy call sites still importing the old singleton",
            why: "Out of scope for this pass; flagged so it isn't forgotten.",
          },
        ],
        openQuestions: ["Should a missing key fail fast at boot, or fall back to a default?"],
      },
    });
    broadcast(sessionId, { type: "artifact_created", artifact });
  });

  return { artifactId: findingsArtifactId, cancel: () => {
    cancelled = true;
    for (const cancel of cancellations) cancel();
  } };
}

function defaultSchedule(ms: number, fn: () => void | Promise<void>): () => void {
  const t = setTimeout(() => { void fn(); }, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

function defaultArtifactId(): string {
  return `art_demo_${Math.random().toString(36).slice(2, 8)}`;
}
