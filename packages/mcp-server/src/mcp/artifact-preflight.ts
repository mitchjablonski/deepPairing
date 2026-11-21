import type { ToolContext } from "./tools/types.js";
import type { PreflightOpts } from "./tool-helpers.js";
import { extractPageTextBlocks } from "./page-text.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (values: unknown[]): string[] => values
  .filter((v): v is string => typeof v === "string")
  .map((v) => v.trim())
  .filter((v) => v.length > 0);
const field = (values: unknown, key: string): unknown[] => list(values).map(v => record(v)[key]);

/** One proposal projection for both initial presentation and replacement versions. */
export function artifactProposal(type: string, title: string, value: unknown) {
  const c = record(value);
  let text: unknown[] = [];
  let paths: unknown[] = [];
  let concepts: unknown[] = [];
  switch (type) {
    case "research":
      text = [title, c.summary, ...field(c.findings, "title"), ...field(c.findings, "recommendation")];
      paths = list(c.findings).flatMap(f => field(record(f).evidence, "filePath"));
      break;
    case "decision":
      text = [c.context, ...field(c.options, "title"), ...field(c.options, "description")];
      concepts = field(c.options, "concept").map(v => record(v).name);
      break;
    case "spec":
      text = [title, c.objective, ...field(c.requirements, "statement"), ...field(c.requirements, "rationale"), ...field(c.tasks, "description")];
      break;
    case "plan":
      paths = list(c.steps).flatMap(s => list(record(s).files).map(f => typeof f === "string" ? f : record(f).filePath));
      text = [title, ...field(c.steps, "description"), ...field(c.steps, "reasoning"), ...paths];
      break;
    case "code_change":
      text = [c.filePath, c.reasoning];
      paths = [c.filePath];
      concepts = [record(c.concept).name];
      break;
    case "changeset":
      text = [title, c.summary, ...list(c.risks)];
      paths = field(c.files, "path");
      break;
    case "debrief":
      text = [title, c.summary, ...field(c.sections, "title"), ...field(c.decisionsMade, "what")];
      concepts = list(c.sections).flatMap(s => field(record(s).concepts, "name"));
      break;
    case "explainer":
      text = [title, c.overview, ...field(c.sections, "heading")];
      break;
    case "page":
      // #680 — the page's VISIBLE text, one string per block (page-text.ts).
      // Every block is checked forward (a stance found IN the block blocks,
      // so a lone `<th>Railway</th>` still counts). The reverse lane — a short
      // block found inside a stance — is tightened via `rawEditText` below,
      // so a lone cell or heading ("None", "Overview") can't match backwards
      // inside any stance that merely uses that word.
      text = [
        title,
        c.summary,
        ...(typeof c.html === "string" ? extractPageTextBlocks(c.html) : []),
      ];
      concepts = [record(c.concept).name];
      break;
    default:
      return null;
  }
  return {
    text: strings(text),
    paths: strings(paths),
    concepts: strings(concepts),
    // A debrief reports what already happened; it is not a fresh proposal.
    // Recalled rejections still surface as advice, but cannot prevent the
    // historical record from naming the rejected path.
    advisory: type === "debrief" || (type === "changeset" && c.reviewIntent === "external"),
    // #680 — page text is free prose, not a named proposal: reuse the matcher's
    // #621 raw-text rule (reverse phrase match needs real stance coverage).
    ...(type === "page" ? { rawEditText: true } : {}),
  };
}

export function preflightArtifact(ctx: ToolContext, toolName: string, type: string, title: string, content: unknown, opts: Omit<PreflightOpts, "advisory"> = {}) {
  const proposal = artifactProposal(type, title, content);
  return proposal
    ? ctx.helpers.preflightRejectedApproaches(toolName, proposal.text, proposal.paths, proposal.concepts, {
      ...opts,
      advisory: proposal.advisory,
      ...(proposal.rawEditText ? { rawEditText: true } : {}),
    })
    : null;
}
