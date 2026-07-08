import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IStore } from "../store/store-interface.js";
import { buildFirstCallHint } from "./first-call-hint.js";
import {
  tryElicit as tryElicitHelper,
  preflightRejectedApproaches as preflightHelper,
  SessionNameLatch,
  getPassiveFeedback as getPassiveFeedbackHelper,
} from "./tool-helpers.js";
import { handleLogReasoning } from "./tools/log-reasoning.js";
import { handleExportSession } from "./tools/export-session.js";
import { handlePresentFindings } from "./tools/present-findings.js";
import { handlePresentOptions } from "./tools/present-options.js";
import { handleCheckFeedback } from "./tools/check-feedback.js";
import { handleAnswerQuestion } from "./tools/answer-question.js";
import { handleUpdatePlanProgress } from "./tools/update-plan-progress.js";
import { handleReviseArtifact } from "./tools/revise-artifact.js";
import { handlePostPrReview } from "./tools/post-pr-review.js";
import { handlePresentSpec } from "./tools/present-spec.js";
import { handlePresentPlan } from "./tools/present-plan.js";
import { handlePresentCodeChange } from "./tools/present-code-change.js";
import { handleRecall } from "./tools/recall.js";
import type { ToolContext } from "./tools/types.js";

/**
 * U0.2 — schema for the quick-approve elicitation form.
 *
 * Field bug it closes: an empty `properties: {}` schema let the elicitation
 * render as a bare "OK" prompt. Some Claude Code surfaces auto-accept that
 * on plain Enter, even when the user was typing a comment intended for the
 * companion UI. The artifact silently flipped to `approved` mid-conversation.
 *
 * Requiring a real `approve: boolean` field forces the user to deliberately
 * tick "approve" before we treat the result as an approval. Anything else —
 * Enter-through, decline, cancel, malformed payload — falls through to the
 * companion-UI review path.
 */
// X4 — elicitation schema + decision helper extracted to mcp/elicit.ts so
// tool-helpers and per-tool handlers can import them without circular deps
// through this file. Re-exported for any external consumer that imported
// from server.ts directly (preserves the public surface).
export { ELICIT_APPROVE_SCHEMA, decideElicitResponse } from "./elicit.js";

// U5 — pre-flight matching rules and orchestration moved to
// preflight-validator.ts so they're testable without spinning up the
// MCP harness. matchesGlob is re-exported from there for any caller
// that imported it from this module historically.
import { matchesGlob as _matchesGlob } from "./preflight-validator.js";
import { TOOL_INPUT_SCHEMAS, toMcpInputSchema } from "./validate-tool-input.js";
export const matchesGlob = _matchesGlob;

type BroadcastFn = (event: any) => void;

/**
 * C6b — ONE definition of the `visuals[]` item schema. It was inlined three
 * times (options / spec / plan) and had already drifted: the options copy
 * advertised a SLIM subset (no file_map/prototype/annotated_code fields) even
 * though the shared PlanVisualSchema validator accepts the full shape
 * everywhere. Tracked follow-up: derive this whole object from the shared Zod
 * schema via z.toJSONSchema (needs the field descriptions ported to
 * .describe() first).
 */

