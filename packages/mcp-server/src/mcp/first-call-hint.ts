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
// EE1 — dedicated cap for the user-policy tier (seeds). Pre-EE1, seeds
// were appended to blockingParts which was concatenated unconditionally,
// blowing past HINT_BUDGET_CHARS for a vanilla session and outranking
// real this-turn obligations. Cap policy at this many chars so an 8-seed
// list can't push Q4 follow-ups out of mind.
const POLICY_BUDGET_CHARS = 600;

// The pairing-protocol preamble. Always-on orientation so consuming projects
// that wire ONLY the MCP server (no pairing-protocol skill, no
// `npx deeppairing init`) still get the choreography — the happy-path sequence
// plus the two rules that keep the dialogue in the companion UI. It's
// fixed-size and essential, so it rides in the uncapped prefix and is NOT
// charged against the contextual budget below. Faithful to SKILL.md.
const PROTOCOL_PREAMBLE = [
  "[deepPairing protocol] You're pairing — route findings/options/plans/answers through the MCP tools into the companion UI as artifacts, never as plain terminal text.",
  "Voice: write TO your pair in second person (\"Here are two options — which fits your constraints?\"), not ABOUT them (\"User asked how to handle X.\"). Artifacts are a conversation, not an audit log.",
  "Happy path, in order:",
  "  1. recall (mode='any') — check prior stances/decisions before proposing.",
  "  2. present_findings — after researching; structured Evidence (filePath, lineStart, lineEnd, snippet). Not plain-text bullets.",
  "  3. check_feedback — poll in a loop (~30s each; on WAITING, call again). Don't stop to ask in the terminal.",
  "  4. present_options — at a fork with 2-4 approaches; stakes='high' for hard-to-reverse calls (schema/auth/infra).",
  "  5. present_spec, then present_plan — for non-trivial features (spec before the multi-file plan).",
  "  6. present_code_change BEFORE every Write/Edit — EVERY change, incl. small follow-ons, new files, and each file of a multi-file change (5 edits = 5 calls). A write straight to disk never reaches the human's review surface. + log_reasoning (name the concept).",
  "  7. check_feedback again — let your pair review each artifact in the UI.",
  "Pull the full protocol from the deeppairing://onboarding resource. present_* refuse proposals matching a past rejected approach.",
].join("\n");

