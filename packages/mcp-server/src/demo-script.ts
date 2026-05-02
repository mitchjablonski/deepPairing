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
  schedule?: (ms: number, fn: () => void | Promise<void>) => void;
  /** Deterministic id generator override for tests. */
  makeArtifactId?: () => string;
}

const DEFAULT_REJECTION_CONCEPT = "global mutable state for config";
const DEFAULT_REJECTION_REASON =
  "we tried global state for config last project — broke testability in 3 places";
const DEFAULT_REJECTION_DESCRIPTION =
  "Config loader: global mutable ConfigStore singleton";

/** Run the demo script against the given store + broadcast. Fires broadcasts
 *  on a timeline; callers can observe them as they land. */
export function runDemoScript({
  sessionId,
  store,
  broadcast,
  schedule = defaultSchedule,
  makeArtifactId = defaultArtifactId,
}: DemoScriptDeps): { artifactId: string } {
  const findingsArtifactId = makeArtifactId();

  // t=500ms — the agent "proposes" the first findings artifact
  schedule(500, async () => {
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
  schedule(2500, async () => {
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

  // t=5000ms — the agent tries again with a paraphrased variant; pre-flight
  // catches it by concept match and the hero toast fires. This is the
  // money shot — what the demo exists to show.
  schedule(5000, () => {
    broadcast(sessionId, {
      type: "preflight_blocked",
      toolName: "present_findings",
      source: "session",
      match: {
        proposal: "Add a global config cache for hot lookups",
        description: DEFAULT_REJECTION_DESCRIPTION,
        reason: DEFAULT_REJECTION_REASON,
        concept: DEFAULT_REJECTION_CONCEPT,
        via: "concept",
      },
    });
  });

  return { artifactId: findingsArtifactId };
}

function defaultSchedule(ms: number, fn: () => void | Promise<void>): void {
  const t = setTimeout(() => { void fn(); }, ms);
  t.unref?.();
}

function defaultArtifactId(): string {
  return `art_demo_${Math.random().toString(36).slice(2, 8)}`;
}
