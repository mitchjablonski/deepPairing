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
 * Writes go through writeJsonAtomic (unique pid+ts+random tmp + rename) so a
 * second daemon / concurrent writer can't tear the file. (It prevents torn
 * writes, not cross-process lost updates — but all real writers run in the one
 * daemon process, serialized by the event loop between read and write.)
 */

export interface MetricsCounts {
  preflightBlocks: { total: number; bySource: { session: number; team: number } };
  /**
   * Phase-1 (D) — instrumentation for the residual (feeds the Phase-2
   * embeddings decision). `preflightNearMisses`: proposals ADMITTED with token
   * coverage in [threshold,1) — the fuzzy signal a semantic matcher would
   * target. `gateEscapes`: approaches the human MANUALLY re-flagged (rejected)
   * that the gate had ADMITTED with ZERO lexical overlap against everything it
   * considered — the strongest justification for embeddings (no lexical signal
   * existed to catch it). Optional on-disk (older files default to 0).
   */
  preflightNearMisses: number;
  gateEscapes: number;
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
  | { kind: "preflight_near_miss"; source: "session" | "team" }
  | { kind: "gate_escape" }
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
    preflightNearMisses: 0,
    gateEscapes: 0,
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

/** Read the metrics file from DISK, creating a fresh shape if missing/corrupt. */
function readMetricsFromDisk(projectRoot: string): MetricsFile {
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

/**
 * SP3 — in-memory write coalescing. Pre-SP3 every recordMetricEvent did a full
 * read-parse-modify-atomic-write of metrics.json. metrics-tap fires one event
 * per broadcast (+ one per visual), so a busy session paid an O(file) RMW on
 * every artifact / comment / ledger write — pure overhead for non-critical
 * display telemetry. Now events mutate an in-memory working copy (authoritative
 * — the daemon is the only writer) and a single debounced flush persists the
 * batch. readMetrics returns the working copy so the /metrics route stays
 * fresh; flushAllMetrics() on shutdown is the durability backstop.
 */
interface MetricsCacheEntry {
  data: MetricsFile;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
const FLUSH_DEBOUNCE_MS = 1000;
const metricsCache = new Map<string, MetricsCacheEntry>();

function loadEntry(projectRoot: string): MetricsCacheEntry {
  let entry = metricsCache.get(projectRoot);
  if (!entry) {
    entry = { data: readMetricsFromDisk(projectRoot), dirty: false, timer: null };
    metricsCache.set(projectRoot, entry);
  }
  return entry;
}

function flushEntry(projectRoot: string, entry: MetricsCacheEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.dirty) return;
  entry.dirty = false;
  writeMetrics(projectRoot, entry.data);
}

function scheduleFlush(projectRoot: string, entry: MetricsCacheEntry): void {
  // Coalesce: if a flush is already pending, let it fire — so a continuous
  // event stream still persists at most once per FLUSH_DEBOUNCE_MS rather than
  // never (a pure trailing debounce would starve a perpetually-busy session).
  if (entry.timer) return;
  entry.timer = setTimeout(() => flushEntry(projectRoot, entry), FLUSH_DEBOUNCE_MS);
  // Don't keep the event loop alive just to flush metrics — shutdown flush
  // (flushAllMetrics) is the durability path on a clean exit.
  entry.timer.unref?.();
}

/** Flush every dirty project's metrics synchronously. Call on daemon shutdown. */
export function flushAllMetrics(): void {
  for (const [projectRoot, entry] of metricsCache) {
    flushEntry(projectRoot, entry);
  }
}

/** Test-only: clear timers + cache so module state doesn't leak across tests. */
export function __resetMetricsCacheForTests(): void {
  for (const entry of metricsCache.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  metricsCache.clear();
}

/** Read the metrics (in-memory working copy; loaded from disk on first access). */
export function readMetrics(projectRoot: string): MetricsFile {
  return loadEntry(projectRoot).data;
}

/** Apply an event to the in-memory metrics; a debounced flush persists it. */
export function recordMetricEvent(projectRoot: string, event: MetricsEvent): void {
  const entry = loadEntry(projectRoot);
  const data = entry.data;
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
    case "preflight_near_miss":
      data.counts.preflightNearMisses += 1;
      break;
    case "gate_escape":
      data.counts.gateEscapes += 1;
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

  entry.dirty = true;
  scheduleFlush(projectRoot, entry);
}
