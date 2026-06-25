import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";

/**
 * R1 — local, per-project telemetry.
 *
 * Lives at `.deeppairing/metrics.json` alongside daemon.json and
 * preferences.json. Counts the events that prove the hook is actually
 * working for this user:
 *   - Pre-flight blocks fired (by source: session / team)
 *   - Ledger writes (rejected / approved)
 *   - Retrospectives captured (right / wrong / mixed)
 *   - Horizon checks requested
 *   - Questions asked vs answered
 *
 * Zero network traffic. The user can see these in Settings → Session
 * metrics. We keep a `firstSeenAt` anchor so "how many blocks in the
 * last 30 days" stays meaningful when someone reads this on a project
 * they've been using for months.
 *
 * Atomic writes via tmp+rename so concurrent wrappers don't tear the file.
 */

export interface MetricsCounts {
  preflightBlocks: { total: number; bySource: { session: number; team: number } };
  ledgerWrites: { total: number; rejected: number; approved: number };
  retrospectives: { total: number; right: number; wrong: number; mixed: number };
  horizonChecksRequested: number;
  questions: { asked: number; answered: number };
  // Production telemetry — does the agent actually USE the structured surface,
  // and does the human engage with it? (Added to answer "is any of this used?")
  artifacts: { total: number; byType: Record<string, number> };
  visuals: { total: number; byKind: Record<string, number> };
  comments: number;
}

export interface MetricsFile {
  version: 1;
  firstSeenAt: string;
  lastActivityAt: string;
  sessions: number;
  counts: MetricsCounts;
}

export type MetricsEvent =
  | { kind: "preflight_block"; source: "session" | "team" }
  | { kind: "ledger_write"; verdict: "rejected" | "approved" }
  | { kind: "retrospective"; verdict: "right" | "wrong" | "mixed" }
  | { kind: "horizon_check_requested" }
  | { kind: "question_asked" }
  | { kind: "question_answered" }
  | { kind: "session_started" }
  | { kind: "artifact_created"; artifactType: string }
  | { kind: "visual_attached"; visualKind: string }
  | { kind: "comment_added" };

const VERSION = 1 as const;

function emptyCounts(): MetricsCounts {
  return {
    preflightBlocks: { total: 0, bySource: { session: 0, team: 0 } },
    ledgerWrites: { total: 0, rejected: 0, approved: 0 },
    retrospectives: { total: 0, right: 0, wrong: 0, mixed: 0 },
    horizonChecksRequested: 0,
    questions: { asked: 0, answered: 0 },
    artifacts: { total: 0, byType: {} },
    visuals: { total: 0, byKind: {} },
    comments: 0,
  };
}

function metricsPath(projectRoot: string): string {
  return path.join(projectRoot, ".deeppairing", "metrics.json");
}

/** Read the metrics file, creating a fresh shape if missing/corrupt. */
export function readMetrics(projectRoot: string): MetricsFile {
  const file = metricsPath(projectRoot);
  try {
    if (!fs.existsSync(file)) {
      const now = new Date().toISOString();
      return { version: VERSION, firstSeenAt: now, lastActivityAt: now, sessions: 0, counts: emptyCounts() };
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<MetricsFile>;
    if (parsed.version !== VERSION || !parsed.counts) {
      // Unknown shape — start over, don't risk propagating a corrupted file.
      const now = new Date().toISOString();
      return { version: VERSION, firstSeenAt: now, lastActivityAt: now, sessions: 0, counts: emptyCounts() };
    }
    return {
      version: VERSION,
      firstSeenAt: parsed.firstSeenAt ?? new Date().toISOString(),
      lastActivityAt: parsed.lastActivityAt ?? new Date().toISOString(),
      sessions: parsed.sessions ?? 0,
      counts: {
        ...emptyCounts(),
        ...parsed.counts,
        preflightBlocks: { ...emptyCounts().preflightBlocks, ...(parsed.counts?.preflightBlocks ?? {}) },
        ledgerWrites: { ...emptyCounts().ledgerWrites, ...(parsed.counts?.ledgerWrites ?? {}) },
        retrospectives: { ...emptyCounts().retrospectives, ...(parsed.counts?.retrospectives ?? {}) },
        questions: { ...emptyCounts().questions, ...(parsed.counts?.questions ?? {}) },
        artifacts: { ...emptyCounts().artifacts, ...(parsed.counts?.artifacts ?? {}) },
        visuals: { ...emptyCounts().visuals, ...(parsed.counts?.visuals ?? {}) },
      },
    };
  } catch {
    const now = new Date().toISOString();
    return { version: VERSION, firstSeenAt: now, lastActivityAt: now, sessions: 0, counts: emptyCounts() };
  }
}

function writeMetrics(projectRoot: string, data: MetricsFile): void {
  const file = metricsPath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // F5 — use the shared PID+ts+random atomic writer rather than a fixed
    // `${file}.tmp`. A second daemon (port-collision / sleep-handoff) or a
    // concurrent route writer racing on the fixed tmp name could tear the
    // file; writeJsonAtomic gives each writer a unique tmp before the rename.
    writeJsonAtomic(file, data);
  } catch {
    // Non-fatal — losing a count is preferable to crashing a session
  }
}

/** Apply an event to the metrics file. Atomic read-modify-write. */
export function recordMetricEvent(projectRoot: string, event: MetricsEvent): void {
  const data = readMetrics(projectRoot);
  const now = new Date().toISOString();
  data.lastActivityAt = now;

  switch (event.kind) {
    case "session_started":
      data.sessions += 1;
      break;
    case "preflight_block":
      data.counts.preflightBlocks.total += 1;
      data.counts.preflightBlocks.bySource[event.source] += 1;
      break;
    case "ledger_write":
      data.counts.ledgerWrites.total += 1;
      data.counts.ledgerWrites[event.verdict] += 1;
      break;
    case "retrospective":
      data.counts.retrospectives.total += 1;
      data.counts.retrospectives[event.verdict] += 1;
      break;
    case "horizon_check_requested":
      data.counts.horizonChecksRequested += 1;
      break;
    case "question_asked":
      data.counts.questions.asked += 1;
      break;
    case "question_answered":
      data.counts.questions.answered += 1;
      break;
    case "artifact_created":
      data.counts.artifacts.total += 1;
      data.counts.artifacts.byType[event.artifactType] =
        (data.counts.artifacts.byType[event.artifactType] ?? 0) + 1;
      break;
    case "visual_attached":
      data.counts.visuals.total += 1;
      data.counts.visuals.byKind[event.visualKind] =
        (data.counts.visuals.byKind[event.visualKind] ?? 0) + 1;
      break;
    case "comment_added":
      data.counts.comments += 1;
      break;
  }

  writeMetrics(projectRoot, data);
}
