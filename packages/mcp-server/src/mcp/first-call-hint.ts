import type { IStore } from "../store/store-interface.js";
import type { RequestScope, RequestSource } from "@deeppairing/shared";
import { getGlobalStore } from "../store/global-store.js";
import { groundingInstance } from "../store/philosophy-citation.js";
import { AUTONOMY_POLICY_LINE, type AutonomyLevel } from "./autonomy-policy.js";
import { PENDING_DRAFT_TYPES } from "./tools/types.js";
import { requestSecretNote, requestScopeNote, artifactHumanLabel } from "./tools/check-feedback-delivery.js";
import { cliInvocation } from "../cli-invocation.js";

/** N2 (#226 scope 4) — age in ms of the OLDEST pending draft, or null if no
 *  draft carries a parseable createdAt. Used to flag an abandoned-arc backlog. */
function staleDraftAgeMs(drafts: Array<{ createdAt?: unknown }>): number | null {
  const now = Date.now();
  let oldest: number | null = null;
  for (const d of drafts) {
    const t = typeof d.createdAt === "string" || typeof d.createdAt === "number"
      ? new Date(d.createdAt).getTime()
      : NaN;
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (oldest == null || age > oldest) oldest = age;
  }
  return oldest;
}

/** Coarse human-friendly age: "Nh"/"Nd" once past an hour, else "Nm". */
function humanizeAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

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
 *   patterns, team prefs, ledger stats, plugin tip).
 *   Capped at HINT_BUDGET_CHARS so the hint never grows into a wall of
 *   text the LLM tunes out. When capacity runs out, drop tail-first and
 *   emit a "more context: call recall" pointer so the agent knows what
 *   was elided and how to fetch it.
 *
 * Pure inputs/output: takes a store + port, returns the rendered hint
 * string. No closure references back into server.ts.
 */
const HINT_BUDGET_CHARS = 1500;
// R5 (round-13 MED) — THE AGENT-CONTEXT BUDGET OWNER. Round 5's felt-weight
// discipline was applied to the human's per-poll payload but never to the
// agent's first-call context: PROTOCOL_PREAMBLE grew +111% across four releases
// (round-13 census) as pure paragraph accretion, and it is EXEMPT from
// HINT_BUDGET_CHARS (it rides the uncapped prefix — see contextualCap below), so
// nothing bounded it. This ceiling is that bound: a test asserts the assembled
// VANILLA first-call hint (headerLine + PROTOCOL_PREAMBLE, the supervised/terse
// default every session pays) stays under it, so the preamble can't silently
// regrow. Raise it ONLY with a deliberate, reviewed reason — never to make a red
// test green. Every load-bearing rule (the floor, the three risk classes, the
// backstop, the carve-out) is pinned independently by guidance-flip-drift.test.ts;
// this budget governs SIZE, that test governs CONTENT — the two are orthogonal.
//
// Measured after T2 (round-14, the preamble compression pass): PROTOCOL_PREAMBLE
// is 6,420 chars and the assembled vanilla hint (header + preamble, supervised/
// terse, no memory/guardrails/seeds) is ~6,753 — byte-identical to the pre-flip
// supervised/rich vanilla, since both defaults contribute the empty string.
// That leaves ~380 chars of headroom
// under the preamble's own 6,800 sub-cap and ~447 under the assembled ceiling —
// deliberately opened (T2 folded the redundant floor restatements and the
// backstop filler WITHOUT dropping a load-bearing rule; every rule stays pinned
// by guidance-flip-drift.test.ts) so the next field-routing guidance edit has
// room. The ceilings themselves were NOT raised or lowered — the headroom IS the
// budget for the next comprehension-lever change; spend it on routing the agent
// to more fields, not on prose accretion. (S1 had squeezed this to ~16 chars;
// the round-13 census cited ~8,135, but that counts source comments + per-dial
// blocks, not the emitted PROTOCOL_PREAMBLE string.)
export const VANILLA_FIRST_CALL_BUDGET_CHARS = 7200;
// EE1 — dedicated cap for the user-policy tier (seeds). Pre-EE1, seeds
// were appended to blockingParts which was concatenated unconditionally,
// blowing past HINT_BUDGET_CHARS for a vanilla session and outranking
// real this-turn obligations. Cap policy at this many chars so an 8-seed
// list can't push Q4 follow-ups out of mind.
const POLICY_BUDGET_CHARS = 600;