export async function buildFirstCallHint(store: IStore, port: number): Promise<string> {
  // EE1 — three-tier ordering for assembly:
  //   1. obligationsParts: real this-turn obligations (Q4 follow-ups,
  //      plain comments needing mirror, decision revisions). Uncapped —
  //      the agent must address these or feedback breaks.
  //   2. policyParts: user-policy declarations (seeds). Capped at
  //      POLICY_BUDGET_CHARS. High priority but not unlimited.
  //   3. contextualParts: advisory signals (memory, guardrails, team
  //      prefs, philosophy, R2). Capped against the remaining budget.
  // The pre-EE1 single `blockingParts` bucket let seeds crowd out
  // unanswered human questions — exactly the wrong priority order.
  const obligationsParts: string[] = [];
  const policyParts: string[] = [];
  const contextualParts: string[] = [];
  // Back-compat alias — old code paths still push into blockingParts; we
  // route those into obligations at the bottom of the function. Kept as
  // a const so existing pushes type-check unchanged.
  const blockingParts: string[] = obligationsParts;
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
      // FF5 + GG4 — split team prefs across tiers. 'require' and 'avoid'
      // are hard rules with refusal/coercion semantics; FF5 promoted
      // them to obligationsParts (uncapped) so they couldn't get
      // dropped behind contextual budget. GG4 caps the team-rules
      // section itself: a 50-rule team.json was dumping ~6KB of
      // unconditional context into every first-call hint, dwarfing the
      // 1500-char total budget. Page rules into TEAM_RULES_BUDGET_CHARS
      // and emit a "📦 N more — see .deeppairing/team.json" trailer.
      const TEAM_RULES_BUDGET_CHARS = 600;
      const hardLines: string[] = [];
      // Section labels first so they're guaranteed visible if any rules
      // fit at all.
      if (required.length) {
        hardLines.push("Required:");
        for (const r of required) hardLines.push(r);
      }
      if (avoided.length) {
        if (hardLines.length > 0) hardLines.push("");
        hardLines.push("Avoid:");
        for (const a of avoided) hardLines.push(a);
      }
      if (hardLines.length > 0) {
        const header =
          "\n🚫 Team rules (from .deeppairing/team.json — hard — 'require' as imperatives, 'avoid' as refusal triggers):";
        let used = header.length;
        const visible: string[] = [header];
        let droppedRuleLines = 0;
        // HH6 — truncation marker. Pre-HH6 a single oversize rule
        // (>~460 chars after the section header took its share of the
        // 600 budget) was dropped entirely — agent saw "🚫 Team rules"
        // + "Required:" + "📦 1 more rule line" with NO actual rule
        // body. Wrong failure mode for a hard rule the agent must
        // observe. Now we truncate any line that would otherwise be
        // dropped, preserving the imperative + tagging it so the
        // agent knows to fetch the full text from team.json.
        const TRUNC_MARKER = " …[truncated; full rule in .deeppairing/team.json]";
        for (const line of hardLines) {
          if (used + line.length + 1 <= TEAM_RULES_BUDGET_CHARS) {
            visible.push(line);
            used += line.length + 1;
            continue;
          }
          // Doesn't fit. Try to truncate to fit + the marker.
          const remaining = TEAM_RULES_BUDGET_CHARS - used - 1 - TRUNC_MARKER.length;
          if (remaining > 60) {
            // Enough room for a meaningful prefix.
            visible.push(line.slice(0, remaining) + TRUNC_MARKER);
            used += remaining + TRUNC_MARKER.length + 1;
          } else {
            droppedRuleLines++;
          }
        }
        if (droppedRuleLines > 0) {
          visible.push(
            `  📦 ${droppedRuleLines} more rule line${droppedRuleLines === 1 ? "" : "s"} — see .deeppairing/team.json for the full list.`,
          );
        }
        obligationsParts.push(visible.join("\n"));
      }
      if (preferred.length > 0) {
        // GG9 — disambiguating glyph: 💡 for soft/taste vs 🚫 for hard
        // rules above. Pre-GG9 both sections led with 🏢 and were
        // visually one block split mid-stream.
        contextualParts.push(
          `\n💡 Team preferences (from .deeppairing/team.json — soft — taste, weigh against the user's goal):\nPreferred:\n${preferred.join("\n")}`,
        );
      }
    }
  } catch {
    // Non-fatal — team prefs are advisory; keep polling shape intact.
  }

  // J4 — cross-project philosophy kickoff brief.
  // FF10 — hoist ONE getGlobalStore().query({ limit: 10000 }) for the
  // entire philosophy + R2 region. Pre-FF10 the same in-memory ledger
  // was queried 5 times: avoid (limit 3), prefer (limit 3), seeded
  // (limit 200), totalConcepts (limit 10000), and R2 ledgerEntries
  // (limit 10000). All derive from the same data — one walk + JS
  // filters is cheaper and clearer.
  type LedgerEntry = ReturnType<ReturnType<typeof getGlobalStore>["query"]>[number];
  let allLedgerEntries: LedgerEntry[] = [];
  // GG3 — load the ledger in its OWN try so a downstream philosophy/seed
  // assembly throw doesn't strand allLedgerEntries empty (which would
  // silence R2 below). Pre-GG3 the FF10 hoist put the load + assembly
  // in one try-catch; any future bad-instance crash inside seeded
  // mapping silently killed the welcome-back line too.
  try {
    allLedgerEntries = getGlobalStore().query({ limit: 10000 });
  } catch {
    // Ledger read failure — both philosophy and R2 will skip cleanly.
  }
  try {
    const avoidList = allLedgerEntries.filter((e) => e.stance === "avoid").slice(0, 3);
    const preferList = allLedgerEntries.filter((e) => e.stance === "prefer").slice(0, 3);
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

    // DD3 — surface user-seeded stances explicitly. Pre-DD3 the
    // philosophy block silently included project="manual" entries as
    // anonymous low-citation rows that lost the truncation lottery
    // first. A fresh project where the user pasted rules into the
    // SeedAffordance got NO acknowledgement in the hint; the agent
    // never learned the SEED affordance existed unless it
    // independently called recall(mode='ledger'). Now we extract
    // seeded entries and route them through blockingParts — they
    // are direct user-policy declarations, not advisory cross-project
    // signal. Cap at 8 so the budget doesn't get blown by a 50-line
    // CLAUDE.md paste.
    // FF10 — derive seeded from the hoisted allLedgerEntries instead
    // of a separate query. Re-introduces the inline filter EE5
    // factored out, but it's a derived view here (one fold) — not the
    // public query API.
    const seeded = allLedgerEntries.filter((e) =>
      e.instances.some((i) => i.project === "manual"),
    );
    if (seeded.length > 0) {
      // EE1 — push the section header + each seed line as separate
      // policyParts elements so the cap pages cleanly. Pre-EE1 the
      // entire block was a single ~1200-char string that the policy
      // budget either accepted whole or dropped whole. Now: 1 header
      // + N lines (capped at 8 visible; "…N more" trailer if there
      // are extras), and the 600-char policy cap can include the
      // header + as many lines as fit. Anything over → 📦 nudge to
      // recall mode='philosophy' source='user-seeded'.
      policyParts.push(
        "\n🌱 The user explicitly seeded these stances — treat them as direct policy:",
      );
      const visible = seeded.slice(0, 8);
      for (const e of visible) {
        const elsewhereCount = e.instances.filter((i) => i.project !== "manual").length;
        const elsewhere = elsewhereCount > 0 ? ` (also fired ${elsewhereCount}× in real sessions)` : "";
        policyParts.push(`  - [SEED] [${e.stance.toUpperCase()}] "${e.concept}"${elsewhere}`);
      }
      if (seeded.length > 8) {
        policyParts.push(`  …${seeded.length - 8} more seeded stances (recall mode='ledger' for the full list).`);
      }
      // EE6 — when the R2 welcome-back line WON'T fire (ledger has
      // fewer than 5 concepts total), append the recall pointer here
      // so a fresh project with seeds still tells the agent how to
      // pull the full digest. Pre-EE6 the agent saw the SEED block
      // but had no on-ramp to mode='ledger' until session ≥ 5.
      // FF10 — totalConcepts comes from the hoisted query, no new fetch.
      if (allLedgerEntries.length < 5) {
        policyParts.push(
          "  Call recall mode='ledger' for the full digest, or mode='philosophy' source='user-seeded' to query just these.",
        );
      }
    }
  } catch {
    // Ledger read failure is non-fatal — we still have session-scoped memory.
  }

  // R2 — "moat made measurable" welcome-back line. Silent below 5 concepts.
  // FF10 — reuse the hoisted allLedgerEntries from the philosophy block
  // above. If the philosophy try-block threw and left allLedgerEntries
  // empty, R2 silently no-ops (right behavior — without ledger data the
  // welcome line has nothing to say).
  try {
    const ledgerEntries = allLedgerEntries;
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
      // DD3 — point the agent at recall mode='ledger' for the full
      // moat digest (BB4 added the surface; pre-DD3 the hint never
      // told the agent the on-demand surface existed).
      contextualParts.push(
        `\n🌱 Your deepPairing ledger: ${parts.join(" · ")}. Call recall with mode='ledger' anytime to re-pull the full digest.`,
      );
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

  // EE1 — three-tier assembly:
  //   1. headerLine + obligationsParts (uncapped)
  //   2. policyParts capped at POLICY_BUDGET_CHARS
  //   3. contextualParts fills the remaining HINT_BUDGET_CHARS budget
  const assembled: string[] = [headerLine, PROTOCOL_PREAMBLE, ...obligationsParts];
  let droppedContextual = 0;
  let droppedPolicy = 0;

  // Policy tier: own budget so seeds don't displace contextual entirely.
  let policyLen = 0;
  for (const part of policyParts) {
    if (policyLen + part.length + 1 <= POLICY_BUDGET_CHARS) {
      assembled.push(part);
      policyLen += part.length + 1;
    } else {
      droppedPolicy++;
    }
  }

  // Contextual tier: cap against the global budget, including everything
  // above (header + obligations + accepted policy).
  const baselineLen = assembled.join("\n").length;
  let runningLen = baselineLen;
  // The fixed protocol preamble rides in the uncapped prefix; don't let it eat
  // into the contextual budget so memory/guardrails keep their full allowance.
  const contextualCap = HINT_BUDGET_CHARS + PROTOCOL_PREAMBLE.length + 1;
  for (const part of contextualParts) {
    if (runningLen + part.length + 1 <= contextualCap) {
      assembled.push(part);
      runningLen += part.length + 1;
    } else {
      droppedContextual++;
    }
  }
  const droppedTotal = droppedContextual + droppedPolicy;
  if (droppedTotal > 0) {
    // FF8 — only emit the policy-specific hint when ONLY policy items
    // dropped. If contextual also dropped, the generic recall pointer
    // already named mode='philosophy' and the agent will discover the
    // source filter via the recall tool description; stacking two
    // hints reads as noisy.
    const policyHint = droppedPolicy > 0 && droppedContextual === 0
      ? ` Use \`recall\` with mode='philosophy' source='user-seeded' to see all seeded stances.`
      : "";
    assembled.push(
      `\n📦 ${droppedTotal} additional context section${droppedTotal === 1 ? "" : "s"} omitted to keep this hint focused (rejected approaches, team prefs, ledger stats, etc). Call \`recall\` with mode='philosophy' or mode='sessions' to pull what you need.${policyHint}`,
    );
  }
  return `\n${assembled.join("\n")}`;
}
