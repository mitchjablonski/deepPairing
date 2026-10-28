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

/** Skeleton plans (parity PR 4) — the step ids a `skeleton-scope` firing
 *  names in its concept ("Skeleton fence SKEL[2], SKEL[3]"). */
function skeletonSteps(concept: string): string[] {
  const out: string[] = [];
  const re = /SKEL\[([^\]]+)\]/g;
  for (let m = re.exec(concept); m; m = re.exec(concept)) out.push(m[1]!);
  return out;
}

/**
 * Skeleton plans (parity PR 4) — a fence firing is not a guarded file: Claude
 * is filling an approved skeleton and this edit falls outside the step it is
 * on. Plain and specific: which step, which file, what allowing it means, and
 * that the answer goes in the terminal (whose dialog can't show this reason,
 * upstream #102892).
 */
function skeletonGateCopy(f: HookGateFacts): HookGateCopy {
  const steps = skeletonSteps(f.concept);
  const stepText = steps.length === 0 ? "the current step" : steps.length === 1 ? `step SKEL[${steps[0]}]` : `steps ${steps.map((s) => `SKEL[${s}]`).join(", ")}`;
  const file = f.targetPath ? ` (\`${f.targetPath}\`)` : "";
  const worker = subagentName(f);
  const deny = f.decision === "deny";
  const title = deny
    ? `Stopped: ${verb(f.toolName)} outside ${stepText} would change the approved skeleton${file}`
    : `${f.toolName === "Write" ? "Write" : "Edit"} outside ${stepText}: this changes the approved skeleton${file}`;
  const match = `${worker ? `${worker[0]!.toUpperCase()}${worker.slice(1)} is` : "Claude is"} filling ${stepText} of the skeleton you approved, and this ${verb(f.toolName)} falls outside that step's fence. A new helper, a changed signature or a new file is a skeleton change.`;
  const next = deny
    ? "Nothing was written. Claude was told to propose the change instead."
    : "Answer in the terminal: its prompt won't show this reason. Deny to keep Claude inside the fence (it should propose the change and revise the plan). Allow only if you agree to change the skeleton's structure.";
  const announcement = [title.replace(/`/g, ""), match, deny ? "Nothing was written." : "Answer in the terminal."]
    .map((t) => (/[.!?]$/.test(t) ? t : `${t}.`))
    .join(" ");
  const subagent = worker ? `Subagent: ${f.agentType ?? "unnamed"}` : undefined;
  return { title, ...(subagent ? { subagent } : {}), match, next, announcement };
}

export function hookGateCopy(f: HookGateFacts): HookGateCopy {
  if (f.guardrail === "skeleton-scope") return skeletonGateCopy(f);
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
      ? "Nothing was written. The subagent was told to cancel or revise. The lead agent learns it was stopped on its next check_feedback, unless this happened while no deepPairing daemon was running: then, if its work depends on this file, tell the lead."
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