// The pairing-protocol preamble. Always-on orientation so consuming projects
// that wire ONLY the MCP server (no pairing-protocol skill, no
// `node packages/mcp-server/dist/cli/init.js init`) still get the choreography — the happy-path sequence
// plus the two rules that keep the dialogue in the companion UI. It's
// fixed-size and essential, so it rides in the uncapped prefix and is NOT
// charged against the contextual budget below. Faithful to SKILL.md.
export const PROTOCOL_PREAMBLE = [
  "[deepPairing protocol] You're pairing — route findings/options/plans/answers through the MCP tools into the companion UI as artifacts, not plain terminal text.",
  "Voice: write TO your pair in second person (\"which fits?\"), not ABOUT them (\"User asked X\") — a conversation, not an audit log.",
  // L2 — close-the-loop headline: the two highest-value rules, up top where they
  // won't lose the reading lottery to the visuals paragraph below.
  "Close the loop — two rules above all: present code for review before it lands (batched present_changeset by default), and END every run with exactly ONE present_debrief (the trivial-fix carve-out below is the only exception).",
  // O1 (#229) — ceremony scales with RISK, not size. Three classes, always-on so
  // the risk-adaptive floor reaches the model on its FIRST artifact regardless of
  // the autonomy/detail dials. The FLOOR (present_changeset before code lands) is
  // absolute in every class — the low-risk-feature license trims PRE-WORK
  // ceremony only, never the review of the code or the closing debrief.
  "Ceremony scales with RISK, not size — three classes:",
  "  • TRIVIAL — a single-file, no-decision surgical fix: skip straight to the self-summarizing present_code_change that presents it for review AND closes it; no findings, no separate debrief.",
  "  • LOW-RISK FEATURE — multi-file/multi-step work that touches NO guardrail path (migrations, CI/workflows, secrets, auth, infra), carries NO stakes:'high' decision, and has no genuine architectural fork: you MAY skip the synchronous pre-work gates (present_findings and the spec/plan gate) and go build. Still KEEP: real-time present_options the moment a genuine decision arises, the present_changeset review surface, and exactly ONE present_debrief. Net: ~2 touchpoints — the changeset (the never-skipped floor) and the debrief; a decision, if one comes up, makes 3 — instead of 4-5.",
  "  • ESCALATED — anything touching a guardrail path, any stakes:'high' decision, or a genuine architectural fork: the full arc — findings → options → spec/plan → changeset → debrief.",
  // P1 (round-11) — describe the backstop EXACTLY as built. The pre-P1 text ("the
  // preflight gate escalates guardrail-path edits regardless") promised a
  // mechanism that did not exist; round-11 caught it. Never over-claim here: the
  // trigger, the silence condition, the dedup, and the never-denies contract are
  // all pinned by guidance-flip-drift.test.ts against the shipped hook.
  "  BACKSTOP for that last class: if you Write/Edit a guardrail path (migrations/, CI config like .github/workflows/, infra like Dockerfiles/terraform/k8s, and secret files like .env* — matched at ANY depth, so packages/api/migrations/ in a monorepo counts, while a file merely NAMED like one, e.g. src/migrations.js, does not; vendored/generated/fixture/example trees such as node_modules/, dist/, coverage/, fixtures/ and examples/ are excluded entirely) while NO findings, options, spec, or plan is live in this project's recent sessions, the preflight hook pauses the edit and asks your pair to confirm, naming the class and the path. It stays SILENT once that pre-work arc is in flight — a spec you JUST presented counts immediately. It asks at most once per guardrail class per 30 minutes (per FILE for migrations and secrets), it never blocks the edit outright, and it fails open (a missing or unreadable session store stays silent). If your pair DECLINES, that's the instruction: do the pre-work before touching that path again rather than retrying (the hook can't re-ask for 30 minutes). A safety net for a misclassified edit, not a substitute for classifying correctly.",
  "THE FLOOR IS ABSOLUTE at every class: code is presented for review via present_changeset before it lands. The low-risk-feature license trims PRE-WORK ceremony only — never the code review, never the debrief.",
  // P1 (round-11) — this list is the ESCALATED arc written out in full. Pre-P1 it
  // read as THE default sequence, contradicting the three-class block directly
  // above it (which licenses trivial/low-risk work to skip the pre-work gates).
  // Marking the escalated-only steps makes the procedural checklist agree with
  // the taxonomy instead of quietly overriding it.
  "Happy path, in order — this is the ESCALATED arc in full. Steps tagged [ESCALATED ONLY] are the pre-work gates the TRIVIAL and LOW-RISK-FEATURE classes skip; everything else applies at every class:",
  "  1. recall (mode='any', query='<the concept you're about to propose>') — check prior stances/decisions before proposing. mode='any' REQUIRES a query; to browse the whole ledger instead, call mode='philosophy' with an empty query.",
  "  2. present_findings — [ESCALATED ONLY] after researching; structured Evidence (filePath, lineStart, lineEnd, snippet), not plain-text bullets. Name each finding's `concept` — the preferred place to name a pattern.",
  "  3. check_feedback — poll in a loop (~30s; on WAITING, call again). Don't ask in the terminal.",
  "  4. present_options — each choice as its OWN card (2-4 options + a `concept`); stakes='high' for hard-to-reverse calls (schema/auth/infra). Never bury or interleave a decision inside a plan (skips the pros/cons review; the ledger never learns your pick).",
  "  5. present_spec and/or present_plan — [ESCALATED ONLY] for small multi-file work (one changeset, no architectural decision beyond the options card) present just ONE: spec when the WHAT needs agreement, plan when the HOW/sequence does. Stack BOTH (spec before the plan) only for genuinely large features. LEAD WITH A VISUAL, not prose: attach `visuals[]` (stable `id` + `kind`) — 'diagram' (Mermaid: flowchart=architecture, erDiagram=schema, sequenceDiagram=flow; quote labels with punctuation like ()#: and use `<br/>` not `\\n`); 'file_map' (create/modify/delete set); 'annotated_code' (real `code`+`filePath`, line-anchored `annotations[]` at the exact lines changing and why); 'prototype' (sandboxed `html`).",
  "  6. Present code as it lands — the DEFAULT is a batched present_changeset at each feature boundary (per-file diffs + review state). present_code_change is the EXCEPTION — a single-file surgical change, or when the human asks first; and when that single-file, no-decision fix IS the whole task, it self-summarizes and closes it (fold the what-changed-and-why into its reasoning — no separate debrief). Don't stream a log_reasoning card per step — name the concept on the finding; a `visuals[]` diagram on the changeset/debrief shows the blast radius.",
  "  7. present_debrief — END every feature/autonomous run with exactly ONE (carve-out: a single-file, no-decision surgical fix closes with its own self-summarizing present_code_change instead): what changed + why, the decisions you made WITHOUT the human, what needs their eyes, what you deferred, an ask-anything thread — the primary comprehension surface. Put the full story IN it, never 'details in chat'.",
  "  8. check_feedback again — let your pair review in the UI.",
  "Explaining how existing code WORKS (onboarding, 'how does auth work here?', a spike), not reporting problems or digesting a change? Use present_explainer — a read-only walk-through: overview + sections[] anchored to real Evidence + an ask-anything thread. Not present_findings (problems) or present_debrief (a change you made). Attach `visuals[]` (a diagram transfers best) and `unknowns[]` — the gaps you couldn't check.",
  // Hygiene (skill-usage review): the non-code→decision law lived only in
  // SKILL.md, invisible to a bare-MCP consumer. Route it here too.
  "Understanding a NON-CODE thing (a doc, message, request)? Route through a DECISION, not a read-only explainer walk — each interpretation/ambiguity a present_options card your pair must resolve, closing on the call they make. Understanding that rides a decision gets consumed; a read-only walk dies as optional narration.",
  "REVISING a plan/spec/decision you already presented? Call revise_artifact (mode='supersede') with its id + new content — don't re-post a fresh present_*. Re-posting orphans the thread; superseding links versions with a clean before/after diff.",
  "Pull the full protocol from deeppairing://onboarding. present_* refuse proposals matching a past rejected approach.",
].join("\n");

