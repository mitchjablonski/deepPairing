/**
 * #589 — spec requirement and edge-path ids are comment-anchor keys
 * (`requirementId`, `spec:edge-path:<id>`), so NEW spec content must declare
 * them unique, non-blank, bounded and unambiguous. REJECT, never rewrite: a
 * silent rename (`-2`, `ep-`, truncation) invents anchor ownership the agent
 * didn't choose and leaves `tasks[].linkedRequirementIds` pointing at ids that
 * no longer exist. The agent fixes its ids and sends the spec again.
 *
 * Applied only to new content (present_spec, revise_artifact supersede) via
 * validatePresentSpecInput. Stored specs are never re-validated or rewritten
 * on read, so legacy anchors (`spec:edge-path:<index>`, existing requirement
 * ids) keep resolving.
 */
import type { ToolErrorResponse } from "./validate-tool-input.js";

export const MAX_SPEC_ID_LENGTH = 64;
const MAX_LISTED_PROBLEMS = 20;

interface SpecIdInput {
  requirements: ReadonlyArray<{ id: string }>;
  edgePaths?: ReadonlyArray<{ id?: string }>;
  tasks?: ReadonlyArray<{ linkedRequirementIds?: readonly string[] }>;
}

function show(id: string): string {
  return JSON.stringify(id.length > 40 ? `${id.slice(0, 40)}…` : id);
}

function checkIds(
  ids: ReadonlyArray<string | undefined>,
  label: string,
  field: string,
  numericIsAmbiguous: boolean,
  problems: string[],
): void {
  const firstAt = new Map<string, number>();
  ids.forEach((id, i) => {
    if (id === undefined) return;
    const at = `${field}[${i}].id`;
    if (id.trim().length === 0) {
      problems.push(`${at} is blank — give the ${label} a short, unique id`);
      return;
    }
    if (id.length > MAX_SPEC_ID_LENGTH) {
      problems.push(`${at} ${show(id)} is ${id.length} chars — rename it to ${MAX_SPEC_ID_LENGTH} or fewer chars; comment threads on that row from earlier versions won't carry over`);
    }
    if (numericIsAmbiguous && /^\d+$/.test(id)) {
      problems.push(`${at} ${show(id)} is purely numeric, which collides with the position-based anchor — rename numeric edge-path id ${show(id)} (e.g. to "ep-${id.slice(0, MAX_SPEC_ID_LENGTH - 3)}"); comment threads on that row from earlier versions won't carry over`);
    }
    const prev = firstAt.get(id);
    if (prev !== undefined) {
      problems.push(`${at} ${show(id)} duplicates ${field}[${prev}].id — rename one of them (every ${label} needs its own id); comment threads on the renamed row from earlier versions won't carry over`);
    } else {
      firstAt.set(id, i);
    }
  });
}

/** Every id problem in new spec content, in input order (empty = valid). */
export function specIdProblems(content: SpecIdInput): string[] {
  const problems: string[] = [];
  checkIds(content.requirements.map((r) => r.id), "requirement", "requirements", false, problems);
  if (content.edgePaths) {
    checkIds(content.edgePaths.map((e) => e.id), "edge path", "edgePaths", true, problems);
  }
  const declared = new Set(content.requirements.map((r) => r.id));
  (content.tasks ?? []).forEach((t, i) => {
    (t.linkedRequirementIds ?? []).forEach((ref, j) => {
      if (!declared.has(ref)) {
        problems.push(`tasks[${i}].linkedRequirementIds[${j}] ${show(ref)} names no requirement in this spec — link an existing requirements[].id or drop it`);
      }
    });
  });
  return problems;
}

/** The refusal for a spec whose ids fail specIdProblems, or null when valid. */
export function specIdError(content: SpecIdInput): ToolErrorResponse | null {
  const problems = specIdProblems(content);
  if (problems.length === 0) return null;
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS);
  const more = problems.length > listed.length ? `\n- …and ${problems.length - listed.length} more` : "";
  return {
    content: [{
      type: "text",
      text:
        `INPUT_VALIDATION_FAILED: spec ids refused — comment threads anchor to these ids, so each must be unique, non-blank, at most ${MAX_SPEC_ID_LENGTH} chars, and (for edge paths) not purely numeric; task links must name a requirement in this spec:\n` +
        `${listed.map((p) => `- ${p}`).join("\n")}${more}\n` +
        `Fix the ids and send the spec again (present_spec, or revise_artifact for a revision). Keep an id that is still valid unchanged so its threads carry over; ids listed above must be renamed, and threads on a renamed id stay on the earlier version (nothing is migrated). The artifact was NOT created.`,
    }],
    isError: true,
    _meta: { code: "INPUT_VALIDATION_FAILED", retryable: true },
  };
}
