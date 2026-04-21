/**
 * Browser-side mirror of src/replay/timeline.ts. Kept separate so the web
 * bundle doesn't pull in Node-only dependencies from the server code.
 */
import type { Artifact, Comment, SessionAnnotation } from "@deeppairing/shared";

export type TimelineEventKind =
  | "artifact_created"
  | "artifact_status_changed"
  | "comment_added"
  | "decision_resolved"
  | "plan_reviewed";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  at: string;
  artifactId?: string;
  label: string;
  payload?: Record<string, unknown>;
}

interface DecisionLike {
  decisionId: string;
  artifactId: string;
  context: string;
  options: any[];
  response?: { optionId: string; reasoning?: string };
  createdAt?: string;
  resolvedAt?: string;
}

interface PlanReviewLike {
  artifactId: string;
  verdict?: string;
  feedback?: string;
  createdAt?: string;
  resolvedAt?: string;
}

export function buildTimeline(state: {
  artifacts?: Artifact[];
  comments?: Comment[];
  decisions?: DecisionLike[];
  planReviews?: PlanReviewLike[];
}): TimelineEvent[] {
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

    const history = (a as any).statusHistory as Array<{ status: string; at: string }> | undefined;
    if (history && history.length > 0) {
      for (const entry of history) {
        if (entry.status === "draft") continue;
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

  return events.sort((a, b) => {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at.localeCompare(b.at);
  });
}

export function annotationsByEventId(
  annotations: SessionAnnotation[],
): Map<string, SessionAnnotation[]> {
  const map = new Map<string, SessionAnnotation[]>();
  for (const a of annotations) {
    const list = map.get(a.targetEventId) ?? [];
    list.push(a);
    map.set(a.targetEventId, list);
  }
  return map;
}