// #139 / X1 — detail-density (verbosity) guidance. This is a STANDING
// preference, so it's delivered here in the once-per-session first-call hint —
// NOT in check_feedback's per-loop structuredContent (that payload is
// deliberately byte-minimal when healthy and must stay so).
//
// X1 INVERSION — the DEFAULT is now TERSE (plain-by-default), and terse is the
// SILENT baseline: it contributes the empty string, so a default session's hint
// stays byte-for-byte as before and the common path carries zero extra tokens.
// The floor that terse must never collapse (every artifact still posts, code is
// still PRESENTED FOR REVIEW BEFORE IT LANDS, Evidence always attached) is
// carried by the always-on PROTOCOL_PREAMBLE and the SKILL Voice guard, not by
// this now-empty block. Only an explicit RICH opt-in appends bytes — so the
// budget-critical common path pays nothing, exactly as before the flip.
const DETAIL_DENSITY_TERSE_GUIDANCE = "";
//
// RICH (opt-in): the human wants fuller explanatory prose. This is the ONLY
// mode that appends to the hint now. It expands the EXPLANATION around each
// artifact — it never changes the review surfaces: Evidence, structured fields,
// diagrams, and artifact count are identical to terse.
const DETAIL_DENSITY_RICH_GUIDANCE =
  "\n🗣 Detail density: RICH — the human wants fuller prose. Expand explanations/rationale around each artifact. Evidence, structured fields, diagrams, and artifact count are unchanged.";

