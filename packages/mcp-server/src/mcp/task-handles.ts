/**
 * S5 — convert deepPairing artifacts into TaskHandles.
 *
 * The wire format is still text; this file is the seam where, when MCP
 * Tasks lands in the SDK (SEP-1686 + 2026 roadmap), each present_* tool
 * will return a Task referencing the produced handle instead of a text
 * blob, and check_feedback will become a `tasks/get` wrapper.
 *
 * Until then we keep these as pure functions: present_* tools call
 * `taskHandleForArtifact` after creating the artifact (for type-checking +
 * the seam), and a future PR adds the SDK call alongside the existing
 * text response. No behavior changes today.
 */
import type { Artifact, TaskHandle, TaskKind, TaskStatus } from "@deeppairing/shared";
import type { IStore, DecisionRecord } from "../store/store-interface.js";

export function taskKindForArtifactType(type: Artifact["type"]): TaskKind | null {
  switch (type) {
    case "research":     return "findings";
    case "decision":     return "options";
    case "spec":         return "spec";
    case "plan":         return "plan";
    case "code_change":  return "code_change";
    case "reasoning":    return "log_reasoning";
    default:             return null;
  }
}

/**
 * Map an artifact's current state into a TaskHandle. Pure read — no side
 * effects on the store.
 *
 * Status derivation:
 *   - `retracted` artifact → failed
 *   - `superseded` artifact → cancelled (a v(N+1) replaced it)
 *   - `approved` / `rejected` / `revised` → completed (human gave a verdict)
 *   - `reasoning` artifact → completed on creation (no review cycle)
 *   - otherwise (`draft`, `reviewing`) → input_required
 *
 * Response payload is shaped per taskKind so future Task render code
 * can pick the right MCP Task field without re-walking the store.
 */
export async function taskHandleForArtifact(
  artifact: Artifact,
  store: IStore,
): Promise<TaskHandle> {
  const taskKind = taskKindForArtifactType(artifact.type) ?? "log_reasoning";
  const createdAt = artifact.createdAt;
  const lastUpdatedAt = artifact.updatedAt ?? artifact.createdAt;

  let status: TaskStatus;
  let response: unknown;

  if (artifact.status === "retracted") {
    status = "failed";
  } else if (artifact.status === "superseded") {
    status = "cancelled";
  } else if (artifact.type === "reasoning") {
    // log_reasoning artifacts have no review cycle; they're "completed"
    // the moment the agent records them.
    status = "completed";
  } else if (artifact.type === "decision") {
    // Decision: completed when the human picked an option, otherwise input_required.
    const decisionContent = (artifact.content as any) ?? {};
    const decisionId = decisionContent.decisionId;
    // AA7b — getResolvedDecisions + getPlanReviewVerdict are required
    // on IStore; the casts + typeof guards were dead weight.
    if (decisionId) {
      const resolved: DecisionRecord[] = await store.getResolvedDecisions();
      const match = resolved.find((d) => d.decisionId === decisionId);
      if (match?.response) {
        status = "completed";
        response = match.response;
      } else {
        status = "input_required";
      }
    } else {
      status = "input_required";
    }
  } else if (artifact.type === "plan") {
    const verdict = await store.getPlanReviewVerdict(artifact.id);
    if (verdict) {
      status = "completed";
      response = verdict;
    } else {
      status = "input_required";
    }
  } else if (artifact.status === "approved" || artifact.status === "rejected" || artifact.status === "revised") {
    status = "completed";
    response = { status: artifact.status };
  } else {
    status = "input_required";
  }

  return {
    id: artifact.id,
    taskKind,
    status,
    artifactId: artifact.id,
    response,
    createdAt,
    lastUpdatedAt,
  };
}
