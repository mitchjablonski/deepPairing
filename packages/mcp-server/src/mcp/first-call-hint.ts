import type { IStore } from "../store/store-interface.js";
import { getGlobalStore } from "../store/global-store.js";

/**
 * X4 — first-call hint builder, lifted out of server.ts so the CallTool
 * handler reads as routing, not 300 lines of context assembly.
 *
 * Two tiers:
 * - BLOCKING: unresolved obligations the agent MUST act on this turn
 *   (revision requests, unanswered questions, follow-up replies, plain
 *   artifact comments needing a mirror). Always included, top of hint,
 *   never truncated.
 * - CONTEXTUAL: accumulating signals (rejected approaches, approved
 *   patterns, project guardrails, team prefs, ledger stats, plugin tip).
 *   Capped at HINT_BUDGET_CHARS so the hint never grows into a wall of
 *   text the LLM tunes out. When capacity runs out, drop tail-first and
 *   emit a "more context: call recall" pointer so the agent knows what
 *   was elided and how to fetch it.
 *
 * Pure inputs/output: takes a store + port, returns the rendered hint
 * string. No closure references back into server.ts.
 */
const HINT_BUDGET_CHARS = 1500;

export async function buildFirstCallHint(store: IStore, port: number): Promise<string> {
  const blockingParts: string[] = [];
  const contextualParts: string[] = [];
  const headerLine =
    `[First use this session] The companion UI is at http://localhost:${port} — the human can review artifacts, comment, and make decisions there.`;

  const memory = await store.getSessionMemory();
  const memoryParts: string[] = [];
  if (memory.rejectedApproaches.length > 0) {
    memoryParts.push(
      `Rejected approaches (NEVER propose these — present_* tools will refuse):\n${memory.rejectedApproaches
        .map((a) => `  - ${a.description}${a.reason ? ` — reason: ${a.reason}` : ""}`)
        .join("\n")}`,
    );
  }
  if (memory.approvedPatterns.length > 0) {
    memoryParts.push(
      `Approved patterns (prefer these):\n${memory.approvedPatterns.map((a) => `  - ${a}`).join("\n")}`,
    );
  }
  if (memoryParts.length > 0) {
    contextualParts.push(`\n📋 From previous sessions in this project:\n${memoryParts.join("\n")}`);
  }

  // J6 — codebase-sensed guardrails. Filesystem signals tell us which
  // paths are sensitive (migrations, CI workflows, infra). The agent gets
  // this list on first call so it knows to stay supervised for changes
  // in those paths even when autonomy is "autonomous".
  try {
    // AA7b — typed optional method (was a (store as any) cast pre-AA7).
    const guardrails = await store.getProjectGuardrails?.();
    if (Array.isArray(guardrails) && guardrails.length > 0) {
      const lines = guardrails.map((g: any) =>
        `  - ${g.category} (${(g.paths ?? []).join(", ")}): ${g.rationale}`,
      );
      contextualParts.push(
        `\n🛡 Project guardrails (escalate to supervised for changes in these paths, even when autonomy is 'autonomous'):\n${lines.join("\n")}`,
      );
    }
  } catch {
    // Non-fatal — we just won't surface guardrails
  }

  // N6.3 — team conventions from .deeppairing/team.json. Kept in a
  // distinct section from personal philosophy and structural guardrails
  // (NEVER merged — they're different kinds of authority).
  try {
    // AA7b — typed optional method.
    const prefs = await store.getTeamPreferences?.();
    if (Array.isArray(prefs) && prefs.length > 0) {
      const render = (p: any) => {
        const scope = p.scope?.paths?.length
          ? ` (scope: ${p.scope.paths.join(", ")})`
          : "";
        return `  - "${p.concept}"${scope} — ${p.rationale}`;
      };
      const required = prefs.filter((p: any) => p.kind === "require").map(render);
      const avoided = prefs.filter((p: any) => p.kind === "avoid").map(render);
      const preferred = prefs.filter((p: any) => p.kind === "prefer").map(render);
      const sections: string[] = [];
      if (required.length) sections.push(`Required:\n${required.join("\n")}`);
      if (avoided.length) sections.push(`Avoid:\n${avoided.join("\n")}`);
      if (preferred.length) sections.push(`Preferred:\n${preferred.join("\n")}`);
      if (sections.length > 0) {
        contextualParts.push(
          `\n🏢 Team conventions (from .deeppairing/team.json — treat 'require' as hard rules, 'avoid' as refusal triggers, 'prefer' as taste):\n${sections.join("\n")}`,
        );
      }
    }
  } catch {
    // Non-fatal — team prefs are advisory; keep polling shape intact.
  }

  // J4 — cross-project philosophy kickoff brief.
  try {
    const avoidList = getGlobalStore().query({ stance: "avoid", limit: 3 });
    const preferList = getGlobalStore().query({ stance: "prefer", limit: 3 });
    const philosophyParts: string[] = [];
    if (avoidList.length > 0) {
      philosophyParts.push(
        `Strong 'avoid' stances (multi-project):\n${avoidList
          .map((e) => {
            const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
            const projects = new Set(e.instances.map((i) => i.project)).size;
            return `  - "${e.concept}"${latestReason ? ` — "${latestReason}"` : ""}${projects > 1 ? ` (${projects} projects)` : ""}`;
          })
          .join("\n")}`,
      );
    }
    if (preferList.length > 0) {
      philosophyParts.push(
        `Patterns the user prefers:\n${preferList
          .map((e) => {
            const projects = new Set(e.instances.map((i) => i.project)).size;
            return `  - "${e.concept}"${projects > 1 ? ` (${projects} projects)` : ""}`;
          })
          .join("\n")}`,
      );
    }
    if (philosophyParts.length > 0) {
      contextualParts.push(
        `\n🧭 Cross-project philosophy ledger (use recall with mode='philosophy' for more):\n${philosophyParts.join("\n")}`,
      );
    }
  } catch {
    // Ledger read failure is non-fatal — we still have session-scoped memory.
  }

  // R2 — "moat made measurable" welcome-back line. Silent below 5 concepts.
  try {
    const ledgerEntries = getGlobalStore().query({ limit: 10000 });
    if (ledgerEntries.length >= 5) {
      const projects = new Set<string>();
      for (const e of ledgerEntries) {
        for (const inst of e.instances) projects.add(inst.project);
      }
      const avoidCount = ledgerEntries.filter((e) => e.stance === "avoid").length;
      const preferCount = ledgerEntries.filter((e) => e.stance === "prefer").length;

      let localBlocks = 0;
      let localSessions = 0;
      try {
        const fsMod = await import("node:fs");
        const pathMod = await import("node:path");
        const metricsPath = pathMod.join(process.cwd(), ".deeppairing", "metrics.json");
        if (fsMod.existsSync(metricsPath)) {
          const m = JSON.parse(fsMod.readFileSync(metricsPath, "utf-8"));
          if (m?.version === 1) {
            localBlocks = m.counts?.preflightBlocks?.total ?? 0;
            localSessions = m.sessions ?? 0;
          }
        }
      } catch {}

      const parts = [
        `${ledgerEntries.length} concept${ledgerEntries.length === 1 ? "" : "s"}`,
        `${avoidCount} avoid / ${preferCount} prefer`,
        `${projects.size} project${projects.size === 1 ? "" : "s"}`,
      ];
      if (localBlocks > 0) parts.push(`${localBlocks} block${localBlocks === 1 ? "" : "s"} fired here`);
      if (localSessions > 0) parts.push(`session #${localSessions + 1} in this project`);
      contextualParts.push(`\n🌱 Your deepPairing ledger: ${parts.join(" · ")}.`);
    }
  } catch {
    // Non-fatal — welcome-back line is cosmetic.
  }

  // Q4 — surface unanswered questions, revision requests, follow-up replies,
  // plain comments needing a mirror. All BLOCKING priority — they need
  // action this turn.
  try {
    const fullState = await store.getFullState();
    const allComments = fullState.comments ?? [];
    const unanswered = allComments.filter(
      (c: any) => c.author === "human" && c.intent === "question" && !c.answeredByCommentId,
    );
    const revisionRequested = unanswered.filter(
      (c: any) => typeof c.target?.sectionId === "string" && c.target.sectionId.startsWith("decision_revision_requested"),
    );
    const plainUnanswered = unanswered.filter((c: any) => !revisionRequested.includes(c));
    if (revisionRequested.length > 0) {
      const lines = revisionRequested.map((c: any) => {
        const aId = c.target?.artifactId ?? "(unknown)";
        const excerpt = String(c.content ?? "").slice(0, 120);
        return `  • Decision ${aId} — comment ${c.id}: "${excerpt}"`;
      });
      blockingParts.push(
        `\n🔁 ${revisionRequested.length} REVISION REQUEST${revisionRequested.length === 1 ? "" : "S"} on decisions. The human wants the OPTIONS REVISED, not just an answer:\n${lines.join("\n")}\n` +
        `Required response per request: call \`revise_artifact\` mode="supersede" on the decision artifact with a NEW option set incorporating the feedback. Then briefly call \`answer_question\` on the comment so the rail shows "↻ Revised". Do NOT just call answer_question and leave the original options on the table.`,
      );
    }
    if (plainUnanswered.length > 0) {
      blockingParts.push(
        `\n❓ ${plainUnanswered.length} unanswered question${plainUnanswered.length === 1 ? "" : "s"} from the human. Call check_feedback to read them, then reply with answer_question (not a plain comment) so the UI links the answer to the question.`,
      );
    }

    const agentCommentIds = new Set(
      allComments.filter((c: any) => c.author === "agent").map((c: any) => c.id),
    );
    const followUps = allComments.filter(
      (c: any) =>
        c.author === "human" &&
        c.parentCommentId &&
        agentCommentIds.has(c.parentCommentId) &&
        !c.answeredByCommentId,
    );
    if (followUps.length > 0) {
      const lines = followUps.map((c: any) => {
        const aId = c.target?.artifactId ?? "(unknown)";
        const excerpt = String(c.content ?? "").slice(0, 100);
        return `  • Reply ${c.id} on artifact ${aId} (parent ${c.parentCommentId}): "${excerpt}"`;
      });
      blockingParts.push(
        `\n↳ ${followUps.length} follow-up repl${followUps.length === 1 ? "y" : "ies"} in active thread${followUps.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n` +
        `Each is a continuation of an existing thread (parentCommentId points at one of your previous replies). Call \`answer_question\` AGAIN with the reply's id as commentId to keep the thread going. Do NOT post a new top-level comment.`,
      );
    }

    const followUpIds = new Set(followUps.map((c: any) => c.id));
    const plainCommentsNeedingMirror = allComments.filter(
      (c: any) =>
        c.author === "human" &&
        c.intent !== "question" &&
        !c.answeredByCommentId &&
        !followUpIds.has(c.id) &&
        c.target?.artifactId &&
        c.target.artifactId !== "__session__",
    );
    if (plainCommentsNeedingMirror.length > 0) {
      blockingParts.push(
        `\n💬 ${plainCommentsNeedingMirror.length} human comment${plainCommentsNeedingMirror.length === 1 ? "" : "s"} on artifacts without an agent reply. Mirror substantive replies via answer_question so the response shows under the comment in the UI; chat-only replies are invisible to the conversation rail.`,
      );
    }
  } catch {
    // Non-fatal — agent will catch them on the next check_feedback anyway.
  }

  // N2.2 — plugin-install nudge: only when CLAUDE.md exists but lacks the
  // deepPairing marker. CLAUDE.md mutation stays opt-in.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const claudeMd = path.join(process.cwd(), "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      const content = fs.readFileSync(claudeMd, "utf-8");
      if (!content.includes("<!-- deepPairing -->")) {
        contextualParts.push(
          "\n💡 Tip: run `npx deeppairing init` to add the deepPairing protocol to CLAUDE.md so the agent follows it on every session (optional — the plugin's pairing-protocol skill covers most of this already).",
        );
      }
    }
  } catch {
    // Non-fatal.
  }

  // X3 — assemble: header + ALL blocking signals + capped contextual signals.
  const assembled: string[] = [headerLine, ...blockingParts];
  let droppedContextual = 0;
  const baselineLen = assembled.join("\n").length;
  let runningLen = baselineLen;
  for (const part of contextualParts) {
    if (runningLen + part.length + 1 <= HINT_BUDGET_CHARS) {
      assembled.push(part);
      runningLen += part.length + 1;
    } else {
      droppedContextual++;
    }
  }
  if (droppedContextual > 0) {
    assembled.push(
      `\n📦 ${droppedContextual} additional context section${droppedContextual === 1 ? "" : "s"} omitted to keep this hint focused (rejected approaches, team prefs, ledger stats, etc). Call \`recall\` with mode='philosophy' or mode='sessions' to pull what you need.`,
    );
  }
  return `\n${assembled.join("\n")}`;
}