export function createMcpServer(store: IStore, broadcast: BroadcastFn, port = 3847) {
  const server = new Server(
    { name: "deeppairing", version: "0.1.2" },
    {
      // HH10 — declare listChanged so MCP clients know to listen for
      // notifications/resources/list_changed and re-call resources/list
      // when fired. Pre-HH10 every present_* handler minted a new
      // deeppairing://artifact/{id} resource, but the agent had no
      // protocol-level signal that the list had moved — long-running
      // sessions never saw new resources unless they speculatively
      // re-listed.
      // III12 — declare `prompts` capability. We ship one prompt
      // (`recall`) as an agent-invocable slash-style query instead of a
      // 13th tool. The `recall` tool stays for now (programmatic agent
      // calls); the prompt is the surface a user types into the host
      // chat ("/recall pay-per-request hosting"). This is the right
      // shape for the use case and reclaims attention budget in MCP
      // clients with hard tool-count caps.
      capabilities: { tools: {}, resources: { listChanged: true }, prompts: {} },
    },
  );

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "present_findings",
        annotations: { title: "Present findings", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          `Present research findings as a structured artifact in the companion UI (${port ? `localhost:${port}` : ""}). Each finding carries evidence, category, significance, severity.` +
          `\n\nSchema note: \`findings\` is an array of objects (NOT a string). Required per-finding: category, detail, significance. Validation runs at the boundary; mismatch returns INPUT_VALIDATION_FAILED with the bad path + an example.` +
          `\n\nWorkflow: SINGLE REVIEW SURFACE — the companion UI is the only review surface. Don't paste findings in chat; call check_feedback for the verdict.`,
        // D4 — derived from the validator's zod shape (validate-tool-input.ts);
        // advertisement and validation can no longer drift.
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_findings),
      },
      {
        name: "present_options",
        annotations: { title: "Present options", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present 2–4 options with pros/cons/effort/risk for the human to choose. Y5: each option SHOULD include `concept` ({name, oneLineExplanation?}) — the underlying pattern (e.g. 'external cache service'). Concepts make rejections compound across projects via the philosophy ledger." +
          "\n\nSchema note: `options` is an array of 2–4 objects. `concept` optional but strongly preferred. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — human selects in the companion UI; don't list options in chat. Call check_feedback for the selection. FF9 — stakes='high' enables opt-in prediction capture; check_feedback MAY include optional `predictedOutcome` + `confidence`.",
        // D4 — derived from the validator's zod shape (validate-tool-input.ts);
        // advertisement and validation can no longer drift.
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_options),
      },
      {
        name: "present_spec",
        annotations: { title: "Present spec", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present a feature spec — objective, requirements (each with rationale + acceptance criteria), optional design notes and tasks. For non-trivial work that'd otherwise skip straight to code without agreement on what's being built." +
          "\n\nSchema note: `requirements` is a non-empty array of objects with `id`, `statement`, `rationale`, `acceptanceCriteria`. VISUALS (encouraged): attach `visuals[]` — each a stable `id`, a `kind` (diagram/file_map/prototype/annotated_code; see inputSchema), and `title`. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — the companion UI is where the human reviews requirements. Don't re-paste in chat. Call check_feedback for the verdict.",
        // D4 — derived from the validator's zod shape (validate-tool-input.ts);
        // advertisement and validation can no longer drift.
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_spec),
      },
      {
        name: "present_plan",
        annotations: { title: "Present plan", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present an implementation plan as steps with file changes and before/after previews." +
          "\n\nSchema note: `steps` needs `description` + `reasoning` each. VISUALS (encouraged): attach `visuals[]` so the human reviews a picture — each a stable `id` (keep across revisions), a `kind` (diagram/file_map/prototype/annotated_code; see inputSchema), and `title`. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — this REPLACES Claude Code's native plan-approval flow. Do NOT call ExitPlanMode after present_plan. The companion UI is the only approval surface; call check_feedback for the verdict.",
        // D4 — derived from the validator's zod shape (validate-tool-input.ts);
        // advertisement and validation can no longer drift.
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_plan),
      },
      {
        name: "log_reasoning",
        annotations: { title: "Log reasoning", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Log the reasoning for an action before taking it. Pairs with present_code_change for the per-edit checkpoint cadence (WHY + WHAT — together they give the human a chance to redirect BEFORE the diff is on disk)." +
          "\n\nSchema note: required: `action`, `reasoning`. Name the underlying concept in `concept` whenever one applies — that's the human's learning lever. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: REQUIRED BEFORE EACH SIGNIFICANT EDIT. Don't just chat-explain.",
        // D4 — derived from the validator's zod shape (validate-tool-input.ts);
        // advertisement and validation can no longer drift.
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.log_reasoning),
      },
      {
        name: "check_feedback",
        annotations: { title: "Check feedback", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description:
          "Poll for the human's response to artifacts you've presented. The human responds in the companion UI; this tool waits up to 30s and returns status + any comments / decisions / plan verdicts." +
          "\n\n`waitFor` scopes the long-poll wake condition: 'comments' wakes only on new comments, 'decision' only on a resolved present_options, 'plan_review' only on a plan status transition, 'artifact_status' on any artifact status change, 'any' (default) on any feedback. Use a narrow scope when you've just presented a specific artifact and want to ignore unrelated chatter.",
        inputSchema: {
          type: "object" as const,
          properties: {
            waitFor: {
              type: "string",
              enum: ["any", "comments", "decision", "plan_review", "artifact_status"],
              description: "Scope the poll to a specific feedback type. Default 'any'.",
            },
          },
        },
        // B3 — machine-readable mirror of the prose response (structuredContent).
        // Clients that support structured tool output can branch on `status` /
        // `suggestedAction` instead of prose-parsing the status blob.
        outputSchema: {
          type: "object" as const,
          properties: {
            status: {
              type: "string",
              enum: ["feedback", "waiting", "proceed"],
              description: "feedback = something to act on below; waiting = reviews still pending; proceed = clear.",
            },
            suggestedAction: { type: "string" },
            companionUrl: { type: "string", description: "I7 — the LIVE companion UI URL (daemon's real bound port). Give the human THIS exact URL; never guess a default like Vite's 5173." },
            waitFor: { type: "string", description: "Present on a scoped still-waiting response." },
            summary: {
              type: "object",
              properties: {
                totalArtifacts: { type: "number" },
                approved: { type: "number" },
                pending: { type: "number" },
                newComments: { type: "number" },
                autonomy: { type: "string" },
              },
            },
            pendingArtifacts: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, title: { type: "string" } } },
            },
            questions: {
              type: "array",
              description: "Unanswered human questions — answer via answer_question with the commentId.",
              items: {
                type: "object",
                properties: {
                  commentId: { type: "string" },
                  artifactId: { type: "string" },
                  content: { type: "string" },
                  lineStart: { type: "number" },
                  findingIndex: { type: "number" },
                },
              },
            },
            comments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  artifactId: { type: "string" },
                  kind: { type: "string", enum: ["directive", "comment", "suggestion"] },
                  content: { type: "string" },
                  suggestion: { type: "string" },
                  filePath: { type: "string" },
                  lineStart: { type: "number" },
                  findingIndex: { type: "number" },
                },
              },
            },
            decisions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  decisionId: { type: "string" },
                  artifactId: { type: "string" },
                  context: { type: "string" },
                  selectedOptionId: { type: "string" },
                  selectedTitle: { type: "string" },
                  reasoning: { type: "string" },
                },
              },
            },
            rejected: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, title: { type: "string" } } },
            },
          },
          required: ["status", "suggestedAction"],
        },
      },
      {
        name: "present_code_change",
        annotations: { title: "Present code change", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present a code change as a before/after diff with reasoning. Y5: include `concept` ({name, oneLineExplanation?}) — name the pattern (e.g. 'work factor tuning') so cross-project preflight matches it." +
          "\n\nSchema note: required: `filePath`, `changeType`, `after`, `reasoning`. `concept` strongly preferred. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: REQUIRED BEFORE EACH Write/Edit/MultiEdit on a file not yet approved this session — per-edit checkpoint, not one-shot. Batched implementation skipping checkpoints is a protocol violation. SINGLE REVIEW SURFACE — companion UI only, don't paste in chat. Call check_feedback for the verdict.",
        // D4 — derived from the validator's zod shape (validate-tool-input.ts);
        // advertisement and validation can no longer drift.
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_code_change),
      },
      {
        name: "recall",
        annotations: { title: "Recall philosophy", readOnlyHint: true, openWorldHint: false },
        description:
          "Search deepPairing memory.\n\n" +
          "Modes:\n" +
          "- `philosophy` — cross-project stances (avoid/prefer/mixed). Optional `stance` + `source` filters. Empty query lists the whole ledger.\n" +
          "- `sessions` — past artifacts in THIS project. Requires a query.\n" +
          "- `ledger` — cross-project moat digest (shaped/near-misses/blocked counts + top cited stances + seeded). Query ignored.\n" +
          "- `any` (default) — unions philosophy + sessions, philosophy first. Requires a query.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Free-text query (concept, title, or content substring). Empty string with mode='philosophy' lists the whole ledger; ignored for mode='ledger'." },
            mode: {
              type: "string",
              enum: ["philosophy", "sessions", "ledger", "any"],
              description: "Which layer to search. Default 'any'.",
            },
            stance: {
              type: "string",
              enum: ["avoid", "prefer", "mixed"],
              description: "Only applies when mode='philosophy' — filter to this derived stance.",
            },
            source: {
              type: "string",
              enum: ["user-seeded", "session"],
              description: "Filter to entries with at least one instance from this source. With mode='philosophy', restricts the result list. With mode='ledger', hides the suppressed section (e.g. source='user-seeded' shows only the SEED block + headline counts, with a note about suppressed cited stances). 'user-seeded' = manually pasted via the SeedAffordance; 'session' = recorded during a paired session.",
            },
            limit: { type: "number", description: "Max results (default 20, cap 100)" },
          },
        },
      },
      {
        name: "post_pr_review",
        annotations: { title: "Post PR review", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        description:
          "Post this session's approved findings as inline comments on a GitHub PR via the `gh` CLI. Only findings with structured evidence (filePath + lineStart) anchor as inline comments; rejected / retracted / superseded artifacts are omitted.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pr: {
              type: "string",
              description: "PR number (e.g. '42'), '#42', or a full https://github.com/owner/repo/pull/N URL",
            },
            event: {
              type: "string",
              enum: ["COMMENT", "REQUEST_CHANGES", "APPROVE"],
              description: "The review event type. Default: COMMENT. Use REQUEST_CHANGES when findings are severe.",
            },
            owner: { type: "string", description: "Override repo owner (when pr is just a number and you're not in the repo)" },
            repo: { type: "string", description: "Override repo name" },
          },
          required: ["pr"],
        },
      },
      {
        name: "export_session",
        annotations: { title: "Export session", readOnlyHint: true, openWorldHint: false },
        description: "Export the current session as markdown. Formats: 'pr-description' (PR body), 'pr-comments' (findings as file:line PR comments), 'adr' (architecture decision record), 'full' (complete session), 'replay' (chronological walkthrough), 'learnings' (teaching artifact — concepts named, predictions made, approaches rejected).",
        inputSchema: {
          type: "object" as const,
          properties: {
            format: { type: "string", enum: ["pr-description", "pr-comments", "adr", "full", "replay", "learnings"], description: "Export format" },
          },
        },
      },
      // III12 — `request_horizon_check` was a 7-line wrapper around
      // `addComment` with intent="question" and a templated prompt. It
      // didn't earn a first-class tool slot. Removed; the workflow is
      // now: agent calls `answer_question` (or just `addComment` with
      // intent="question") with the horizon prompt as the question
      // text. The `deeppairing.md` skill carries the template prompts.
      {
        name: "answer_question",
        annotations: { title: "Answer question", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Reply to a question comment from the human. Use instead of a plain comment reply so the answer is linked to the question and the UI collapses the pair. Attach `evidence` when the answer points at real code.",
        inputSchema: {
          type: "object" as const,
          properties: {
            commentId: { type: "string", description: "The id of the question comment to answer (cmt_...)" },
            answer: { type: "string", description: "Your explanation, in markdown" },
            evidence: {
              type: "array",
              description: "Optional code snippets supporting the answer",
              items: {
                type: "object",
                properties: {
                  filePath: { type: "string" },
                  lineStart: { type: "number" },
                  lineEnd: { type: "number" },
                  snippet: { type: "string" },
                  explanation: { type: "string" },
                },
              },
            },
          },
          required: ["commentId", "answer"],
        },
      },
      {
        name: "update_plan_progress",
        annotations: { title: "Update plan progress", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Mark plan steps as in_progress/done/skipped while EXECUTING an approved plan. Call it as you finish each step — the companion UI renders a live joint checklist, so your pair watches the build land instead of staring at a spinner. Not for changing the plan itself (use revise_artifact).",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifactId: { type: "string", description: "The plan artifact id (art_...)" },
            updates: {
              type: "array",
              description: "Step status changes; indexes are 0-based positions in the plan's steps array",
              items: {
                type: "object",
                properties: {
                  stepIndex: { type: "number", description: "0-based index into steps[]" },
                  status: { type: "string", enum: ["pending", "in_progress", "done", "skipped"] },
                  statusNote: { type: "string", description: "Optional one-liner shown beside the step (e.g. why skipped)" },
                },
                required: ["stepIndex", "status"],
              },
              minItems: 1,
            },
          },
          required: ["artifactId", "updates"],
        },
      },
      {
        name: "revise_artifact",
        annotations: { title: "Revise artifact", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Revise a prior artifact. `mode: 'supersede'` creates a v(N+1) draft linked via parentId (requires new `content`); the old flips to 'superseded'. `mode: 'retract'` marks the artifact 'retracted' with the reason.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifactId: { type: "string", description: "Id of the artifact being revised (art_...)." },
            mode: {
              type: "string",
              enum: ["supersede", "retract", "obsolete"],
              description: "'supersede' to replace with a v(N+1) draft; 'retract' to mark retracted (shouldn't have presented it); 'obsolete' to mark overcome by new information (it was valid but the discussion moved past it — use when you've moved on so it leaves the human's review queue).",
            },
            reason: { type: "string", description: "Brief explanation — shown to the human." },
            title: { type: "string", description: "(supersede only) Updated title. Defaults to the original title when omitted." },
            content: {
              type: "object",
              description: "(supersede only) Full content for the new version — same shape as the original present_* tool accepts.",
            },
          },
          required: ["artifactId", "mode", "reason"],
        },
      },
    ],
  }));

  // --- MCP resources ---
  //
  // Exposes the session's data as first-class MCP resources so the agent can
  // *pull* context (past artifacts, past sessions) instead of the server
  // shoving everything into every tool response. Useful when the human says
  // "remember what we decided about X last Tuesday" — the agent can browse
  // past sessions as resources rather than relying on the one-shot
  // firstCallHint memory dump.
  //
  // URIs:
  //   deeppairing://session/current            — full state of the active session
  //   deeppairing://artifact/{id}              — a single artifact in the active session
  //   deeppairing://sessions                   — index of past sessions in this project
  //   deeppairing://session/{id}               — full state of a past session

  // AA7b — typed optional methods on IStore (added in AA7a).
  const canListPast = typeof store.listPastSessions === "function";
  const canLoadPast = typeof store.loadPastSession === "function";

  // II11 — paginate the resource list. Pre-II11 the handler returned every
  // artifact in the active session + every past session unbounded; a long
  // pairing session with 500 artifacts shipped a 500-resource payload on
  // every list call. Strict MCP clients with hard caps (Cline, future
  // Claude Code with stricter list limits) choke. Cap at LIST_PAGE_SIZE
  // most-recent artifacts + expose a `nextCursor` so the agent can page if
  // it really needs older entries. The session-index resources
  // (deeppairing://sessions) and the current-session pointer are always
  // included on page 1 — those are O(1).
  const LIST_PAGE_SIZE = 100;
  // V1 — opaque (updatedAt|id) cursor. Pre-V1 the cursor was a
  // stringified offset over a sorted slice; if a new artifact landed
  // (or `revise_artifact` bumped `updatedAt`) between page reads, the
  // item that was at index N slid to N+1 and the next page would
  // skip it. Inverse on retracts/deletes. Now the cursor encodes the
  // last item's `(updatedAt, id)`; resume by filtering for entries
  // strictly older-or-tied-with-lower-id, which is monotonic under
  // insertions. Opaque base64 so clients can't accidentally depend
  // on the format and constrain a future migration.
  function encodeCursor(at: string, id: string): string {
    return Buffer.from(`${at}|${id}`, "utf-8").toString("base64");
  }
  function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
    if (typeof cursor !== "string" || !cursor) return null;
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf-8");
      const sep = decoded.indexOf("|");
      if (sep < 0) return null;
      return { at: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
    } catch {
      return null;
    }
  }

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const resources: Array<{ uri: string; name: string; description?: string; mimeType: string }> = [];
    const rawCursor = (request as any)?.params?.cursor;
    const cursor = decodeCursor(rawCursor);
    const isFirstPage = cursor === null;

    if (isFirstPage) {
      // II12 — onboarding resource. Carries the firstCallHint content
      // (rejected approaches, approved patterns, ledger snapshot, team
      // rules, autonomy hint). Pre-II12 this was spliced into the first
      // tool result's text field, which corrupted the result for strict
      // JSON-parsing clients. Now: read it once on session start, never
      // again. The hint is also delivered as a separate text content
      // block on the first write-tool result (see tool-result handler
      // below) so agents that don't list resources still get bootstrapped.
      // III2 — was `deeppairing://session/onboarding`. That URI
      // collided with the `session/{id}` regex below: a future past
      // session whose id happened to be "onboarding" (or a typo'd
      // cursor synthesizing one) would silently swallow the onboarding
      // read. Move to a top-level URI so the namespace is clean and
      // `session/` is exclusively for session ids.
      resources.push({
        uri: "deeppairing://onboarding",
        name: "Session onboarding — read first",
        description: "Rejected approaches, approved patterns, philosophy ledger snapshot, team rules, and autonomy hint. Read at session start so you know what's already off-limits before proposing anything.",
        mimeType: "text/plain",
      });

      // Current session pointer — only on page 1 (it's a fixed URI; paging
      // it would just duplicate the entry).
      resources.push({
        uri: "deeppairing://session/current",
        name: "Active session state",
        description: "Full JSON snapshot of the active session — artifacts, comments, decisions, plan reviews, autonomy level, session memory.",
        mimeType: "application/json",
      });
    }

    // Per-artifact resources — newest first (creation order is reverse
    // chronological for the LLM's "what changed recently?" query). Sort by
    // (updatedAt, id) so revisions float to the top of their page and
    // ties are deterministically ordered for the cursor compare.
    const allArtifacts = await store.getArtifacts();
    const orderedArtifacts = [...allArtifacts]
      .map((a) => ({ a, at: String((a as any).updatedAt ?? (a as any).createdAt ?? "") }))
      .sort((x, y) => {
        const cmp = y.at.localeCompare(x.at);
        return cmp !== 0 ? cmp : y.a.id.localeCompare(x.a.id);
      });

    // V1 — resume position: skip entries newer than (or tied at, with
    // a higher id than) the cursor. Older artifacts sort lower in our
    // newest-first order, so "still to read" = strictly older OR tied
    // with strictly-lower id. Filtering instead of slicing-by-offset
    // is what makes the cursor insertion-stable.
    const remaining = cursor
      ? orderedArtifacts.filter(({ a, at }) => {
          if (at < cursor.at) return true;
          if (at > cursor.at) return false;
          return a.id < cursor.id;
        })
      : orderedArtifacts;

    const pageArtifacts = remaining.slice(0, LIST_PAGE_SIZE);
    for (const { a } of pageArtifacts) {
      resources.push({
        uri: `deeppairing://artifact/${a.id}`,
        name: `${a.type}: ${a.title}`,
        description: `v${a.version} · ${a.status}${a.parentId ? ` · supersedes ${a.parentId}` : ""}`,
        mimeType: "application/json",
      });
    }
    const hasMoreArtifacts = remaining.length > LIST_PAGE_SIZE;
    const lastOnPage = pageArtifacts[pageArtifacts.length - 1];

    // Past sessions index — only on page 1. The index resource itself is
    // a single URI; agents who want individual past sessions read them on
    // demand rather than enumerating every session in the project.
    if (isFirstPage && canListPast) {
      resources.push({
        uri: "deeppairing://sessions",
        name: "Past sessions in this project",
        description: "Index of prior deepPairing sessions — titles, timestamps, artifact counts. Read to decide which past session to pull.",
        mimeType: "application/json",
      });

      try {
        // Cap past-session resources at LIST_PAGE_SIZE too so a project with
        // 1000 prior sessions doesn't blow the cap. The index resource above
        // gives the agent the full list when it actually needs to browse.
        const past = (await store.listPastSessions?.()) ?? [];
        const pastPage = past.slice(0, LIST_PAGE_SIZE);
        for (const s of pastPage) {
          if (s.id === store.getSessionId()) continue; // skip active
          resources.push({
            uri: `deeppairing://session/${s.id}`,
            name: `Past session: ${s.summary ?? s.id}`,
            description: `${s.artifactCount} artifacts · ${s.lastActivity ?? s.createdAt}`,
            mimeType: "application/json",
          });
        }
      } catch {
        // Listing failure is non-fatal; the index resource itself still works
      }
    }

    // MCP spec: omit nextCursor entirely when there's nothing left to page.
    // Sending an empty/null cursor would tempt some clients to re-list
    // forever.
    const result: { resources: typeof resources; nextCursor?: string } = { resources };
    if (hasMoreArtifacts && lastOnPage) {
      result.nextCursor = encodeCursor(lastOnPage.at, lastOnPage.a.id);
    }
    return result;
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    // II12 — onboarding resource. Rebuild the hint from current store
    // state so clients that read it mid-session see the latest rejected
    // approaches / autonomy level. The first-call splice path used a
    // snapshot frozen at first-tool-call time; the resource is always
    // fresh because it's computed on read.
    // III2 — top-level URI, not under session/. See ListResources for
    // the collision history.
    if (uri === "deeppairing://onboarding") {
      const text = await buildFirstCallHint(store, port);
      return {
        contents: [{ uri, mimeType: "text/plain", text: text || "(no onboarding context available yet)" }],
      };
    }

    if (uri === "deeppairing://session/current") {
      const state = await store.getFullState();
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state, null, 2) }],
      };
    }

    const artifactMatch = uri.match(/^deeppairing:\/\/artifact\/(.+)$/);
    if (artifactMatch) {
      const id = artifactMatch[1];
      const artifacts = await store.getArtifacts();
      const artifact = artifacts.find((a) => a.id === id);
      if (!artifact) {
        throw new Error(`Artifact not found: ${id}`);
      }
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(artifact, null, 2) }],
      };
    }

    if (uri === "deeppairing://sessions") {
      if (!canListPast) {
        return { contents: [{ uri, mimeType: "application/json", text: "[]" }] };
      }
      const past = (await store.listPastSessions?.()) ?? [];
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(past, null, 2) }],
      };
    }

    const sessionId = uri.match(/^deeppairing:\/\/session\/(.+)$/)?.[1];
    if (sessionId) {
      // III2 — defense-in-depth: even though we moved onboarding off
      // session/ at the source, an old client cache or hand-typed URI
      // could still hit session/onboarding. Reserved-name guard rejects
      // any session id that shadows a top-level URI fragment so the
      // collision the URI move was meant to prevent can't sneak back in
      // via a path different from the resource list.
      if (sessionId === "onboarding" || sessionId === "current") {
        throw new Error(
          `Reserved session id: '${sessionId}'. ` +
          (sessionId === "onboarding"
            ? "Read deeppairing://onboarding (top-level) for session onboarding."
            : "Read deeppairing://session/current for the active session."),
        );
      }
      if (!canLoadPast) {
        throw new Error("Past session reads require a DaemonClient store.");
      }
      const state = await store.loadPastSession!(sessionId);
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state, null, 2) }],
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  });

  // III12 — MCP prompts capability. We ship one prompt today (`recall`)
  // as the user-invocable slash-style surface for querying the
  // philosophy ledger. The `recall` tool stays for now (programmatic
  // agent calls); the prompt is the surface a user types into the host
  // chat ("/recall pay-per-request hosting" → returns a templated
  // user-message asking the agent to call recall + summarize). MCP
  // prompts are USER-driven (the host shows them in a / menu); MCP
  // tools are AGENT-driven (the LLM decides when to call them). The
  // architecture council flagged that `recall` is structurally a
  // slash-query, not an agent action — this is the right surface for
  // that use case and reclaims one tool-attention slot.
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "recall",
          description: "Query your philosophy ledger (cross-project stances) and past sessions. Surfaces what you've accumulated across deepPairing projects without burning a tool-attention slot in the agent.",
          arguments: [
            {
              name: "query",
              description: "Concept or substring to look up (e.g. 'pay-per-request hosting', 'global state for config'). Omit to list everything.",
              required: false,
            },
            {
              name: "mode",
              description: "Which surface to read: 'philosophy' (cross-project ledger), 'sessions' (past pairing sessions), or 'any' (both, merged). Defaults to 'any'.",
              required: false,
            },
          ],
        },
        // V2 — second MCP prompt. Mirrors the SeedAffordance UI: the
        // user names a stance they want to encode without going through
        // the agent + the present_options round-trip. Materialized as a
        // user-message that asks the agent to call the philosophy-seed
        // route with the right shape. Doesn't accept verdict because the
        // common case is rejection (the only direction we ship a UI for);
        // an "approve this pattern" prompt would dilute the meaning.
        {
          name: "seed",
          description: "Encode a stance you want the cross-project ledger to remember. The agent calls /api/philosophy/seed with what you provide; future preflights catch paraphrases of this stance across every deepPairing project on this machine.",
          arguments: [
            {
              name: "concept",
              description: "Short name for the pattern you're rejecting (e.g. 'global state for config', 'pay-per-request hosting'). This is the ledger key — keep it concept-shaped, not prose.",
              required: true,
            },
            {
              name: "reason",
              description: "Why you're rejecting it. One sentence is fine — the agent surfaces this in future preflight blocks so the future-you remembers the WHY.",
              required: false,
            },
          ],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    if (name === "recall") {
      const query = String(request.params.arguments?.query ?? "").trim();
      const mode = String(request.params.arguments?.mode ?? "any").trim();
      const queryHint = query ? ` for "${query}"` : "";
      const modeHint = mode && mode !== "any" ? ` (mode=${mode})` : "";
      return {
        description: `Recall philosophy + past-session context${queryHint}${modeHint}`,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Call the deepPairing \`recall\` tool with mode=${JSON.stringify(mode || "any")}` +
                (query ? ` and query=${JSON.stringify(query)}` : ` (no query — list everything)`) +
                `. Summarize the top entries plain-text: name, stance (avoid / prefer / mixed), citation count, ` +
                `the most representative reason. If nothing comes back, say so explicitly — don't fill the gap with speculation.`,
            },
          },
        ],
      };
    }
    if (name === "seed") {
      // V2 — concept is required; reason is optional but strongly
      // preferred (future preflight blocks read better with a reason).
      const concept = String(request.params.arguments?.concept ?? "").trim();
      if (!concept) {
        throw new Error("seed prompt requires a `concept` argument — the short name of the pattern you want to encode.");
      }
      const reason = String(request.params.arguments?.reason ?? "").trim();
      const reasonClause = reason
        ? `Reason: ${JSON.stringify(reason)}.`
        : `(No reason supplied — record it as a bare rejection; the user can amend later from the LedgerPanel.)`;
      return {
        description: `Seed philosophy stance: ${concept}`,
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `POST to /api/philosophy/seed with body {"verdict": "rejected", "concept": ${JSON.stringify(concept)}` +
                (reason ? `, "reason": ${JSON.stringify(reason)}` : ``) +
                `} so the cross-project ledger records the stance. ` +
                reasonClause +
                ` After the POST succeeds, confirm to the user: "Seeded — future preflights across every deepPairing project will catch paraphrases of this." ` +
                `If the POST fails (validation error or daemon unreachable), surface the exact error rather than retrying silently.`,
            },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${name}`);
  });

  // X4 — passive-feedback drain lives in tool-helpers.ts. The wrapper
  // closes over the per-server store so call sites stay terse.
  const getPassiveFeedback = () => getPassiveFeedbackHelper(store);

  // --- Call Tool ---
  let firstToolCall = true;
  // Tools that carry the first-call hint (the write/present tools). Defined in
  // the factory scope so the latch is consumed only when one of THESE is called
  // — a leading read (recall/check_feedback) must not burn the first-call hint
  // before the agent's first present_* gets it (the protocol preamble itself
  // tells the agent to `recall` first).
  const HINT_TOOLS: ReadonlySet<string> = new Set([
    "present_findings",
    "present_options",
    "present_spec",
    "present_plan",
    "present_code_change",
    "log_reasoning",
    "revise_artifact",
    "post_pr_review",
    "answer_question",
    "update_plan_progress",
  ]);
  // X4 — session-name latch encapsulates the once-only "rename the session
  // to the first artifact's title" behavior the closure used to handle.
  const sessionNameLatch = new SessionNameLatch(store);
  let checkFeedbackPollCount = 0;
  // FN2 — artifact ids whose rejection verdict has already been surfaced by
  // check_feedback, so a rejected code_change/spec/research is reported exactly
  // once. Comment-independent (catches feedback-less rejects) and self-limiting
  // (a rejected artifact is terminal — revise mints a new id).
  const reportedRejectedVerdicts = new Set<string>();
  // B3 — plan verdicts already reflected in structuredContent.status (the
  // prose keeps repeating them; the machine-readable status must decay).
  const reportedPlanVerdicts = new Set<string>();

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    // First tool call hint — also deliver session memory HERE (not inside
    // check_feedback) so the agent knows rejected approaches / approved
    // patterns BEFORE it tries to present anything. Prevents the "WAITING +
    // warning" ambiguity where the agent couldn't tell whether to keep polling
    // or retract a proposal.
    let firstCallHint = "";
    // II12.1 — consume the latch only on the first HINT_TOOL call. Previously
    // it flipped on the first call of ANY tool, so a leading read
    // (recall/check_feedback) discarded the built hint and the agent's first
    // present_* got nothing — which would routinely drop the protocol preamble.
    if (firstToolCall && HINT_TOOLS.has(name)) {
      firstToolCall = false;
      // X4 — full assembly lives in mcp/first-call-hint.ts; the BLOCKING +
      // CONTEXTUAL tiering, the HINT_BUDGET_CHARS cap, and the recall
      // pointer all moved with it. The handler here just dispatches.
      firstCallHint = await buildFirstCallHint(store, port);
    }

    // X4 — per-call helpers extracted to mcp/tool-helpers.ts. These thin
    // wrappers preserve the call-site signatures the tool cases were
    // written against, so the case bodies didn't have to change.
    const tryElicit = (message: string) => tryElicitHelper(server, message);
    const preflightRejectedApproaches = (
      toolName: string,
      proposalStrings: string[],
      proposalPaths: string[] = [],
      proposalConcepts: string[] = [],
    ) => preflightHelper(store, broadcast, toolName, proposalStrings, proposalPaths, proposalConcepts);
    const autoNameSession = (title: string) => sessionNameLatch.maybeName(title);

    // X4 — ToolContext for handlers extracted to tools/. Cases that still
    // live in this switch can ignore it; new extractions just pull from ctx.
    // The mutable poll counter lives in `state` so the check_feedback
    // handler can write to it via reference once that case is extracted.
    const ctx: ToolContext = {
      server,
      store,
      broadcast,
      port,
      helpers: {
        tryElicit,
        preflightRejectedApproaches,
        autoNameSession,
        getPassiveFeedback,
      },
      state: {
        get checkFeedbackPollCount() { return checkFeedbackPollCount; },
        set checkFeedbackPollCount(v) { checkFeedbackPollCount = v; },
        reportedRejectedVerdicts,
        reportedPlanVerdicts,
      },
      // B3 — per-request progress token for check_feedback's heartbeats.
      progressToken: request.params._meta?.progressToken,
    };

    const result = await (async () => { switch (name) {
      case "present_findings":
        return handlePresentFindings(ctx, args);

      case "present_options":
        return handlePresentOptions(ctx, args);

      case "present_spec":
        return handlePresentSpec(ctx, args);

      case "present_plan":
        return handlePresentPlan(ctx, args);

      case "log_reasoning":
        return handleLogReasoning(ctx, args);

      case "present_code_change":
        return handlePresentCodeChange(ctx, args);

      case "check_feedback":
        // B3 — extracted to mcp/tools/check-feedback.ts (the last big inline
        // case, ~405 lines). Also gained structuredContent (see the tool
        // file) — the outputSchema lives on the ListTools entry above.
        return handleCheckFeedback(ctx, args);

      // III12 — case "request_horizon_check" removed. The workflow
      // (post a question on an artifact with a templated horizon prompt)
      // is now: call addComment / answer_question with the horizon
      // template as the question text. The deeppairing.md skill carries
      // the templates so the LLM still has them available.

      case "update_plan_progress":
        return await handleUpdatePlanProgress(ctx, args);
      case "answer_question":
        // B3 — extracted to mcp/tools/answer-question.ts.
        return handleAnswerQuestion(ctx, args);

      case "revise_artifact":
        // B3 — extracted to mcp/tools/revise-artifact.ts (incl. the F3
        // SUPERSEDE_VALIDATORS table).
        return handleReviseArtifact(ctx, args);

      case "recall":
        // CC10 — handler extracted to mcp/tools/recall.ts (~190 LOC out
        // of server.ts). Matches the present-*.ts split.
        return handleRecall(ctx, args);

      case "post_pr_review":
        // B3 — extracted to mcp/tools/post-pr-review.ts.
        return handlePostPrReview(ctx, args);

      case "export_session":
        return handleExportSession(ctx, args);

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    } })();

    // Y2 — gate firstCallHint to write tools only. Pre-Y2 the hint
    // appended to EVERY tool's first response, including reads. That meant:
    // - First call is `recall` (mode=philosophy) → result + duplicated
    //   philosophy ledger spliced in underneath itself.
    // - First call is `export_session` → markdown the user wants to grab,
    //   contaminated with "[First use this session]" + rejected-approach
    //   lists they don't want in the export.
    // - First call is `check_feedback` → polling preamble buried under a
    //   wall of context the agent already had on session start.
    //
    // The hint is meant for tools that WRITE (the agent is about to
    // create artifacts; rejected approaches matter). Read-only and
    // pull-style tools shouldn't carry it.
    // AA6.1 — answer_question writes comments and motivates exactly the
    // rejected-approach context the hint carries (the agent might
    // re-introduce a stance in its answer text). III12 — dropped
    // request_horizon_check from this allowlist when the tool itself
    // was removed; the horizon-check workflow now flows through
    // answer_question / addComment which are already covered.
    // HINT_TOOLS is defined in the factory scope above (the latch is consumed
    // only on these tools, so a leading read doesn't drop the hint).
    // II12 — was: `first.text = first.text + firstCallHint` (splice the
    // hint into the same text field as the tool result). Strict MCP
    // clients that parse tool result content[0].text as the tool's reply
    // got onboarding context mixed into the message — a parsing footgun.
    // Now: push the hint as a SEPARATE text content block. Lenient clients
    // render both; strict parsers can pick content[0] for the tool reply
    // and content[1+] for ambient context. The same hint is also exposed
    // as a `deeppairing://onboarding` resource (added below) for
    // clients that prefer the resource model.
    // III1 — gate on !result.isError. Pre-III1 the push fired on every
    // tool reply with a content[] array, including the ~17 isError:true
    // validation/preflight-reject returns. That meant a malformed first
    // write call got "INPUT_VALIDATION_FAILED: ..." followed by a 4KB
    // onboarding dump — exactly the parsing footgun II12 was supposed to
    // retire, just on the error branch. Tool errors must stay clean so
    // the agent can decide what to do without paragraphs of distraction.
    if (
      firstCallHint &&
      HINT_TOOLS.has(name) &&
      result?.content &&
      Array.isArray(result.content) &&
      !result.isError
    ) {
      result.content.push({ type: "text", text: firstCallHint });
    }
    return result;
  });

  return {
    server,
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}
