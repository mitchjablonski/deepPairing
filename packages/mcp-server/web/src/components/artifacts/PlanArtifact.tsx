import type { Artifact } from "@deeppairing/shared";
import { coercePlanContent } from "@deeppairing/shared";
import { CommentTrigger, AskTrigger } from "../CommentThread";
import { ArtifactVisuals } from "../ArtifactVisuals";
import { CommentableCode } from "../CommentableCode";
import { OpenInEditorLink } from "../OpenInEditor";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactStatusActions } from "./ArtifactStatusActions";
import { computeLineDiff } from "../../lib/diff";
import { useEffect, useMemo, useState } from "react";

/** Clickable badges that link to the finding artifacts that motivated a step */
function MotivatedByBadges({ labels }: { labels: string[] }) {
  const artifacts = useArtifactStore((s) => s.artifacts);
  const selectArtifact = useArtifactStore((s) => s.selectArtifact);

  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      <span className="text-[10px] text-text-muted">From:</span>
      {labels.map((label, i) => {
        // Try to find matching research artifact by title
        const match = artifacts.find(
          (a) => a.type === "research" && a.title.toLowerCase().includes(label.toLowerCase()),
        ) ?? artifacts.find((a) => {
          // Defensive: `?.findings?.some` only guards null/undefined — a
          // research artifact whose `findings` is a non-array (string, etc.)
          // would throw "some is not a function" and crash the whole plan
          // detail view. A plan step's `motivatedBy` also legitimately carries
          // non-artifact-id labels (e.g. "REQ-1"), so no-match must degrade to
          // a plain badge, never throw.
          if (a.type !== "research") return false;
          const findings = (a.content as any)?.findings;
          if (!Array.isArray(findings)) return false;
          return findings.some((f: any) => f?.title?.toLowerCase?.().includes(label.toLowerCase()));
        });

        if (match) {
          return (
            <button
              key={i}
              onClick={() => selectArtifact(match.id)}
              className="px-1.5 py-0.5 bg-accent-amber-dim text-accent-amber rounded text-[10px]
                         hover:bg-accent-amber-dim/80 transition-colors cursor-pointer"
              title={`View finding: ${label}`}
            >
              {label} →
            </button>
          );
        }

        return (
          <span key={i} className="px-1.5 py-0.5 bg-accent-amber-dim text-accent-amber rounded text-[10px]">
            {label}
          </span>
        );
      })}
    </div>
  );
}

interface PlanArtifactProps {
  artifact: Artifact;
}

interface BranchStep {
  description: string;
  files?: (string | { filePath: string; description?: string; changeType?: string })[];
  reasoning: string;
}

interface PlanStep {
  description: string;
  // Optional per the schema — a step may touch no files (e.g. "run tests").
  files?: (string | { filePath: string; description?: string; changeType?: string })[];
  reasoning: string;
  // D10 (H2) — execution tracking, written by update_plan_progress.
  status?: "pending" | "in_progress" | "done" | "skipped";
  statusNote?: string;
  motivatedBy?: string[];
  preview?: { before: string; after: string; filePath: string };
  condition?: string;
  branches?: BranchStep[];
}

