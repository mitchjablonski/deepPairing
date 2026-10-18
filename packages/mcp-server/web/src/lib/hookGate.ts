/**
 * #544 — the words for a PreToolUse hook firing (a raw Edit or Write that
 * matched one of your stances or a guarded file).
 *
 * Claude Code's own permission prompt doesn't show the hook's reason (upstream
 * anthropics/claude-code#102892), so the companion is the only place you can
 * see WHY it is asking. These lines are written for that moment: second
 * person, what Claude is trying to do, which stance it matches, what you said,
 * and where to answer.
 */

export interface HookGateFacts {
  decision?: "ask" | "deny";
  source: "session" | "team";
  /** Set only when a guarded file fired and no stance did. */
  guardrail?: string;
  toolName?: string;
  targetPath?: string;
  concept: string;
  reason?: string;
  addedBy?: string;
  /** #553 — set when a worker subagent made the call, not the main agent. */
  agentId?: string;
  agentType?: string;
}

export interface HookGateCopy {
  title: string;
  /** #553 — "Subagent: <type>" when a worker subagent made the call. */
  subagent?: string;
  match: string;
  said?: string;
  next: string;
  /** One sentence for the screen-reader announcer. */
  announcement: string;
}

function verb(toolName: string | undefined): string {
  return toolName === "Write" ? "write" : "edit";
}

/** #553 — how a worker subagent is named: its agent type when Claude Code
 *  sent one, else just "a subagent". Undefined for the main agent. */
function subagentName(f: HookGateFacts): string | undefined {
  if (f.agentType) return `the ${f.agentType} subagent`;
  return f.agentId ? "a subagent" : undefined;
}

export function hookGateCopy(f: HookGateFacts): HookGateCopy {
  const target = f.targetPath ? `\`${f.targetPath}\`` : "a file";
  const deny = f.decision === "deny";
  const worker = subagentName(f);
  const change = f.toolName === "Write" ? "a write" : "an edit";
  const title = deny
    ? `Claude Code stopped ${change} to ${target}${worker ? ` by ${worker}` : ""}`
    : worker
      ? `Claude Code is asking whether ${worker} may ${verb(f.toolName)} ${target}`
      : `Claude Code is asking to ${verb(f.toolName)} ${target}`;
  // `guardrail` is set only when a guarded file fired and no stance did.
  const isGuard = !!f.guardrail;
  const match = isGuard
    ? `This file is on deepPairing's guarded list: ${f.concept}.`
    : f.source === "team"
      ? `This matches your team's rule '${f.concept}'${f.addedBy ? ` (added by ${f.addedBy})` : ""}.`
      : `This matches your stance '${f.concept}'.`;
  const said = f.reason
    ? isGuard
      ? f.reason
      : f.source === "team"
        ? `Your team's reason: '${f.reason}'`
        : `You said: '${f.reason}'`
    : undefined;
  const next = deny
    ? worker
      ? "Nothing was written. The subagent was told to cancel or revise, and the lead agent isn't told it was stopped: if its work depends on this file, tell the lead."
      : "Nothing was written. Claude was told to cancel or revise."
    : `The terminal prompt won't show this. Allow it there to let this one change through, or deny it to ${isGuard ? "leave the file alone" : f.source === "team" ? "keep the team rule" : "keep your stance"}.`;
  const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const announcement = [title, match, said, deny ? "Nothing was written." : "The terminal prompt won't show this."]
    .filter((t): t is string => !!t)
    .map((t) => sentence(t.replace(/`/g, "")))
    .join(" ");
  const subagent = worker ? `Subagent: ${f.agentType ?? "unnamed"}` : undefined;
  return { title, ...(subagent ? { subagent } : {}), match, ...(said ? { said } : {}), next, announcement };
}