// #148 — autonomy-level guidance. Same delivery pattern as #139's detail
// density above: a STANDING user setting, spoken once per session in the
// UNCAPPED obligations tier (a dial instruction that lost the truncation
// lottery would make the dial unreliable). Pre-#148 the level reached the
// model ONLY via check_feedback — which runs AFTER the agent's opening
// artifacts, so a user who set "Light"/"Minimal" still watched the agent post
// the full findings→options→spec→plan ceremony and only then got told to skip
// it. Injecting here lets the dial shape the very first artifact.
//
// SUPERVISED (default): contributes the empty string — the preamble already
// prescribes the full ceremony, so a default session's hint stays identical
// to pre-#148. The test pins this invariant DIRECTLY (autonomyHintFor
// ("supervised") === "") rather than via a recorded sha, so legitimate
// preamble edits don't false-fail. Deliberate; see autonomy-policy.ts.
const AUTONOMY_HINT_SUPERVISED = "";
//
// BALANCED: the opening ceremony scales with the task. Leads with the exact
// AUTONOMY_POLICY_LINE check_feedback repeats per poll, so the two surfaces
// cannot contradict each other. The FLOOR is restated here too — "go straight
// to the work" would otherwise read, for exactly the simple-task class it
// licenses, as "Edit directly"; and stating the floor ONLY in the autonomous
// block invites the inference that balanced's skip-license is broader.
const AUTONOMY_HINT_BALANCED = [
  `\n🎚 Autonomy: BALANCED — the human set this dial, and it applies from your FIRST artifact, not just later turns. ${AUTONOMY_POLICY_LINE.balanced}`,
  "  - For simple or mechanical tasks (typo fixes, renames, small obvious changes): skip present_findings and go straight to the work.",
  "  - Reserve present_options for genuine architectural tradeoffs — not routine implementation choices with one reasonable answer.",
  "  - Substantial work — a stakes:'high' decision, a guardrail path, or a genuine architectural fork — still gets the full sequence: findings → options → spec/plan. A low-risk multi-file feature that touches none of those is the LOW-RISK-FEATURE class (see the three ceremony classes above): it MAY skip those pre-work gates and go build, while still keeping the changeset review surface and one debrief.",
  "  - FLOOR (unchanged): code must be PRESENTED FOR REVIEW BEFORE IT LANDS — present_changeset at feature boundaries by default, present_code_change for single-file/surgical changes, and end the feature with present_debrief (a single-file, no-decision surgical fix closes with its own self-summarizing present_code_change instead); this dial trims findings/options, never the review record.",
].join("\n");
//
// AUTONOMOUS: bias to motion — but the FLOOR is stated explicitly and is
// load-bearing: code is PRESENTED FOR REVIEW BEFORE IT LANDS (the human's review
// record) and that is NEVER lifted by this dial, and project guardrails (the 🛡
// section, when present) still escalate specific paths back to supervised.
const AUTONOMY_HINT_AUTONOMOUS = [
  `\n🎚 Autonomy: AUTONOMOUS — the human set this dial, and it applies from your FIRST artifact. ${AUTONOMY_POLICY_LINE.autonomous}`,
  "  - Skip the opening findings/options ceremony for routine work: proceed with your recommended approach; the human reviews after the fact.",
  "  - FLOOR (this dial never lifts it): code must be PRESENTED FOR REVIEW BEFORE IT LANDS — present_changeset at feature boundaries by default, present_code_change for single-file/surgical changes, and end the feature with present_debrief (a single-file, no-decision surgical fix closes with its own self-summarizing present_code_change instead); the human reviews the artifact, not raw edits on disk.",
  "  - Project guardrails override this dial: escalate to supervised for changes in guardrail paths. If you don't, the preflight backstop pauses the first such write and asks your pair to confirm (see the BACKSTOP note above).",
].join("\n");