function PlanStepPreview({ step, artifactId, stepIndex }: { step: PlanStep; artifactId: string; stepIndex: number }) {
  const diff = useMemo(() => {
    if (!step.preview?.before || !step.preview?.after) return null;
    return computeLineDiff(step.preview.before, step.preview.after);
  }, [step.preview]);

  if (!step.preview) return null;

  // If we have a diff, show unified view
  if (diff) {
    return (
      <div className="mt-2 font-mono text-[13px] leading-[20px] bg-surface-code rounded overflow-hidden">
        <div className="px-2 py-1 bg-surface-elevated text-[11px] text-text-muted border-b border-border-subtle">
          {step.preview.filePath}
        </div>
        {diff.map((line, i) => (
          <div
            key={i}
            className={`flex ${
              line.type === "removed"
                ? "bg-accent-red-dim/30"
                : line.type === "added"
                  ? "bg-accent-green-dim/30"
                  : ""
            }`}
          >
            <span className={`w-5 shrink-0 text-center py-0.5 select-none text-[11px] font-bold ${
              line.type === "removed" ? "text-accent-red" : line.type === "added" ? "text-accent-green" : "text-text-muted"
            }`}>
              {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
            </span>
            <span className={`px-2 py-0.5 whitespace-pre flex-1 overflow-x-auto ${
              line.type === "removed" ? "text-accent-red line-through opacity-70" : line.type === "added" ? "text-text-primary" : "text-text-secondary"
            }`}>
              {line.content || " "}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Fallback: just show the after code
  return (
    <div className="mt-2">
      <CommentableCode
        code={step.preview.after || step.preview.before}
        lineStart={1}
        filePath={step.preview.filePath}
        artifactId={artifactId}
        targetContext={{ stepIndex }}
      />
    </div>
  );
}

export function PlanArtifact({ artifact }: PlanArtifactProps) {
  // Coercion boundary: `content.steps` is a guaranteed array and
  // `estimatedChanges` a number, so the renderer can trust the shape.
  const content = coercePlanContent(artifact.content);
  // Local PlanStep adds the UI-only condition/branches the coercer preserves.
  const steps = content.steps as unknown as PlanStep[];
  const comments = useArtifactStore((s) => s.comments[artifact.id]) ?? [];
  const updateArtifactStatus = useArtifactStore((s) => s.updateArtifactStatus);

  // Step acceptance state (only editable when draft)
  const [checkedSteps, setCheckedSteps] = useState<boolean[]>(
    () => steps.map(() => true),
  );

  // UX7c — reconcile to steps.length if the same artifact's steps change in
  // place (normally a revision supersedes into a new id + remounts, but an
  // in-place content update would otherwise leave new steps `undefined` →
  // struck-through/skipped). Preserve existing checks; default new steps to on.
  useEffect(() => {
    setCheckedSteps((prev) =>
      prev.length === steps.length ? prev : steps.map((_, i) => prev[i] ?? true),
    );
  }, [steps.length]);

  const toggleStep = (index: number) => {
    if (artifact.status !== "draft") return;
    setCheckedSteps((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  const hasUnchecked = checkedSteps.some((c) => !c);

  // C1 — mirror ArtifactStatusActions.handleAction: a submitting guard (a
  // double-click double-POSTed) and a catch (the store re-throws after
  // toasting; unhandled it surfaced as a console rejection while the button
  // sat there looking untouched).
  const [approvingDeltas, setApprovingDeltas] = useState(false);
  const handleApproveWithDeltas = async () => {
    if (approvingDeltas) return;
    const accepted = checkedSteps.map((c, i) => c ? i : -1).filter((i) => i >= 0);
    const rejected = checkedSteps.map((c, i) => !c ? i : -1).filter((i) => i >= 0);

    const feedbackMsg = hasUnchecked
      ? `Plan approved with modifications: accepted steps [${accepted.join(",")}], removed steps [${rejected.join(",")}]`
      : undefined;

    setApprovingDeltas(true);
    try {
      await updateArtifactStatus(artifact.id, "approved", feedbackMsg);
    } catch {
      // store already toasted; keep the panel usable
    } finally {
      setApprovingDeltas(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Visuals frame the plan — diagrams / file maps / prototypes the human
          can comment on directly. Self-hides when the plan has none. */}
      <ArtifactVisuals artifactId={artifact.id} visuals={content.visuals ?? []} />

      {steps.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Implementation Steps ({steps.length})
            </h4>
            {content.estimatedChanges > 0 && (
              <span className="text-xs text-text-muted">
                ~{content.estimatedChanges} file changes
              </span>
            )}
          </div>

          {/* D10 (H2) — the joint checklist strip. After approval the build
              phase was pure dead air; the agent now marks steps via
              update_plan_progress and this renders live. Only shows once
              ANY step carries a status (old plans stay untracked). */}
          {artifact.status !== "draft" && steps.some((st) => st.status) && (
            <PlanExecutionStrip steps={steps} />
          )}

          {steps.map((step, i) => {
            const stepComments = comments.filter(
              (c) => c.target.stepIndex === i && c.target.lineStart == null,
            );
            return (
              <div
                key={i}
                // X10 — landing target for `dp:focus-artifact` events that
                // carry a step-level anchor. See lib/comment-anchor.ts.
                data-comment-anchor={`step:${i}`}
                className="p-3 bg-surface-secondary rounded-lg border border-white/[0.06] hover:border-white/[0.1] transition-all duration-[180ms] ease-out"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    {/* Checkbox for partial acceptance (only when draft) */}
                    {artifact.status === "draft" ? (
                      <button
                        onClick={() => toggleStep(i)}
                        className={`shrink-0 w-5 h-5 rounded border flex items-center justify-center mt-0.5 transition-colors ${
                          checkedSteps[i]
                            ? "bg-accent-blue border-accent-blue text-white"
                            : "border-border-default bg-surface-elevated text-transparent hover:border-text-muted"
                        }`}
                        title={checkedSteps[i] ? "Uncheck to skip this step" : "Check to include this step"}
                      >
                        {checkedSteps[i] && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 5l2.5 2.5L8 3" />
                          </svg>
                        )}
                      </button>
                    ) : (
                      <StepStatusMarker index={i} status={step.status} />
                    )}
                    <div className={`flex-1 min-w-0 ${!checkedSteps[i] && artifact.status === "draft" ? "opacity-40 line-through" : ""}`}>
                      <p className="text-sm text-text-primary font-medium">
                        {step.description}
                      </p>
                      <p className="text-xs text-text-muted mt-0.5">
                        {step.reasoning}
                      </p>
                      {step.statusNote && (
                        <p className="text-2xs text-accent-amber mt-0.5">{step.statusNote}</p>
                      )}

                      {/* Motivated by badges */}
                      {step.motivatedBy && step.motivatedBy.length > 0 && (
                        <MotivatedByBadges labels={step.motivatedBy} />
                      )}

                      {/* File list — `files` is optional in the schema (a step
                          like "run tests" touches none), so guard the access:
                          an unguarded `step.files.length` throws and crashes the
                          whole plan panel ("Failed to render") for a perfectly
                          valid plan. */}
                      {step.files && step.files.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {step.files.map((f, fIdx) => {
                            const filePath = typeof f === "string" ? f : f.filePath;
                            const desc = typeof f === "string" ? null : f.description;
                            const changeType = typeof f === "string" ? null : f.changeType;
                            const changeIcon = changeType === "create" ? "+" : changeType === "delete" ? "-" : "~";
                            return (
                              <span
                                key={fIdx}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-elevated text-text-secondary rounded text-[11px] font-mono"
                                title={desc ?? undefined}
                              >
                                {changeType && <span className="text-text-muted">{changeIcon}</span>}
                                {filePath}
                                <OpenInEditorLink filePath={filePath} line={1} />
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {/* Before/after preview — unified diff when both exist */}
                      {step.preview && (
                        <PlanStepPreview step={step} artifactId={artifact.id} stepIndex={i} />
                      )}

                      {/* Conditional branches */}
                      {step.condition && step.branches && step.branches.length > 0 && (
                        <div className="mt-2 ml-2 border-l-2 border-accent-amber/40 pl-3 space-y-2">
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 bg-accent-amber-dim text-accent-amber text-2xs font-medium rounded">
                              If
                            </span>
                            <span className="text-xs text-text-secondary">{step.condition}</span>
                          </div>
                          {step.branches.map((branch, bi) => (
                            <div key={bi} className="p-2 bg-surface-elevated/50 rounded border border-white/[0.04]">
                              <p className="text-xs text-text-primary font-medium">{branch.description}</p>
                              <p className="text-2xs text-text-muted mt-0.5">{branch.reasoning}</p>
                              {branch.files && branch.files.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {branch.files.map((f, fi) => {
                                    const fp = typeof f === "string" ? f : f.filePath;
                                    return (
                                      <span key={fi} className="px-1.5 py-0.5 bg-surface-elevated text-text-secondary rounded text-[11px] font-mono">
                                        {fp}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <AskTrigger
                      artifactId={artifact.id}
                      target={{ stepIndex: i }}
                    />
                    <CommentTrigger
                      artifactId={artifact.id}
                      target={{ stepIndex: i }}
                      existingCount={stepComments.length}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Custom approve-with-step-deltas for plans. U3 — this is ADDITIVE: it
          used to REPLACE the whole action footer when any step was unchecked,
          so the human couldn't reject / request revision / respond / ask while
          a step was deselected. Now it sits above the standard actions, which
          always render. */}
      {artifact.status === "draft" && hasUnchecked && (
        <div className="pt-3 border-t border-border-default">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-2xs text-accent-amber">
              {checkedSteps.filter((c) => !c).length} step{checkedSteps.filter((c) => !c).length > 1 ? "s" : ""} will be skipped
            </span>
          </div>
          <button
            onClick={handleApproveWithDeltas}
            disabled={approvingDeltas}
            className="px-3 py-1.5 bg-accent-green text-white text-xs font-medium rounded
                       hover:bg-accent-green/80 disabled:opacity-50 transition-all duration-[180ms] ease-out press-scale"
          >
            {approvingDeltas ? "Approving…" : "Approve with modifications"}
          </button>
        </div>
      )}
      {/* While steps are unchecked, the approve path is "Approve with
          modifications" above — suppress the plain Approve so it can't silently
          approve the plan as-is and discard the deselections. */}
      <ArtifactStatusActions
        artifact={artifact}
        hideApprove={artifact.status === "draft" && hasUnchecked}
      />
    </div>
  );
}

/** D10 (H2) — live "Step 3 of 7" strip; mirrors TriageProgressStrip's shape. */
function PlanExecutionStrip({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const active = steps.findIndex((s) => s.status === "in_progress");
  const pct = steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);
  return (
    <div
      role="group"
      aria-label={`Plan execution: ${done} of ${steps.length} steps complete`}
      className="px-3 py-2 bg-surface-secondary border border-white/[0.06] rounded-lg flex items-center gap-3"
    >
      <span className="text-2xs font-semibold text-text-secondary uppercase tracking-wide shrink-0">
        {done === steps.length ? "Plan complete" : active >= 0 ? `Executing step ${active + 1} of ${steps.length}` : `${done} of ${steps.length} done`}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-surface-elevated overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-green transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-2xs text-text-muted shrink-0">{pct}%</span>
    </div>
  );
}

/** D10 — per-step execution marker (replaces the plain number once tracked). */
function StepStatusMarker({ index, status }: { index: number; status?: PlanStep["status"] }) {
  if (status === "done") {
    return (
      <span className="shrink-0 w-5 h-5 rounded-full bg-accent-green-dim text-accent-green text-xs flex items-center justify-center mt-0.5" title="Done" aria-label={`Step ${index + 1}: done`}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 5l2.5 2.5L8 3" /></svg>
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="shrink-0 w-5 h-5 rounded-full bg-accent-blue-dim text-accent-blue text-xs font-bold flex items-center justify-center mt-0.5 animate-pulse" title="In progress" aria-label={`Step ${index + 1}: in progress`}>
        {index + 1}
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="shrink-0 w-5 h-5 rounded-full bg-surface-elevated text-text-muted text-xs flex items-center justify-center mt-0.5 line-through" title="Skipped" aria-label={`Step ${index + 1}: skipped`}>
        {index + 1}
      </span>
    );
  }
  return (
    <span className="shrink-0 w-5 h-5 rounded-full bg-accent-blue-dim text-accent-blue text-xs font-bold flex items-center justify-center mt-0.5">
      {index + 1}
    </span>
  );
}
