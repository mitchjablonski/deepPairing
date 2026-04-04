import type { DecisionRecord } from "../repositories/types.js";
import type { DecisionRepository } from "../repositories/types.js";
import type { ArtifactStore } from "./artifact-store.js";

/**
 * Builds a concise context summary for injection into a resumed session
 * or after context compaction. Includes decisions, artifact status, and
 * unacknowledged human feedback.
 */
export async function buildSessionContext(
  decisionRepo: DecisionRepository,
  artifactStore: ArtifactStore,
  sessionId: string,
): Promise<string> {
  const sections: string[] = [];

  // Decision context
  const decisionContext = await buildDecisionContext(decisionRepo, sessionId);
  if (decisionContext) sections.push(decisionContext);

  // Artifact context
  const artifactContext = await buildArtifactContext(artifactStore);
  if (artifactContext) sections.push(artifactContext);

  // Feedback context
  const feedbackContext = await buildFeedbackContext(artifactStore);
  if (feedbackContext) sections.push(feedbackContext);

  return sections.join("\n\n---\n\n");
}

/** Legacy export for backward compatibility */
export async function buildDecisionContext(
  decisionRepo: DecisionRepository,
  sessionId: string,
): Promise<string> {
  const decisions = await decisionRepo.getBySession(sessionId);
  const resolved = decisions.filter((d) => d.status === "resolved");

  if (resolved.length === 0) {
    return "";
  }

  const lines = resolved.map((d) => formatDecision(d));

  return `## Prior Decisions in This Session

The following decisions were made earlier in this session. Use them as context
for your continued work. Do not re-propose alternatives that were already rejected.

${lines.join("\n\n")}`;
}

async function buildArtifactContext(artifactStore: ArtifactStore): Promise<string> {
  const artifacts = await artifactStore.getArtifactsBySession();
  if (artifacts.length === 0) return "";

  const lines = artifacts
    .filter((a) => a.status !== "superseded")
    .map((a) => {
      let line = `- **${a.title}** (${a.type}): ${a.status}`;
      if (a.status === "rejected") {
        line += " — DO NOT revisit this approach";
      }
      if (a.status === "revised") {
        line += " — revisions were requested, check feedback";
      }
      return line;
    });

  return `## Artifact Status

${lines.join("\n")}`;
}

async function buildFeedbackContext(artifactStore: ArtifactStore): Promise<string> {
  const comments = await artifactStore.getUnacknowledgedComments();
  if (comments.length === 0) return "";

  const lines = comments.map((c) => {
    const target = c.target;
    let location = target.artifactId;
    if (target.lineNumber != null) location += ` (line ${target.lineNumber})`;
    if (target.findingIndex != null) location += ` (finding #${target.findingIndex + 1})`;
    if (target.stepIndex != null) location += ` (step #${target.stepIndex + 1})`;
    return `- [${location}] ${c.content}`;
  });

  return `## Unacknowledged Human Feedback

The human left these comments. Address them in your next actions.

${lines.join("\n")}`;
}

function formatDecision(d: DecisionRecord): string {
  const options = d.options as Array<{ id: string; title: string; description: string }>;
  const chosen = options.find((o) => o.id === d.selectedOptionId);
  const rejected = options.filter((o) => o.id !== d.selectedOptionId);

  let text = `### Decision: ${d.context}`;
  text += `\n**Chosen:** ${chosen?.title ?? d.selectedOptionId}`;
  if (chosen?.description) {
    text += ` — ${chosen.description}`;
  }
  if (d.humanReasoning) {
    text += `\n**Human's reasoning:** ${d.humanReasoning}`;
  }
  if (rejected.length > 0) {
    text += `\n**Rejected alternatives:** ${rejected.map((r) => r.title).join(", ")}`;
  }

  return text;
}
