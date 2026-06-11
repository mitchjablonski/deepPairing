import type { Artifact, SpecRequirement, SpecTask } from "@deeppairing/shared";
import { coerceSpecContent } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { CommentTrigger, AskTrigger } from "../CommentThread";
import { useArtifactStore } from "../../stores/artifact";

interface Props {
  artifact: Artifact;
}

const priorityStyles: Record<string, string> = {
  must: "bg-accent-red-dim text-accent-red",
  should: "bg-accent-amber-dim text-accent-amber",
  could: "bg-surface-elevated text-text-muted",
};

const estimateStyles: Record<string, string> = {
  xs: "bg-accent-green-dim text-accent-green",
  s: "bg-accent-green-dim text-accent-green",
  m: "bg-accent-amber-dim text-accent-amber",
  l: "bg-accent-red-dim text-accent-red",
  xl: "bg-accent-red text-white",
};

/**
 * Viewer for `spec` artifacts — the "think together before building" surface.
 *
 * Layout:
 *   1. Objective banner (the why)
 *   2. Context (optional background)
 *   3. Requirements list — each with rationale + acceptance criteria, plus
 *      Ask/Comment triggers so the human can challenge each one
 *   4. Design notes (optional)
 *   5. Tasks with requirement traceability
 *   6. Open questions — things the agent wants the human to decide
 */
export function SpecArtifact({ artifact }: Props) {
  // Coercion boundary: a fully-shaped SpecContent (requirements always an
  // array) so the renderer can trust the shape without per-field guards.
  const spec = coerceSpecContent(artifact.content);
  const requirements = spec.requirements;

  return (
    <div className="space-y-4">
      {/* Objective — the pairing "why" */}
      <div className="px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg">
        <div className="text-2xs font-semibold text-accent-blue/80 uppercase tracking-wide mb-1">
          Objective
        </div>
        <SimpleMarkdown
          text={spec.objective}
          className="text-sm text-text-primary font-medium space-y-1"
        />
      </div>

      {spec.context && (
        <div>
          <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Context
          </div>
          <SimpleMarkdown text={spec.context} className="text-xs text-text-secondary space-y-1" />
        </div>
      )}

      {/* Requirements — each is individually challengeable */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide">
            Requirements ({requirements.length})
          </div>
          <div className="text-[9px] text-text-muted italic">
            Challenge rationales · verify acceptance criteria
          </div>
        </div>
        <div className="space-y-2">
          {requirements.map((req, i) => (
            <RequirementRow key={req.id ?? i} requirement={req} index={i} artifact={artifact} />
          ))}
        </div>
      </div>

      {spec.design && (
        <div>
          <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Design
          </div>
          <SimpleMarkdown text={spec.design} className="text-xs text-text-secondary space-y-1" />
        </div>
      )}

      {spec.tasks && spec.tasks.length > 0 && (
        <div>
          <div className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Tasks ({spec.tasks.length})
          </div>
          <div className="space-y-1.5">
            {spec.tasks.map((t, i) => (
              <TaskRow key={i} task={t} />
            ))}
          </div>
        </div>
      )}

      {spec.openQuestions && spec.openQuestions.length > 0 && (
        <div className="px-3 py-2 bg-accent-amber-dim/30 border border-accent-amber/25 rounded">
          <div className="text-2xs font-semibold text-accent-amber uppercase tracking-wide mb-1.5">
            Open questions
          </div>
          <ul className="list-disc list-inside space-y-0.5 text-xs text-text-secondary">
            {spec.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RequirementRow({
  requirement,
  index,
  artifact,
}: {
  requirement: SpecRequirement;
  index: number;
  artifact: Artifact;
}) {
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const reqComments = comments.filter(
    (c) => (c.target as any).stepIndex === index && (c.target as any).sectionId === "requirement",
  );

  return (
    <div className="px-3 py-2.5 bg-surface-secondary border border-white/[0.06] rounded-lg">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="shrink-0 text-2xs font-mono bg-surface-elevated text-text-muted px-1.5 py-0.5 rounded">
            {requirement.id}
          </span>
          {requirement.priority && (
            <span
              className={`shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold uppercase tracking-wide ${priorityStyles[requirement.priority]}`}
            >
              {requirement.priority}
            </span>
          )}
          <span className="text-sm font-medium text-text-primary">{requirement.statement}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <AskTrigger
            artifactId={artifact.id}
            target={{ stepIndex: index, sectionId: "requirement" } as any}
          />
          <CommentTrigger
            artifactId={artifact.id}
            target={{ stepIndex: index } as any}
            existingCount={reqComments.length}
          />
        </div>
      </div>

      <div className="text-2xs text-text-muted mb-2">
        <span className="font-semibold text-text-secondary">Why:</span> {requirement.rationale}
      </div>

      {(requirement.acceptanceCriteria?.length ?? 0) > 0 && (
        <div>
          <div className="text-[9px] font-semibold text-text-muted uppercase tracking-wide mb-1">
            Acceptance criteria
          </div>
          <ul className="space-y-0.5">
            {requirement.acceptanceCriteria!.map((ac, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-text-secondary">
                <span className="text-accent-blue shrink-0 mt-0.5">☐</span>
                <span>{ac}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: SpecTask }) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5 bg-surface-elevated rounded">
      <span className="text-text-muted shrink-0 mt-0.5">→</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-secondary">{task.description}</div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {task.linkedRequirementIds?.map((id) => (
            <span key={id} className="text-[9px] font-mono bg-surface-secondary text-text-muted px-1 py-0.5 rounded">
              {id}
            </span>
          ))}
          {task.estimate && (
            <span className={`text-[9px] uppercase font-semibold px-1 py-0.5 rounded ${estimateStyles[task.estimate]}`}>
              {task.estimate}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
