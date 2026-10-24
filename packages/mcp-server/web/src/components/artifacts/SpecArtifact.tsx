import type { Artifact, SpecEdgePath, SpecRequirement, SpecTask } from "@deeppairing/shared";
import { coerceSpecContent } from "@deeppairing/shared";
import { SimpleMarkdown } from "../SimpleMarkdown";
import { CommentTrigger, AskTrigger } from "../CommentThread";
import { OpenQuestionSection } from "./OpenQuestionSection";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { ExecutionStrip, StepStatusMarker, NON_EXECUTABLE_STATUSES, SupersededProgressCue, isClosedWithSuccessor } from "./ExecutionProgress";
import { useChainComments } from "../../hooks/useChainComments";
import { useWriteLock } from "../../hooks/useWriteLock";

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
 *   5. Edge paths & interaction risks (#571, optional) — above the tasks so
 *      the brief's one human touch sees them before any code
 *   6. Tasks with requirement traceability
 *   7. Open questions — things the agent wants the human to decide
 */
export function SpecArtifact({ artifact }: Props) {
  // Coercion boundary: a fully-shaped SpecContent (requirements always an
  // array) so the renderer can trust the shape without per-field guards.
  const spec = coerceSpecContent(artifact.content);
  const requirements = spec.requirements;
  // #207 (I2) — the WRITE AXIS, via the shared useWriteLock hook: a retracted
  // (→ "closed") or replayed (→ "frozen") spec withholds EVERY composer it hosts
  // (visuals, requirement threads, open questions) uniformly. Draft ("review")
  // stays writable; approved ("follow_up") STAYS late-commentable (the #187 lane
  // — approved is never locked). Posted history stays readable.
  const writeLocked = useWriteLock(artifact.status);

  return (
    <div className="space-y-4">
      {/* Objective — the pairing "why" */}
      <div className="px-4 py-3 bg-accent-blue-dim/20 border border-accent-blue/20 rounded-lg">
        {/* Q4 review (L8) — the alpha class again, and the worst instance of
            it: composited on its own blue-dim/20 wash this measured 3.57:1
            light / 4.28:1 dark — sub-AA in BOTH themes, on the label naming
            the spec's whole purpose (and now a real heading). Full strength =
            5.16 light / 5.93 dark; the wash already does the de-emphasis. */}
        <h3 className="text-2xs font-semibold text-accent-blue uppercase tracking-wide mb-1">
          Objective
        </h3>
        <SimpleMarkdown
          text={spec.objective}
          className="prose-field text-sm text-text-primary font-medium space-y-1"
        />
      </div>

      {spec.context && (
        <div>
          <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Context
          </h3>
          <SimpleMarkdown text={spec.context} className="prose-field text-xs text-text-secondary space-y-1" />
        </div>
      )}

      {/* Visuals frame the spec — diagrams / file maps the human can comment on
          (composers withheld when the spec is retracted/terminal or replayed). */}
      <ArtifactVisuals artifactId={artifact.id} visuals={spec.visuals ?? []} readOnly={writeLocked} />

      {/* Requirements — each is individually challengeable */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide">
            Requirements ({requirements.length})
          </h3>
          <div className="text-[9px] text-text-muted italic">
            Challenge rationales · verify acceptance criteria
          </div>
        </div>
        <div className="space-y-2">
          {requirements.map((req, i) => (
            <RequirementRow key={req.id ?? i} requirement={req} index={i} artifact={artifact} writeLocked={writeLocked} />
          ))}
        </div>
      </div>

      {spec.design && (
        <div>
          <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Design
          </h3>
          <SimpleMarkdown text={spec.design} className="prose-field text-xs text-text-secondary space-y-1" />
        </div>
      )}

      <EdgePathsSection
        artifact={artifact}
        edgePaths={spec.edgePaths}
        isBrief={isDelegateBrief(spec.context)}
        writeLocked={writeLocked}
      />

      {spec.tasks && spec.tasks.length > 0 && (
        <div>
          <h3 className="text-2xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
            Tasks ({spec.tasks.length})
          </h3>
          {/* #569 (#507 S1) — the same joint checklist plans get: the agent
              marks tasks via update_plan_progress. Only once ANY task carries
              a status (old specs stay untracked and render as before). */}
          {isClosedWithSuccessor(artifact.status) && spec.tasks.some((t) => t.status) && (
            <SupersededProgressCue noun="task" />
          )}
          {!NON_EXECUTABLE_STATUSES.includes(artifact.status) &&
            spec.tasks.some((t) => t.status) && (
            <div className="mb-1.5">
              <ExecutionStrip items={spec.tasks} sessionId={artifact.sessionId} noun="task" />
            </div>
          )}
          <div className="space-y-1.5">
            {spec.tasks.map((t, i) => (
              <TaskRow key={i} task={t} index={i} tracked={spec.tasks!.some((x) => x.status)} />
            ))}
          </div>
        </div>
      )}

      {spec.openQuestions && spec.openQuestions.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-2xs font-semibold text-accent-amber uppercase tracking-wide">
            Open questions ({spec.openQuestions.length})
          </h3>
          {/* #164 — open questions are the agent explicitly asking its pair for
              input. Each is its own bounded section with a prominent answer
              affordance + inline thread (shared with ResearchArtifact). D8 (H1)
              per-question targeting lives inside the shared component so
              answers land in the agent's feedback lane. */}
          {spec.openQuestions.map((q, i) => (
            <OpenQuestionSection key={i} artifactId={artifact.id} question={q} index={i} readOnly={writeLocked} />
          ))}
        </div>
      )}

      {/* U1 — a draft spec is counted as "your turn" (REVIEWABLE_TYPES), so it
          must offer the review actions; without this it nagged forever with no
          way to approve/revise/reject. Mirrors ResearchArtifact. */}
      <ArtifactStatusActions artifact={artifact} />
    </div>
  );
}

function RequirementRow({
  requirement,
  index,
  artifact,
  writeLocked = false,
}: {
  requirement: SpecRequirement;
  index: number;
  artifact: Artifact;
  /** #207 (I2) — withhold the per-requirement ask/comment composers when the
   *  spec is retracted/terminal or replayed. The comment COUNT + prior thread
   *  stay readable below; only the write triggers are pulled. */
  writeLocked?: boolean;
}) {
  const comments = useChainComments(artifact.id); // Bug2 — chain aggregation
  // D8 (M6) — match by stable requirementId first; keep the legacy
  // stepIndex+sectionId shape so existing comments still count. The old
  // filter ALSO demanded sectionId, which CommentTrigger never sent — so
  // comment counts on requirements could never increment (verified bug).
  const reqComments = comments.filter(
    (c) =>
      c.target.requirementId === requirement.id ||
      (c.target.stepIndex === index &&
        (c.target.sectionId === "requirement" || c.target.sectionId == null)),
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
        {!writeLocked && (
          <div className="flex items-center gap-1 shrink-0">
            <AskTrigger
              artifactId={artifact.id}
              target={{ requirementId: requirement.id, stepIndex: index, sectionId: "requirement" }}
            />
            <CommentTrigger
              artifactId={artifact.id}
              target={{ requirementId: requirement.id, stepIndex: index, sectionId: "requirement" }}
              existingCount={reqComments.length}
            />
          </div>
        )}
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

/**
 * #571 slice 1 — a delegate brief (`/deeppairing:delegate` move 2) is a spec
 * whose `context` carries the headed `Decide alone:` and `Risk class:` lines.
 * Cheap and content-only: no new field marks a brief. Used solely to decide
 * whether an ABSENT edge-path list earns the gentle "none declared" hint;
 * an ordinary spec without edge paths renders exactly as before.
 */
export function isDelegateBrief(context: string | undefined): boolean {
  if (!context) return false;
  return /\bDecide alone:/i.test(context) && /\bRisk class:/i.test(context);
}

/** The comment grain for one edge path. Index-anchored (edge paths carry no
 *  id); check_feedback resolves the index back to the path's own text. */
export const edgePathSectionId = (index: number) => `spec:edge-path:${index}`;

/**
 * #571 slice 1 — "Edge paths & interaction risks": the states, call paths,
 * untrusted inputs and inert modes the change must handle. In the #569 pilot
 * an approved brief named none of these, and an independent reviewer later
 * found five defects on exactly such paths. One compact row per path (path,
 * risk, handling), each commentable at its own `sectionId` grain.
 */
function EdgePathsSection({
  artifact,
  edgePaths,
  isBrief,
  writeLocked,
}: {
  artifact: Artifact;
  edgePaths: SpecEdgePath[] | undefined;
  isBrief: boolean;
  writeLocked: boolean;
}) {
  const comments = useChainComments(artifact.id);
  if (!edgePaths || edgePaths.length === 0) {
    if (!isBrief) return null;
    return (
      <p className="text-2xs text-text-muted italic" data-testid="spec-edge-paths-none">
        No edge paths declared. Which states, call paths, inputs or modes could this change miss?
      </p>
    );
  }
  return (
    <section aria-label="Edge paths and interaction risks" data-testid="spec-edge-paths">
      <h3 className="text-2xs font-semibold text-accent-amber uppercase tracking-wide mb-1.5">
        Edge paths &amp; interaction risks ({edgePaths.length})
      </h3>
      <ul className="space-y-1.5">
        {edgePaths.map((e, i) => {
          const sectionId = edgePathSectionId(i);
          const count = comments.filter((c) => c.target.sectionId === sectionId).length;
          return (
            <li
              key={i}
              data-comment-anchor={sectionId}
              className="px-3 py-2 bg-surface-secondary border border-accent-amber/20 rounded-lg"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-xs font-medium text-text-primary">{e.path}</div>
                  <div className="text-2xs text-text-secondary">
                    <span className="font-semibold">Risk:</span> {e.risk}
                  </div>
                  <div className="text-2xs text-text-secondary">
                    <span className="font-semibold">Handled:</span>{" "}
                    {e.handling ? e.handling : <span className="italic text-text-muted">not stated</span>}
                  </div>
                </div>
                {!writeLocked && (
                  <div className="flex items-center gap-1 shrink-0">
                    <AskTrigger artifactId={artifact.id} target={{ sectionId }} />
                    <CommentTrigger artifactId={artifact.id} target={{ sectionId }} existingCount={count} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskRow({ task, index, tracked }: { task: SpecTask; index: number; tracked: boolean }) {
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5 bg-surface-elevated rounded">
      {/* #569 — once execution is tracked, the arrow becomes the plan's
          per-step status marker (✓ done, pulsing in progress, struck skipped). */}
      {tracked ? (
        <StepStatusMarker index={index} status={task.status} noun="task" />
      ) : (
        <span className="text-text-muted shrink-0 mt-0.5">→</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-secondary">{task.description}</div>
        {task.statusNote && (
          <p className="text-2xs text-accent-amber mt-0.5">{task.statusNote}</p>
        )}
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
