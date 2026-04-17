/**
 * Derived timeline for session replay.
 *
 * The timeline isn't persisted — it's computed from artifacts, comments,
 * decisions, and plan reviews on demand. This keeps the store simple and
 * means older sessions (without statusHistory) still produce a usable
 * best-effort replay.
 */
import type { Artifact, Comment } from "@deeppairing/shared";
import type { DecisionRecord, PlanReviewRecord } from "../store/store-interface.js";

export type TimelineEventKind =
  | "artifact_created"
  | "artifact_status_changed"
  | "comment_added"
  | "decision_resolved"
  | "plan_reviewed";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  /** ISO datetime when this event occurred. */
  at: string;
  /** Artifact id the event belongs to, if any. */
  artifactId?: string;
  /** Human-readable description used by the scrubber label + markdown export. */
  label: string;
  /** Extra per-kind payload — keep free-form so the export can inline it. */
  payload?: Record<string, unknown>;
}

export interface SessionSnapshot {
  artifacts?: Artifact[];
  comments?: Comment[];
  decisions?: DecisionRecord[];
  planReviews?: PlanReviewRecord[];
}

/** Build a chronologically-ordered TimelineEvent[] from a session snapshot. */
export function buildTimeline(state: SessionSnapshot): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const a of state.artifacts ?? []) {
    events.push({
      id: `evt_create_${a.id}`,
      kind: "artifact_created",
      at: a.createdAt,
      artifactId: a.id,
      label: `Created ${a.type}: ${a.title}`,
      payload: { type: a.type, title: a.title, version: a.version },
    });

    // If the artifact carries explicit statusHistory, emit one event per
    // transition (faithful replay). Otherwise fall back to the final status
    // using updatedAt as a best-effort timestamp.
    const history = (a as any).statusHistory as Array<{ status: string; at: string }> | undefined;
    if (history && history.length > 0) {
      for (const entry of history) {
        if (entry.status === "draft") continue; // initial state, covered by created event
        events.push({
          id: `evt_status_${a.id}_${entry.at}`,
          kind: "artifact_status_changed",
          at: entry.at,
          artifactId: a.id,
          label: `${a.title} → ${entry.status}`,
          payload: { status: entry.status },
        });
      }
    } else if (a.updatedAt !== a.createdAt && a.status !== "draft") {
      events.push({
        id: `evt_status_${a.id}_final`,
        kind: "artifact_status_changed",
        at: a.updatedAt,
        artifactId: a.id,
        label: `${a.title} → ${a.status}`,
        payload: { status: a.status },
      });
    }
  }

  for (const c of state.comments ?? []) {
    const loc = c.target?.artifactId ?? "session";
    const prefix = (c as any).intent === "question" ? "Q" : c.author === "agent" ? "A" : "You";
    events.push({
      id: `evt_comment_${c.id}`,
      kind: "comment_added",
      at: c.createdAt,
      artifactId: c.target?.artifactId,
      label: `${prefix} [${loc}]: ${c.content.slice(0, 80)}${c.content.length > 80 ? "…" : ""}`,
      payload: { author: c.author, intent: (c as any).intent, content: c.content },
    });
  }

  for (const d of state.decisions ?? []) {
    if (!d.resolvedAt || !d.response) continue;
    const chosen = d.options?.find?.((o: any) => o.id === d.response?.optionId);
    events.push({
      id: `evt_decision_${d.decisionId}`,
      kind: "decision_resolved",
      at: d.resolvedAt,
      artifactId: d.artifactId,
      label: `Decision "${d.context}" → ${chosen?.title ?? d.response.optionId}`,
      payload: {
        decisionId: d.decisionId,
        chosenOptionId: d.response.optionId,
        chosenTitle: chosen?.title,
        reasoning: d.response.reasoning,
        rejectedTitles: (d.options ?? [])
          .filter((o: any) => o.id !== d.response?.optionId)
          .map((o: any) => o.title),
      },
    });
  }

  for (const p of state.planReviews ?? []) {
    if (!p.resolvedAt || !p.verdict) continue;
    events.push({
      id: `evt_plan_${p.artifactId}`,
      kind: "plan_reviewed",
      at: p.resolvedAt,
      artifactId: p.artifactId,
      label: `Plan review: ${p.verdict}${p.feedback ? ` — ${p.feedback.slice(0, 60)}` : ""}`,
      payload: { verdict: p.verdict, feedback: p.feedback },
    });
  }

  // Stable chronological sort. Events without timestamps drop to the end.
  return events.sort((a, b) => {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at.localeCompare(b.at);
  });
}

/** Return all events up to and including the cursor timestamp. */
export function eventsUpTo(events: TimelineEvent[], cursor: string): TimelineEvent[] {
  return events.filter((e) => e.at <= cursor);
}