/**
 * #148 — the autonomy dial's contribution to the first-call hint, exported so
 * the test can pin the ACTUAL invariant (supervised contributes the empty
 * string) directly instead of via sha self-comparison of the whole hint.
 */
export function autonomyHintFor(level: AutonomyLevel): string {
  return level === "balanced"
    ? AUTONOMY_HINT_BALANCED
    : level === "autonomous"
      ? AUTONOMY_HINT_AUTONOMOUS
      : AUTONOMY_HINT_SUPERVISED;
}

export async function buildFirstCallHint(
  store: IStore,
  port: number,
  /**
   * Q3 — comment ids this call is ABOUT TO answer. The hint is assembled BEFORE
   * the tool handler runs (server.ts builds it, then attaches it to the
   * successful result), so a first call of `answer_question` sees a snapshot
   * that still contains the very comment it is answering — and the reply came
   * back carrying "1 unanswered human question awaits… Drain these before new
   * work." for a queue the agent had just drained. Every obligation lane that
   * keys on `!answeredByCommentId` (questions, follow-up replies, plain
   * comments needing a mirror) skips these ids: on a SUCCESSFUL answer_question
   * — the only case the hint is attached at all — the agent has replied to that
   * comment, whichever lane it sat in.
   */
  answeredCommentIds: readonly string[] = [],
): Promise<string> {
  const answeringCommentIds = new Set(answeredCommentIds.filter((id) => typeof id === "string" && id.length > 0));
  // EE1 — three-tier ordering for assembly:
  //   1. obligationsParts: real this-turn obligations (Q4 follow-ups,
  //      plain comments needing mirror, decision revisions). Uncapped —
  //      the agent must address these or feedback breaks.
  //   2. policyParts: user-policy declarations (seeds). Capped at
  //      POLICY_BUDGET_CHARS. High priority but not unlimited.
  //   3. contextualParts: advisory signals (memory, team prefs,
  //      philosophy, R2). Capped against the remaining budget.
  //      (Guardrails rode here pre-S1; they now ride obligations — see J6.)
  // The pre-EE1 single `blockingParts` bucket let seeds crowd out
  // unanswered human questions — exactly the wrong priority order.
  const obligationsParts: string[] = [];
  const policyParts: string[] = [];
  const contextualParts: string[] = [];
  // Back-compat alias — old code paths still push into blockingParts; we
  // route those into obligations at the bottom of the function. Kept as
  // a const so existing pushes type-check unchanged.
  const blockingParts: string[] = obligationsParts;
  // I7 — the LIVE companion UI URL, built from the daemon's real port at
  // hint-build time (standalone.ts threads the daemon's actual bound port
  // through createMcpServer → here). Field report: an agent asked for the UI
  // URL answered "http://localhost:5173" (the Vite dev default) — a pure
  // hallucination; the daemon was on 3880. The URL already lived here (and in
  // the deeppairing://onboarding resource) but nothing PUSHED it hard enough,
  // so the agent guessed. Make it unmissable and name the anti-pattern
  // outright. Handle daemon-not-yet-started honestly: if the port isn't a real
  // number, say so and point at onboarding rather than emit a bogus URL.
  const companionUrl = Number.isFinite(port) && port > 0 ? `http://localhost:${port}` : null;
  const headerLine = companionUrl
    ? `[First use this session] The companion UI is LIVE at ${companionUrl} — this is the daemon's REAL, server-provided port (not a guess). The human reviews artifacts, comments, and makes decisions there. When they ask for the URL, give them this exact one; NEVER guess a default — it is NOT Vite's 5173 or any other made-up port.`
    : `[First use this session] The companion UI daemon hasn't reported its port yet. Do NOT invent a URL (it is NOT 5173 or any default) — read the deeppairing://onboarding resource for the live URL once the daemon is up.`;

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
  // S1 — ride the UNCAPPED obligations tier, unconditionally. Pre-S1 this
  // section was contextual, while #139's terse block and #148's autonomy
  // blocks were uncapped AND charged against the contextual budget
  // (baselineLen below includes obligations) — so under
  // {balanced|autonomous} × terse the guardrails lost the truncation
  // lottery exactly when the autonomous block says "escalate to supervised
  // for changes in guardrail paths". Guardrails are small, safety-relevant,
  // and unactionable-if-absent: no recall mode covers them and no preflight
  // backstop re-surfaces them (unlike rejected approaches, which stay
  // contextual by design — recall mode='philosophy' + the preflight
  // hard-block make their eviction recoverable). Cost: when guardrails
  // exist they now count in baselineLen, slightly tightening the
  // contextual squeeze for advisory sections — the right trade.
  try {
    // AA7b — typed optional method (was a (store as any) cast pre-AA7).
    const guardrails = await store.getProjectGuardrails?.();
    if (Array.isArray(guardrails) && guardrails.length > 0) {
      const lines = guardrails.map((g: any) =>
        `  - ${g.category} (${(g.paths ?? []).join(", ")}): ${g.rationale}`,
      );
      obligationsParts.push(
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
            // Q6 (#232) B3 — quote the REJECTION that grounds the avoid stance,
            // not "the latest reason of any verdict". On a concept the human
            // rejected twice and later approved once, the old code printed their
            // APPROVAL's words as the reason to avoid it — under a heading that
            // says "Strong 'avoid' stances". Shared with recall's two modes so
            // all three surfaces cite the same instance (philosophy-citation.ts).
            const grounding = groundingInstance(e, e.stance);
            const projects = new Set(e.instances.map((i) => i.project)).size;
            return `  - "${e.concept}"${grounding?.reason ? ` — "${grounding.reason}"` : ""}${projects > 1 ? ` (${projects} projects)` : ""}`;
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

    // X4 — id → artifact lookup so the obligation lanes below can echo a HUMAN
    // LABEL (type + title) instead of a bare `art_…` id the human never sees.
    const artifactsById = new Map<string, { type: string; title: string }>(
      (fullState.artifacts ?? []).map((a: { id: string; type: string; title: string }) => [
        a.id,
        { type: a.type, title: a.title },
      ]),
    );

    // M4 — pending-artifact inventory for a RESTARTED agent. The session store
    // is per-project and reloads across runs, so draft artifacts a PRIOR run
    // presented are still awaiting review on this run's first call. Surface them
    // in the uncapped obligations tier (counts + types only — budget-conscious,
    // one line) so a restarted agent calls check_feedback before piling on new
    // work. (On the very first call of a run, every draft is by definition from
    // an earlier run.)
    const pendingDrafts = (fullState.artifacts ?? []).filter(
      (a: any) => a.status === "draft" && (PENDING_DRAFT_TYPES as readonly string[]).includes(a.type),
    );
    if (pendingDrafts.length > 0) {
      const typeCounts = new Map<string, number>();
      for (const a of pendingDrafts) typeCounts.set(a.type, (typeCounts.get(a.type) ?? 0) + 1);
      const typesList = [...typeCounts.entries()].map(([t, n]) => `${n} ${t}`).join(", ");
      // N2 (#226 scope 4) — stale-arc signal. On a reconnect after an abandoned
      // arc, drafts left by a PRIOR connection look identical to fresh work. If
      // the oldest pending draft was presented long ago (~30min+), annotate its
      // age so the agent reviews/revises/withdraws it before piling on — a
      // draft still under review after that long is almost certainly abandoned,
      // not being actively looked at. Budget-conscious: extends this one line.
      const oldestAgeMs = staleDraftAgeMs(pendingDrafts);
      const staleNote =
        oldestAgeMs != null && oldestAgeMs >= 30 * 60 * 1000
          ? ` (stale — oldest presented ${humanizeAge(oldestAgeMs)} ago; review, revise, or withdraw it before new work)`
          : "";
      blockingParts.push(
        `\n📥 ${pendingDrafts.length} artifact${pendingDrafts.length === 1 ? "" : "s"} you presented earlier still await${pendingDrafts.length === 1 ? "s" : ""} review (${typesList})${staleNote} — call check_feedback before presenting new work.`,
      );
    }
    // #192 — also exclude humanResolvedAt (a question the human marked done):
    // the tail-walk predicate this queue's other surfaces use treats a
    // human-resolved question as closed, so the preamble must not nag about it.
    //
    // Q3 — and exclude `answeringCommentIds`: the STALE NAG. This hint is built
    // BEFORE the tool handler runs (server.ts builds it, then attaches it to the
    // successful result), so when the session's first call is `answer_question`
    // the snapshot still shows the question it is about to answer. The observed
    // symptom: answering the ONLY open question came back with "1 unanswered
    // human question awaits… Drain these before new work." Nothing was owed. The
    // handler's own commentId is passed in so the count reflects the state the
    // agent is being handed, not the one it just left.
    const unanswered = allComments.filter(
      (c: any) =>
        c.author === "human" &&
        c.intent === "question" &&
        !c.answeredByCommentId &&
        !c.humanResolvedAt &&
        !answeringCommentIds.has(c.id),
    );
    const revisionRequested = unanswered.filter(
      (c: any) => typeof c.target?.sectionId === "string" && c.target.sectionId.startsWith("decision_revision_requested"),
    );
    const plainUnanswered = unanswered.filter((c: any) => !revisionRequested.includes(c));
    if (revisionRequested.length > 0) {
      const lines = revisionRequested.map((c: any) => {
        const aId = c.target?.artifactId ?? "(unknown)";
        const label = artifactHumanLabel(artifactsById.get(aId));
        const excerpt = String(c.content ?? "").slice(0, 120);
        return `  • ${label} [${aId}] — comment ${c.id}: "${excerpt}"`;
      });
      blockingParts.push(
        `\n🔁 ${revisionRequested.length} REVISION REQUEST${revisionRequested.length === 1 ? "" : "S"} on decisions. The human wants the OPTIONS REVISED, not just an answer:\n${lines.join("\n")}\n` +
        `Required response per request: call \`revise_artifact\` mode="supersede" on the decision artifact with a NEW option set incorporating the feedback. Then briefly call \`answer_question\` on the comment so the rail shows "↻ Revised". Do NOT just call answer_question and leave the original options on the table.`,
      );
    }
    if (plainUnanswered.length > 0) {
      // #192 (serving H1) — these persist across runs (the session store is
      // per-project and reloads), so a question asked after a previous run ended
      // — e.g. on a debrief/explainer ask-anything thread right as the agent
      // stopped polling — surfaces here on this run's FIRST call. Drain them
      // before starting new work.
      blockingParts.push(
        `\n❓ ${plainUnanswered.length} unanswered human question${plainUnanswered.length === 1 ? "" : "s"} await${plainUnanswered.length === 1 ? "s" : ""} — some may be from earlier runs. Call check_feedback to see and answer them, then reply with answer_question (not a plain comment) so the UI links the answer to the question. Drain these before new work.`,
      );
    }

    // G1 (#198b) — pending (unserved) human REQUESTS join the obligations
    // inventory, placed AFTER the plain-unanswered questions push (mirroring the
    // check_feedback ordering: requests rank after unanswered questions). These
    // persist across runs like questions, so a request the human composed while
    // the agent was gone surfaces on this run's FIRST call.
    const pendingRequests = ((fullState as { requests?: Array<{ id: string; text: string; intent: string; servedByArtifactId?: string; secretWarnings?: Array<{ pattern: string; label: string }>; source?: RequestSource; scope?: RequestScope }> }).requests ?? [])
      .filter((r) => !r.servedByArtifactId);
    if (pendingRequests.length > 0) {
      // #204 (code lens F1) — append the same TEXT-ONLY secret marker the
      // check_feedback request line carries, so a credential pasted into the
      // composer while the agent was gone is flagged on this run's FIRST call.
      // P2 review F5 — the 120-char truncation ate exactly the part that makes a
      // walk-me-through request safe to serve (the line range, "not a whole-file
      // tour") on any deep path — and THIS is the surface the no-agent-live toast
      // advertises ("queued… when the session resumes"). Append the same scope
      // clause check_feedback delivers, AFTER the slice, so truncating the prose
      // can never truncate the scope.
      const lines = pendingRequests.map(
        (r) => `  • ${r.id} (${r.intent}): "${String(r.text ?? "").slice(0, 120)}"${requestSecretNote(r)}${requestScopeNote(r)}`,
      );
      blockingParts.push(
        `\n📨 ${pendingRequests.length} pending human request${pendingRequests.length === 1 ? "" : "s"} — the human ASKED you to do ${pendingRequests.length === 1 ? "this" : "these"} (explain→present_explainer, plan→present_plan/present_spec, status→present_debrief):\n${lines.join("\n")}\n` +
        `Serve each with the matching present_* tool, passing servedRequestId so it links back and clears.`,
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
        !c.answeredByCommentId &&
        // Q3 — same stale-snapshot exclusion as the question lane above.
        !answeringCommentIds.has(c.id),
    );
    if (followUps.length > 0) {
      const lines = followUps.map((c: any) => {
        const aId = c.target?.artifactId ?? "(unknown)";
        const label = artifactHumanLabel(artifactsById.get(aId));
        const excerpt = String(c.content ?? "").slice(0, 100);
        return `  • Reply ${c.id} on ${label} [${aId}] (parent ${c.parentCommentId}): "${excerpt}"`;
      });
      blockingParts.push(
        `\n↳ ${followUps.length} follow-up repl${followUps.length === 1 ? "y" : "ies"} in active thread${followUps.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n` +
        `Each is a continuation of an existing thread (parentCommentId points at one of your previous replies). Call \`answer_question\` AGAIN with the reply's id as commentId to keep the thread going. Do NOT post a new top-level comment.`,
      );
    }

    const followUpIds = new Set(followUps.map((c: any) => c.id));
    // #220 M1.6 — a top-level, non-question human comment on an artifact whose
    // APPROVAL VERDICT STANDS is an ACK ("ship it"), not a reply the agent owes.
    // The dogfood flagged two bare approval acks as "comments without an agent
    // reply" and trapped the agent chasing non-existent obligations. Gate
    // NARROWLY: exclude only comments whose target artifact is currently
    // approved. This does NOT weaken genuine owing signals — a SUBSTANTIVE
    // comment that continues the discussion arrives as a follow-up (parentCommentId
    // → an agent comment) and is caught by the ↳ follow-up lane above regardless
    // of approval status; a comment on a still-open (draft/pending) artifact still
    // owes here. Only the top-level ack accompanying an approval drops out.
    const approvedArtifactIds = new Set(
      (fullState.artifacts ?? [])
        .filter((a: any) => a.status === "approved")
        .map((a: any) => a.id),
    );
    const plainCommentsNeedingMirror = allComments.filter(
      (c: any) =>
        c.author === "human" &&
        c.intent !== "question" &&
        !c.answeredByCommentId &&
        !followUpIds.has(c.id) &&
        c.target?.artifactId &&
        c.target.artifactId !== "__session__" &&
        !approvedArtifactIds.has(c.target.artifactId) &&
        // Q3 — same stale-snapshot exclusion as the question lane above. A
        // SUCCESSFUL answer_question posted a reply on this comment (the plain
        // path also stamps answeredByCommentId; the suggestion path stamps the
        // suggestion state), so "needs a mirror" is already false.
        !answeringCommentIds.has(c.id),
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
          "\n💡 Tip: run `" + cliInvocation("init") + "` to add the deepPairing protocol to CLAUDE.md so the agent follows it on every session (optional — the plugin's pairing-protocol skill covers most of this already).",
        );
      }
    }
  } catch {
    // Non-fatal.
  }

  // #139 / X1 — detail density. A direct, explicit user setting, riding in the
  // UNCAPPED obligations tier: a verbosity instruction that silently lost the
  // truncation lottery would make the feature unreliable. AFTER THE X1 FLIP the
  // DEFAULT is terse and terse contributes the empty string, so the default
  // (plain-by-default) session's hint is byte-for-byte unchanged and the common
  // path pays nothing; only an explicit "rich" opt-in appends its short block.
  // The rich block is small (~250 bytes) and lands before the contextual budget
  // is measured (baselineLen includes obligations), so a context-heavy rich
  // session shrinks the advisory budget by that much — the right trade, and the
  // rich block itself is never truncated.
  try {
    const density = await store.getDetailDensity?.();
    const guidance = density === "rich" ? DETAIL_DENSITY_RICH_GUIDANCE : DETAIL_DENSITY_TERSE_GUIDANCE;
    if (guidance) obligationsParts.push(guidance);
  } catch {
    // Non-fatal — absent/unreadable preference falls back to terse (no guidance).
  }

  // #148 — autonomy dial, same uncapped-tier pattern as detail density above.
  // Supervised (the default) contributes the empty string, so the common path
  // stays byte-identical; only an explicit balanced/autonomous appends its
  // block. Guardrail escalation (the 🛡 section) is assembled independently
  // above and is never weakened by this — the autonomous block explicitly
  // defers to it.
  try {
    const guidance = autonomyHintFor(await store.getAutonomyLevel());
    if (guidance) obligationsParts.push(guidance);
  } catch {
    // Non-fatal — absent/unreadable preference falls back to supervised (no guidance).
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
  // I7 — headerLine (carrying the LIVE companion UI URL + never-guess guidance)
  // is fixed essential orientation in the same uncapped-prefix tier as the
  // preamble; exclude its length from the advisory contextual budget too.
  // Pre-I7 the header WAS charged, so enriching it silently shrank the
  // contextual allowance and evicted calibrated memory/guardrail/ledger
  // sections (dropped-context tests flipped). Neutralizing it keeps the
  // advisory tier at its full HINT_BUDGET_CHARS regardless of header length.
  const contextualCap = HINT_BUDGET_CHARS + PROTOCOL_PREAMBLE.length + headerLine.length + 1;
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
