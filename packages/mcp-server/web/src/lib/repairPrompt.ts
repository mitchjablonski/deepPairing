/**
 * Builds a structured "re-pair" prompt for a past decision.
 *
 * Motivation: deepPairing doesn't drive Claude Code — we're an MCP server it
 * calls. True branching would require re-driving the agent through the session.
 * Instead, this generates a prompt the developer can paste into a fresh Claude
 * Code conversation to revisit a past decision with clean context.
 *
 * Pure function — no IO, no React. Easy to unit-test and trivially reused from
 * the modal UI or a future MCP tool.
 */

export interface RepairPromptInput {
  sessionId: string;
  decisionContext: string;
  options: Array<{
    id: string;
    title: string;
    description?: string;
    pros?: string[];
    cons?: string[];
    recommendation?: boolean;
  }>;
  chosenOptionId: string;
  chosenReasoning?: string;
  resolvedAt?: string;
  /** Why are we reconsidering? Filled in by the developer in the modal. */
  userNote?: string;
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const chosen = input.options.find((o) => o.id === input.chosenOptionId);
  const rejected = input.options.filter((o) => o.id !== input.chosenOptionId);

  const lines: string[] = [];
  lines.push(`# Re-pair: reconsider "${input.decisionContext}"`);
  lines.push("");
  lines.push(`I'd like to revisit a decision from a past deepPairing session (${input.sessionId}${input.resolvedAt ? ` on ${formatDate(input.resolvedAt)}` : ""}).`);
  lines.push("");
  if (input.userNote?.trim()) {
    lines.push(`**Why I'm reconsidering:** ${input.userNote.trim()}`);
    lines.push("");
  }

  lines.push(`## Original decision`);
  lines.push("");
  lines.push(`**Question:** ${input.decisionContext}`);
  lines.push("");
  lines.push(`**Options we considered:**`);
  for (const opt of input.options) {
    const star = opt.recommendation ? " ⭐" : "";
    const bullet = opt.id === input.chosenOptionId ? "✅" : "❌";
    lines.push(`- ${bullet} **${opt.title}**${star}`);
    if (opt.description) lines.push(`    ${opt.description}`);
    if (opt.pros?.length) lines.push(`    + ${opt.pros.join("; ")}`);
    if (opt.cons?.length) lines.push(`    − ${opt.cons.join("; ")}`);
  }
  lines.push("");

  if (chosen) {
    lines.push(`**What I picked:** ${chosen.title}`);
    if (input.chosenReasoning?.trim()) {
      lines.push(`**My reasoning at the time:** ${input.chosenReasoning.trim()}`);
    }
    lines.push("");
  }

  if (rejected.length > 0) {
    lines.push(`**What I rejected:** ${rejected.map((r) => r.title).join(", ")}`);
    lines.push("");
  }

  lines.push(`## What I need from you`);
  lines.push("");
  lines.push(`Walk through this decision with fresh eyes. Is there anything I missed? Would you still pick the same option, or has something changed that should lead us elsewhere?`);
  lines.push("");
  lines.push(`Use the deepPairing MCP tools (present_findings, present_options, present_plan) as you normally would. Don't assume the previous decision still holds — I want a genuine re-evaluation.`);
  lines.push("");

  return lines.join("\n");
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}
