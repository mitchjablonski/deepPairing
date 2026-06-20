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
import { nanoid } from "nanoid";
import type { IStore, RejectedApproach } from "../store/store-interface.js";
import { buildGitHubReviewPayload } from "../export/format-markdown.js";
import { getGlobalStore, deriveStance } from "../store/global-store.js";
import { postPrReview, GhMissingError, GhNotAuthedError } from "../github/post-review.js";
import { maybeEmitTaskHandle, maybeUpdateTaskStatus } from "./tasks-probe.js";
import { buildFirstCallHint } from "./first-call-hint.js";
import {
  tryElicit as tryElicitHelper,
  preflightRejectedApproaches as preflightHelper,
  SessionNameLatch,
  getPassiveFeedback as getPassiveFeedbackHelper,
  notifyResourcesListChanged,
} from "./tool-helpers.js";
import { handleLogReasoning } from "./tools/log-reasoning.js";
import { handleExportSession } from "./tools/export-session.js";
import { handlePresentFindings } from "./tools/present-findings.js";
import { handlePresentOptions } from "./tools/present-options.js";
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
export const matchesGlob = _matchesGlob;

type BroadcastFn = (event: any) => void;

export function createMcpServer(store: IStore, broadcast: BroadcastFn, port = 3847) {
  const server = new Server(
    { name: "deeppairing", version: "0.1.0" },
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
        description:
          `Present research findings as a structured artifact in the companion UI (${port ? `localhost:${port}` : ""}). Each finding carries evidence, category, significance, severity.` +
          `\n\nSchema note: \`findings\` is an array of objects (NOT a string). Required per-finding: category, detail, significance. Validation runs at the boundary; mismatch returns INPUT_VALIDATION_FAILED with the bad path + an example.` +
          `\n\nWorkflow: SINGLE REVIEW SURFACE — the companion UI is the only review surface. Don't paste findings in chat; call check_feedback for the verdict.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "Descriptive title for this research artifact (e.g., 'Authentication System Analysis', 'Database Performance Audit')" },
            summary: { type: "string", description: "Brief summary of findings" },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string" },
                  title: { type: "string" },
                  detail: { type: "string" },
                  evidence: { description: "Code snippets with explanations — use rich format" },
                  significance: { type: "string", enum: ["low", "medium", "high"], description: "How note-worthy this finding is" },
                  severity: {
                    type: "string",
                    enum: ["info", "low", "medium", "high", "critical"],
                    description: "Risk level if unaddressed — helps the human prioritize what to study first. Distinct from significance.",
                  },
                  confidence: { type: "string", enum: ["low", "medium", "high"], description: "How confident are you in this finding?" },
                  impact: { type: "string" },
                  recommendation: { type: "string" },
                },
                required: ["category", "detail", "significance"],
              },
            },
            openQuestions: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "findings"],
        },
      },
      {
        name: "present_options",
        description:
          "Present 2–4 options with pros/cons/effort/risk for the human to choose. Y5: each option SHOULD include `concept` ({name, oneLineExplanation?}) — the underlying pattern (e.g. 'external cache service'). Concepts make rejections compound across projects via the philosophy ledger." +
          "\n\nSchema note: `options` is an array of 2–4 objects. `concept` optional but strongly preferred. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — human selects in the companion UI; don't list options in chat. Call check_feedback for the selection. FF9 — stakes='high' enables opt-in prediction capture; check_feedback MAY include optional `predictedOutcome` + `confidence`.",
        inputSchema: {
          type: "object" as const,
          properties: {
            context: { type: "string", description: "What decision needs to be made" },
            stakes: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Consequentiality — on 'high' the UI offers an opt-in prediction-capture toggle (FF9). When the human enables it for a particular pick, the resolved decision carries `predictedOutcome` and `confidence`; otherwise both fields are absent.",
            },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  description: { type: "string" },
                  pros: { type: "array", items: { type: "string" } },
                  cons: { type: "array", items: { type: "string" } },
                  effort: { type: "string", enum: ["low", "medium", "high"] },
                  risk: { type: "string", enum: ["low", "medium", "high"] },
                  recommendation: { type: "boolean" },
                  concept: {
                    type: "object",
                    description: "Y5 — the underlying pattern, named so rejections compound across projects",
                    properties: {
                      name: { type: "string", description: "Short concept name, e.g. 'argon2id for password hashing'" },
                      oneLineExplanation: { type: "string", description: "Plain-English so the human learns the pattern, not just the option" },
                    },
                    required: ["name"],
                  },
                },
                required: ["id", "title", "description", "pros", "cons", "effort", "risk", "recommendation"],
              },
              minItems: 2,
              maxItems: 4,
            },
          },
          required: ["context", "options"],
        },
      },
      {
        name: "present_spec",
        description:
          "Present a feature spec — objective, requirements (each with rationale + acceptance criteria), optional design notes and tasks. For non-trivial work that'd otherwise skip straight to code without agreement on what's being built." +
          "\n\nSchema note: `requirements` is a non-empty array of objects with `id`, `statement`, `rationale`, `acceptanceCriteria`. VISUALS (encouraged): attach `visuals[]` — each a stable `id`, a `kind` (diagram/file_map/prototype/annotated_code; see inputSchema), and `title`. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — the companion UI is where the human reviews requirements. Don't re-paste in chat. Call check_feedback for the verdict.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "Short descriptive title, e.g. 'Auth rate limiting'" },
            objective: { type: "string", description: "One-sentence objective this spec is chasing" },
            context: { type: "string", description: "Background / constraints / existing system notes" },
            requirements: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable identifier within this spec, e.g. 'REQ-1'" },
                  statement: { type: "string", description: "WHAT, in one sentence" },
                  rationale: { type: "string", description: "WHY — the reason this requirement exists (teaching moment)" },
                  acceptanceCriteria: {
                    type: "array",
                    items: { type: "string" },
                    description: "Testable conditions that satisfy this requirement",
                  },
                  priority: { type: "string", enum: ["must", "should", "could"] },
                },
                required: ["id", "statement", "rationale", "acceptanceCriteria"],
              },
            },
            design: { type: "string", description: "High-level design notes — not a full design doc" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  linkedRequirementIds: { type: "array", items: { type: "string" } },
                  estimate: { type: "string", enum: ["xs", "s", "m", "l", "xl"] },
                },
                required: ["description"],
              },
            },
            openQuestions: { type: "array", items: { type: "string" }, description: "Things you need the human to decide before proceeding" },
            visuals: {
              type: "array",
              description: "Diagrams / file maps / annotated code / prototypes that frame the spec. Encouraged.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable id — keep it across revisions so comment threads survive" },
                  kind: { type: "string", enum: ["diagram", "file_map", "prototype", "annotated_code"] },
                  title: { type: "string" },
                  caption: { type: "string" },
                  source: { type: "string", description: "kind='diagram': Mermaid source" },
                  files: {
                    type: "array",
                    description: "kind='file_map': planned file operations",
                    items: {
                      type: "object",
                      properties: {
                        path: { type: "string" },
                        change: { type: "string", enum: ["create", "modify", "delete"] },
                        note: { type: "string" },
                      },
                      required: ["path"],
                    },
                  },
                  html: { type: "string", description: "kind='prototype': self-contained HTML (rendered sandboxed)" },
                  code: { type: "string", description: "kind='annotated_code': the real code snippet to show + annotate" },
                  filePath: { type: "string", description: "kind='annotated_code': source path (drives highlighting + per-line comments)" },
                  language: { type: "string", description: "kind='annotated_code': override language inferred from filePath" },
                  lineStart: { type: "number", description: "kind='annotated_code': line number of the snippet's first line (default 1)" },
                  annotations: {
                    type: "array",
                    description: "kind='annotated_code': line-anchored explanations",
                    items: {
                      type: "object",
                      properties: {
                        line: { type: "number", description: "absolute line number (within the snippet's lineStart range)" },
                        note: { type: "string" },
                        kind: { type: "string", enum: ["add", "change", "remove", "context"] },
                      },
                      required: ["line", "note"],
                    },
                  },
                },
                required: ["id", "kind"],
              },
            },
          },
          required: ["title", "objective", "requirements"],
        },
      },
      {
        name: "present_plan",
        description:
          "Present an implementation plan as steps with file changes and before/after previews." +
          "\n\nSchema note: `steps` needs `description` + `reasoning` each. VISUALS (encouraged): attach `visuals[]` so the human reviews a picture — each a stable `id` (keep across revisions), a `kind` (diagram/file_map/prototype/annotated_code; see inputSchema), and `title`. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — this REPLACES Claude Code's native plan-approval flow. Do NOT call ExitPlanMode after present_plan. The companion UI is the only approval surface; call check_feedback for the verdict.",
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  files: { description: "Files affected" },
                  reasoning: { type: "string" },
                  motivatedBy: { type: "array", items: { type: "string" } },
                  preview: {
                    type: "object",
                    properties: {
                      before: { type: "string" },
                      after: { type: "string" },
                      filePath: { type: "string" },
                    },
                  },
                  condition: { type: "string", description: "Condition for this step (e.g., 'if tests pass'). Makes this a conditional branch." },
                  branches: {
                    type: "array",
                    description: "Sub-steps that execute if the condition is met",
                    items: {
                      type: "object",
                      properties: {
                        description: { type: "string" },
                        files: { description: "Files affected" },
                        reasoning: { type: "string" },
                      },
                      required: ["description", "reasoning"],
                    },
                  },
                },
                required: ["description", "reasoning"],
              },
            },
            estimatedChanges: { type: "number" },
            visuals: {
              type: "array",
              description: "Diagrams / file maps / annotated code / prototypes that frame the plan. Strongly encouraged.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Stable id — keep it across revisions so comment threads survive" },
                  kind: { type: "string", enum: ["diagram", "file_map", "prototype", "annotated_code"] },
                  title: { type: "string" },
                  caption: { type: "string" },
                  source: { type: "string", description: "kind='diagram': Mermaid source" },
                  files: {
                    type: "array",
                    description: "kind='file_map': planned file operations",
                    items: {
                      type: "object",
                      properties: {
                        path: { type: "string" },
                        change: { type: "string", enum: ["create", "modify", "delete"] },
                        note: { type: "string" },
                      },
                      required: ["path"],
                    },
                  },
                  html: { type: "string", description: "kind='prototype': self-contained HTML (rendered sandboxed)" },
                  code: { type: "string", description: "kind='annotated_code': the real code snippet to show + annotate" },
                  filePath: { type: "string", description: "kind='annotated_code': source path (drives highlighting + per-line comments)" },
                  language: { type: "string", description: "kind='annotated_code': override language inferred from filePath" },
                  lineStart: { type: "number", description: "kind='annotated_code': line number of the snippet's first line (default 1)" },
                  annotations: {
                    type: "array",
                    description: "kind='annotated_code': line-anchored explanations",
                    items: {
                      type: "object",
                      properties: {
                        line: { type: "number", description: "absolute line number (within the snippet's lineStart range)" },
                        note: { type: "string" },
                        kind: { type: "string", enum: ["add", "change", "remove", "context"] },
                      },
                      required: ["line", "note"],
                    },
                  },
                },
                required: ["id", "kind"],
              },
            },
          },
          required: ["title", "steps", "estimatedChanges"],
        },
      },
      {
        name: "log_reasoning",
        description:
          "Log the reasoning for an action before taking it. Pairs with present_code_change for the per-edit checkpoint cadence (WHY + WHAT — together they give the human a chance to redirect BEFORE the diff is on disk)." +
          "\n\nSchema note: required: `action`, `reasoning`. Name the underlying concept in `concept` whenever one applies — that's the human's learning lever. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: REQUIRED BEFORE EACH SIGNIFICANT EDIT. Don't just chat-explain.",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", description: "What you're about to do, in plain English" },
            reasoning: { type: "string", description: "Why this approach" },
            concept: {
              type: "object",
              description:
                "The named concept or pattern this reasoning applies. Name the concept whenever one applies — this is how the human learns.",
              properties: {
                name: { type: "string", description: "Concept name (e.g. 'dependency inversion', 'optimistic UI')" },
                oneLineExplanation: {
                  type: "string",
                  description: "One-sentence plain-English definition, for readers who may not know the concept",
                },
              },
              required: ["name"],
            },
            evidence: {
              type: "array",
              description: "Files / line ranges that motivated this reasoning step",
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
            relatesTo: {
              type: "object",
              description: "Back-link to another artifact this reasoning elaborates, answers, or supersedes",
              properties: {
                artifactId: { type: "string" },
                kind: { type: "string", enum: ["elaborates", "answers", "supersedes"] },
              },
              required: ["artifactId", "kind"],
            },
            alternativesConsidered: { type: "array", items: { type: "string" } },
            alternativeDetails: {
              type: "array",
              description: "Structured alternatives with rejection reasons",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  reason: { type: "string", description: "Why this alternative was rejected" },
                },
                required: ["title", "reason"],
              },
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          // `confidence` is optional in ReasoningContentSchema and the tool's
          // own description says required: action, reasoning. Keep the JSON
          // schema consistent so strict MCP clients don't reject valid calls.
          required: ["action", "reasoning"],
        },
      },
      {
        name: "check_feedback",
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
      },
      {
        name: "present_code_change",
        description:
          "Present a code change as a before/after diff with reasoning. Y5: include `concept` ({name, oneLineExplanation?}) — name the pattern (e.g. 'work factor tuning') so cross-project preflight matches it." +
          "\n\nSchema note: required: `filePath`, `changeType`, `after`, `reasoning`. `concept` strongly preferred. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: REQUIRED BEFORE EACH Write/Edit/MultiEdit on a file not yet approved this session — per-edit checkpoint, not one-shot. Batched implementation skipping checkpoints is a protocol violation. SINGLE REVIEW SURFACE — companion UI only, don't paste in chat. Call check_feedback for the verdict.",
        inputSchema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "File being changed" },
            changeType: { type: "string", enum: ["create", "modify", "delete"], description: "Type of change" },
            before: { type: "string", description: "Code before the change (empty for create)" },
            after: { type: "string", description: "Code after the change (empty for delete)" },
            reasoning: { type: "string", description: "Why this change is being made" },
            confidence: { type: "string", enum: ["low", "medium", "high"], description: "How confident are you in this change?" },
            relatedFindings: { type: "array", items: { type: "string" }, description: "Artifact IDs of findings that motivated this" },
            concept: {
              type: "object",
              description: "Y5 — the underlying pattern, named so cross-project preflight can match against past stances",
              properties: {
                name: { type: "string", description: "Short concept name, e.g. 'optimistic UI rollback'" },
                oneLineExplanation: { type: "string", description: "Plain-English so the human learns the pattern" },
              },
              required: ["name"],
            },
          },
          required: ["filePath", "changeType", "after", "reasoning"],
        },
      },
      {
        name: "recall",
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
        name: "revise_artifact",
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

    const sessionMatch = uri.match(/^deeppairing:\/\/session\/(.+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
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
  ]);
  // X4 — session-name latch encapsulates the once-only "rename the session
  // to the first artifact's title" behavior the closure used to handle.
  const sessionNameLatch = new SessionNameLatch(store);
  let checkFeedbackPollCount = 0;

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
    ) => preflightHelper(store, broadcast, toolName, proposalStrings, proposalPaths);
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
      } as any,
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

      case "check_feedback": {
        // BB3 — `waitFor` scopes which feedback signal counts as "ready".
        // The agent can pin its poll to the artifact it just presented
        // (e.g. waitFor='decision' after present_options) so an unrelated
        // comment elsewhere doesn't wake the poll prematurely. Default
        // 'any' preserves the historical broad behavior.
        const waitForRaw = typeof args.waitFor === "string" ? args.waitFor : "any";
        const waitForScope: "any" | "comments" | "decision" | "plan_review" | "artifact_status" =
          (["any", "comments", "decision", "plan_review", "artifact_status"] as const).includes(
            waitForRaw as any,
          )
            ? (waitForRaw as any)
            : "any";

        // If no immediate feedback exists, long-poll for up to 30 seconds
        const unackComments = await store.getUnacknowledgedComments();
        const resolvedDecs = await store.getResolvedDecisions();
        const allArtsForScope = await store.getArtifacts();
        const decidedPlans = allArtsForScope.filter(
          (a) => a.type === "plan" && (a.status === "approved" || a.status === "revised" || a.status === "rejected"),
        );
        const decidedAny = allArtsForScope.filter(
          (a) => a.status === "approved" || a.status === "revised" || a.status === "rejected",
        );

        const hasImmediateFor = (scope: typeof waitForScope): boolean => {
          switch (scope) {
            case "comments": return unackComments.length > 0;
            case "decision": return resolvedDecs.length > 0;
            case "plan_review": return decidedPlans.length > 0;
            case "artifact_status": return decidedAny.length > 0 || resolvedDecs.length > 0;
            case "any":
            default:
              return unackComments.length > 0 || resolvedDecs.length > 0;
          }
        };
        const hasImmediate = hasImmediateFor(waitForScope);

        if (!hasImmediate) {
          // Check if there are draft artifacts — if so, wait for human action
          const allArts = allArtsForScope;
          const hasDrafts = allArts.some(
            (a) => a.status === "draft" && ["research", "spec", "plan", "decision", "code_change"].includes(a.type),
          );
          if (hasDrafts) {
            // Send progress heartbeats during the wait to keep the connection alive
            const progressToken = request.params._meta?.progressToken;
            let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
            if (progressToken != null) {
              let tick = 0;
              heartbeatTimer = setInterval(() => {
                tick++;
                server.notification({
                  method: "notifications/progress",
                  params: { progressToken, progress: tick, total: 3, message: "Waiting for human review..." },
                });
              }, 10000);
            }

            // Long-poll: wait up to 30s for feedback to arrive
            await store.waitForFeedback(30000);

            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }
        }

        const parts: string[] = [];

        // Track consecutive empty polls for escalation
        const newComments = await store.getUnacknowledgedComments();
        const newResolved = await store.getResolvedDecisions();
        const hasNewFeedback = newComments.length > 0 || newResolved.length > 0;
        if (hasNewFeedback) {
          checkFeedbackPollCount = 0;
        } else {
          checkFeedbackPollCount++;
        }

        // CC5 — respect waitFor scope post-wake. BB3 added the entry-guard
        // branching but waitForFeedback still wakes on ANY feedback signal,
        // and the response below assembles ALL comments + decisions. So an
        // agent calling waitFor='decision' could be woken by an unrelated
        // comment, fall through, and get a response stuffed with comments
        // it explicitly said it wasn't waiting for. Re-check the scope with
        // the fresh post-wake data; if it's narrow and unsatisfied, return
        // a focused "still waiting" status instead of dumping out-of-scope
        // chatter at the agent.
        if (waitForScope !== "any") {
          const allArtsPostWake = await store.getArtifacts();
          const decidedPlansPostWake = allArtsPostWake.filter(
            (a) => a.type === "plan" && (a.status === "approved" || a.status === "revised" || a.status === "rejected"),
          );
          const decidedAnyPostWake = allArtsPostWake.filter(
            (a) => a.status === "approved" || a.status === "revised" || a.status === "rejected",
          );
          const scopeSatisfied = (() => {
            switch (waitForScope) {
              case "comments": return newComments.length > 0;
              case "decision": return newResolved.length > 0;
              case "plan_review": return decidedPlansPostWake.length > 0;
              case "artifact_status": return decidedAnyPostWake.length > 0 || newResolved.length > 0;
              default: return true;
            }
          })();
          if (!scopeSatisfied) {
            return {
              content: [{
                type: "text",
                text: `Still waiting on '${waitForScope}'. Nothing matching that scope arrived during the 30s poll. Call check_feedback again with the same waitFor (or with waitFor='any' to drain unrelated chatter).`,
              }],
            };
          }
        }

        // --- Session status preamble ---
        const allArtifacts = await store.getArtifacts();
        const totalArtifacts = allArtifacts.length;
        const approvedCount = allArtifacts.filter((a) => a.status === "approved").length;
        const pendingCount = allArtifacts.filter((a) => a.status === "draft" && ["research", "spec", "plan", "decision"].includes(a.type)).length;
        const totalComments = (await store.getUnacknowledgedComments()).length;
        const autonomyLabel = await store.getAutonomyLevel();

        // Find oldest pending artifact age
        let oldestPendingAge = "";
        const pendingArts = allArtifacts.filter((a) => a.status === "draft" && ["research", "spec", "plan", "decision"].includes(a.type));
        if (pendingArts.length > 0) {
          const oldestMs = Date.now() - new Date(pendingArts[0].createdAt).getTime();
          const mins = Math.floor(oldestMs / 60000);
          const secs = Math.floor((oldestMs % 60000) / 1000);
          oldestPendingAge = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        }

        // Determine suggested action
        let suggestedAction = "You may proceed with implementation.";
        if (pendingArts.some((a) => a.type === "decision")) {
          suggestedAction = "Wait for decision selection before proceeding.";
        } else if (pendingArts.some((a) => a.type === "plan")) {
          suggestedAction = "Wait for plan approval before implementing.";
        } else if (pendingArts.some((a) => a.type === "spec")) {
          suggestedAction = "Wait for spec approval before planning implementation.";
        } else if (pendingArts.some((a) => a.type === "research")) {
          suggestedAction = "Wait for findings review before proposing solutions.";
        }

        parts.push(`Session: ${totalArtifacts} artifact${totalArtifacts !== 1 ? "s" : ""} (${approvedCount} approved, ${pendingCount} pending) | ${totalComments} new comment${totalComments !== 1 ? "s" : ""} | ${autonomyLabel} mode${oldestPendingAge ? `\nOldest pending: ${oldestPendingAge}` : ""}\nSuggested action: ${suggestedAction}`);

        // Unacknowledged comments
        const allComments = await store.getUnacknowledgedComments();
        const sessionMessages = allComments.filter((c) => c.target.artifactId === "__session__");
        const artifactComments = allComments.filter((c) => c.target.artifactId !== "__session__");

        // Session-level directives (free-form messages from human)
        if (sessionMessages.length > 0) {
          await store.acknowledgeComments(sessionMessages.map((c) => c.id));
          const formatted = sessionMessages.map((c) => `- ${c.content}`).join("\n");
          parts.push(`🎯 Human directive:\n${formatted}\n\nAdjust your approach based on this guidance.`);
        }

        // Artifact-specific comments — split questions (unanswered) out first
        // since they carry a response obligation the agent can honor with
        // answer_question. Regular comments / suggestions follow.
        const artifactCommentsSorted = artifactComments.slice().sort((a, b) => {
          const aIsQ = (a as any).intent === "question" && !(a as any).answeredByCommentId ? 0 : 1;
          const bIsQ = (b as any).intent === "question" && !(b as any).answeredByCommentId ? 0 : 1;
          return aIsQ - bIsQ;
        });
        if (artifactCommentsSorted.length > 0) {
          await store.acknowledgeComments(artifactCommentsSorted.map((c) => c.id));
          const questionLines: string[] = [];
          const otherLines: string[] = [];
          for (const c of artifactCommentsSorted) {
            let loc = c.target.artifactId;
            if ((c.target as any).lineStart) loc += `:${(c.target as any).lineStart}`;
            if ((c.target as any).findingIndex != null) loc += ` (finding #${(c.target as any).findingIndex + 1})`;

            if ((c as any).intent === "question" && !(c as any).answeredByCommentId) {
              questionLines.push(
                `- ❓ QUESTION [${loc}] ${c.content}\n    → Answer via answer_question with commentId="${c.id}"`,
              );
              continue;
            }
            if ((c.target as any).suggestion) {
              const filePath = (c.target as any).filePath ?? "unknown";
              const line = (c.target as any).lineStart ?? "?";
              otherLines.push(`- [SUGGESTION for ${filePath}:${line}] Replace with:\n    ${(c.target as any).suggestion}`);
              continue;
            }
            otherLines.push(`- [${loc}] ${c.content}`);
          }
          if (questionLines.length > 0) {
            parts.push(`Human questions (${questionLines.length}) — answer these before proceeding:\n${questionLines.join("\n")}`);
          }
          if (otherLines.length > 0) {
            parts.push(`Human comments (${otherLines.length}):\n${otherLines.join("\n")}`);
          }
        }

        // Resolved decisions (acknowledge so they don't repeat)
        const resolved = await store.getResolvedDecisions();
        if (resolved.length > 0) {
          await store.acknowledgeDecisions(resolved.map((d) => d.decisionId));
          const formattedDecisions: string[] = [];
          for (const d of resolved) {
            const option = d.options.find((o: any) => o.id === d.response?.optionId);
            if (option) {
              const approvedDescription = `${d.context}: ${option.title}`;
              // AA1 — concept.name (from Y5) is the cross-project ledger key.
              // Pre-AA1 we passed option.description here, which is prose
              // and broke compounding (every project minted unique long
              // keys instead of bucketing under e.g. "argon2id for password
              // hashing"). Fall back to description for older agents that
              // don't supply concept.
              const approvedConcept: string | undefined =
                (option as any)?.concept?.name ?? option?.description ?? undefined;
              await store.recordApprovedPattern({
                description: approvedDescription,
                concept: approvedConcept,
              });
              broadcast({
                type: "ledger_write",
                kind: "approved",
                description: approvedDescription,
                concept: approvedConcept,
                sourceArtifactId: d.artifactId,
              });
              const rejected = d.options.filter((o: any) => o.id !== d.response?.optionId);
              for (const rej of rejected) {
                const rejectedDescription = `${d.context}: ${rej.title}`;
                // AA1 — read concept from the REJECTED option, not the
                // winning one. Each option carries its own pattern; the
                // rejection should compound under the rejected option's
                // concept, not the winner's.
                const rejectedConcept: string | undefined =
                  (rej as any)?.concept?.name ?? rej?.description ?? undefined;
                await store.recordRejectedApproach({
                  description: rejectedDescription,
                  reason: d.response?.reasoning,
                  sourceArtifactId: d.artifactId,
                  concept: rejectedConcept,
                });
                broadcast({
                  type: "ledger_write",
                  kind: "rejected",
                  description: rejectedDescription,
                  concept: rejectedConcept,
                  reason: d.response?.reasoning,
                  sourceArtifactId: d.artifactId,
                });
              }
              // O7: high-stakes decisions also fire a "decision_resolved_hero"
              // event so the UI can toast the captured prediction — otherwise
              // the prediction disappears into the decision record.
              const stakes = (d as any).stakes ?? (d as any).request?.stakes;
              if (stakes === "high" && d.response?.predictedOutcome) {
                broadcast({
                  type: "decision_resolved_hero",
                  artifactId: d.artifactId,
                  context: d.context,
                  chosenTitle: option.title,
                  predictedOutcome: d.response.predictedOutcome,
                  confidence: (d.response as any).confidence,
                });
              }
            }
            formattedDecisions.push(`- Decision "${d.context}": selected "${option?.title ?? d.response?.optionId}"${d.response?.reasoning ? ` (reasoning: ${d.response.reasoning})` : ""}`);
          }
          parts.push(`Decision selections:\n${formattedDecisions.join("\n")}`);
        }

        // Plan review verdicts
        const pendingPlans = await store.getPendingPlanReviews();
        const planArtifacts = (await store.getArtifacts()).filter((a) => a.type === "plan");
        const reviewedPlans: string[] = [];
        for (const a of planArtifacts) {
          const verdict = await store.getPlanReviewVerdict(a.id);
          if (!verdict) continue;
          reviewedPlans.push(`- Plan "${a.title}": ${verdict.verdict}${verdict.feedback ? ` (feedback: ${verdict.feedback})` : ""}`);
        }
        if (reviewedPlans.length > 0) {
          parts.push(`Plan reviews:\n${reviewedPlans.join("\n")}`);
        }

        // Check for draft artifacts still awaiting human review
        const draftArtifacts = (await store.getArtifacts()).filter(
          (a) => a.status === "draft" && ["research", "spec", "plan"].includes(a.type),
        );
        if (draftArtifacts.length > 0) {
          const waiting = draftArtifacts.map((a) => `"${a.title}" (${a.type})`).join(", ");
          parts.push(`⏳ WAITING: ${draftArtifacts.length} artifact(s) still under review: ${waiting}\nThe human is reviewing in the companion UI. Call check_feedback again to pick up their response.`);
        }

        const pendingDec = await store.getPendingDecisions();
        if (pendingDec.length > 0) {
          parts.push(`⏳ WAITING: ${pendingDec.length} decision(s) pending. The human will select in the companion UI. Call check_feedback again to pick up their choice.`);
        }
        if (pendingPlans.length > 0) {
          parts.push(`⏳ WAITING: ${pendingPlans.length} plan review(s) pending. The human will review in the companion UI. Call check_feedback again to pick up their verdict.`);
        }

        // Session memory is delivered once on the very first tool call (see
        // firstCallHint above). Intentionally NOT repeated here — mixing
        // WAITING signals with past-violation warnings creates contradictory
        // imperatives ("keep polling" vs "fix the violation now"). Pre-flight
        // validation in present_* tools is the enforcement point.

        // Always include autonomy preference
        const autonomy = await store.getAutonomyLevel();
        if (autonomy !== "supervised") {
          parts.push(`Human autonomy preference: ${autonomy}. ${
            autonomy === "balanced"
              ? "Skip findings for simple tasks. Present options only for genuine architectural choices."
              : "Proceed with recommended options. The human will review after. Only present decisions for high-risk or irreversible changes."
          }`);
        }

        // Engagement hint (only in balanced/autonomous mode, after some reviews)
        const metrics = await store.getEngagementMetrics();
        if (autonomy !== "supervised" && metrics.avgReviewLatencyMs > 0) {
          const avgSecs = Math.round(metrics.avgReviewLatencyMs / 1000);
          const hint = avgSecs < 30
            ? `Human reviewing quickly (avg ${avgSecs}s) — safe to present more artifacts without batching.`
            : avgSecs > 300
              ? `Human taking longer on reviews (avg ${Math.round(avgSecs / 60)}m) — consider batching related findings together.`
              : null;
          if (hint) {
            parts.push(`Engagement: ${hint}`);
          }
        }

        // Escalation hint after repeated empty polls
        if (checkFeedbackPollCount >= 3 && pendingCount > 0) {
          parts.push(`⚠️ No human response after ${checkFeedbackPollCount} checks (~${checkFeedbackPollCount * 30}s). The human may not have the companion UI open.\nMention in your response: "Please open http://localhost:${port} to review the artifacts." Then continue polling with check_feedback.`);
        }

        // If only the preamble exists (no feedback, no waits), give a clean proceed signal
        if (parts.length === 1) {
          return {
            content: [{ type: "text", text: parts[0] }],
          };
        }

        return {
          content: [{ type: "text", text: parts.join("\n\n") }],
        };
      }

      // III12 — case "request_horizon_check" removed. The workflow
      // (post a question on an artifact with a templated horizon prompt)
      // is now: call addComment / answer_question with the horizon
      // template as the question text. The deeppairing.md skill carries
      // the templates so the LLM still has them available.

      case "answer_question": {
        const commentId = String(args?.commentId ?? "").trim();
        const answer = String(args?.answer ?? "").trim();
        if (!commentId || !answer) {
          return {
            content: [{ type: "text", text: "answer_question requires commentId and answer." }],
            isError: true,
          };
        }

        // Some stores may not yet implement getComment / markCommentAnswered
        // (e.g., a future fake). Guard so the tool still works with a plain
        // IStore.
        // AA7b — getComment is required on IStore; cast was dead weight.
        const parent = await store.getComment(commentId);
        if (!parent) {
          return {
            content: [{ type: "text", text: `answer_question: no comment with id ${commentId}.` }],
            isError: true,
          };
        }

        const answerId = `cmt_${nanoid(10)}`;
        const codeRefs = Array.isArray(args?.evidence)
          ? args.evidence
              .filter((e: any) => e && typeof e === "object")
              .map((e: any) => ({
                filePath: String(e.filePath ?? ""),
                lineStart: Number(e.lineStart ?? 1),
                lineEnd: Number(e.lineEnd ?? e.lineStart ?? 1),
                snippet: e.snippet ? String(e.snippet) : undefined,
              }))
              .filter((e: any) => e.filePath)
          : undefined;

        const answerComment = await store.addComment({
          id: answerId,
          artifactId: parent.target?.artifactId ?? "__session__",
          content: answer,
          author: "agent",
          target: parent.target ?? { artifactId: "__session__" },
          parentCommentId: commentId,
        } as any);

        // Attach code references if the agent supplied evidence
        if (codeRefs && codeRefs.length > 0) {
          (answerComment as any).codeReferences = codeRefs;
        }

        // AA7b — markCommentAnswered is required on IStore.
        await store.markCommentAnswered(commentId, answerId);

        broadcast({ type: "comment_added", comment: answerComment });
        // O7: distinct event so the UI can toast the answer moment (otherwise
        // it just blends into the artifact's comment thread and the human
        // might not notice their question was picked up).
        broadcast({
          type: "question_answered",
          questionId: commentId,
          answerId,
          artifactId: parent.target?.artifactId,
          answerExcerpt: answer.slice(0, 120),
        });
        return {
          content: [{ type: "text", text: `Answered ${commentId}. The human will see the reply under their question.${await getPassiveFeedback()}` }],
        };
      }

      case "revise_artifact": {
        const artifactId = String(args?.artifactId ?? "").trim();
        const mode = args?.mode as "supersede" | "retract" | "obsolete" | undefined;
        const reason = String(args?.reason ?? "").trim();
        if (!artifactId || !reason || (mode !== "supersede" && mode !== "retract" && mode !== "obsolete")) {
          return {
            content: [{ type: "text", text: "revise_artifact requires artifactId, mode ('supersede' | 'retract' | 'obsolete'), and reason." }],
            isError: true,
          };
        }

        if (mode === "supersede") {
          const content = (args?.content && typeof args.content === "object") ? args.content : null;
          if (!content) {
            return {
              content: [{ type: "text", text: "revise_artifact with mode='supersede' requires a `content` object (same shape the original present_* tool accepts)." }],
              isError: true,
            };
          }
          const all = await store.getArtifacts();
          const old = all.find((a) => a.id === artifactId);
          if (!old) {
            return {
              content: [{ type: "text", text: `revise_artifact: no artifact with id ${artifactId}.` }],
              isError: true,
            };
          }
          if (old.status === "superseded" || old.status === "retracted") {
            return {
              content: [{ type: "text", text: `revise_artifact: ${artifactId} is already ${old.status}.` }],
              isError: true,
            };
          }

          const title = String(args?.title ?? old.title);
          const newId = `art_${nanoid(10)}`;
          const newArtifact = await store.createArtifact({
            id: newId,
            type: old.type,
            title,
            content: content as Record<string, unknown>,
            agentReasoning: reason,
            parentId: old.id,
            version: old.version + 1,
          });
          await store.updateArtifactStatus(old.id, "superseded", "agent_supersede");
          await maybeUpdateTaskStatus(server, old.id, store);

          await store.addComment({
            id: `cmt_${nanoid(10)}`,
            artifactId: old.id,
            content: `Superseded by ${newId}: ${reason}`,
            author: "agent",
          });

          if (old.type === "decision" && (content as any).options && (content as any).decisionId) {
            await store.recordDecisionRequest({
              decisionId: (content as any).decisionId,
              artifactId: newId,
              context: (content as any).context ?? title,
              options: (content as any).options,
            });
          }
          if (old.type === "plan") {
            await store.recordPlanReview(newId);
          }

          broadcast({ type: "artifact_created", artifact: newArtifact });
          broadcast({ type: "artifact_updated", artifactId: old.id, status: "superseded" });
          // HH10 — supersede creates a new resource AND retires the old
          // one's content. Both are list-changing events.
          notifyResourcesListChanged(server);

          return {
            content: [{ type: "text", text: `Superseded ${artifactId} → ${newId} (v${old.version + 1}). Draft is awaiting review.${await getPassiveFeedback()}` }],
          };
        }

        // mode === "retract" | "obsolete" — both close a still-open artifact
        // with no replacement. retract = "shouldn't have presented it";
        // obsolete = "valid, but overcome by new information / I've moved on".
        const artifacts = await store.getArtifacts();
        const artifact = artifacts.find((a) => a.id === artifactId);
        if (!artifact) {
          return {
            content: [{ type: "text", text: `revise_artifact: no artifact with id ${artifactId}.` }],
            isError: true,
          };
        }
        if (artifact.status !== "draft" && artifact.status !== "reviewing") {
          return {
            content: [{ type: "text", text: `revise_artifact: ${artifactId} is ${artifact.status}, too late to ${mode}. Use check_feedback instead.` }],
            isError: true,
          };
        }
        const isObsolete = mode === "obsolete";
        const newStatus = isObsolete ? "obsolete" : "retracted";
        await store.updateArtifactStatus(artifactId, newStatus, isObsolete ? "agent_obsolete" : "agent_retract");
        await maybeUpdateTaskStatus(server, artifactId, store);
        await store.addComment({
          id: `cmt_${nanoid(10)}`,
          artifactId,
          content: `${isObsolete ? "Overcome by new information" : "Retracted"}: ${reason}`,
          author: "agent",
        });
        broadcast({ type: "artifact_updated", artifactId, status: newStatus });
        return {
          content: [{ type: "text", text: `${isObsolete ? `Marked ${artifactId} obsolete (overcome by new information) — it's off the human's review queue` : `Retracted ${artifactId}`}. Continue your workflow — call check_feedback or present a revised artifact.${await getPassiveFeedback()}` }],
        };
      }

      case "recall":
        // CC10 — handler extracted to mcp/tools/recall.ts (~190 LOC out
        // of server.ts). Matches the present-*.ts split.
        return handleRecall(ctx, args);

      case "post_pr_review": {
        const ref = String(args?.pr ?? "").trim();
        if (!ref) {
          return {
            content: [{ type: "text", text: "post_pr_review requires a `pr` argument (number or URL)." }],
            isError: true,
          };
        }
        const event = ["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(args?.event)
          ? (args.event as "COMMENT" | "REQUEST_CHANGES" | "APPROVE")
          : "COMMENT";

        // Build the payload from the current session.
        const state = await store.getFullState();
        const payload = buildGitHubReviewPayload(state as any, { event });

        if (payload.comments.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No findings with structured evidence (filePath + lineStart) in this session — nothing to post as inline review comments. Use present_findings with structured Evidence objects to enable this.",
            }],
            isError: true,
          };
        }

        try {
          const result = await postPrReview({
            ref,
            payload,
            owner: typeof args?.owner === "string" ? args.owner : undefined,
            repo: typeof args?.repo === "string" ? args.repo : undefined,
          });
          return {
            content: [{
              type: "text",
              text: `Posted ${payload.comments.length} inline comment${payload.comments.length === 1 ? "" : "s"} on PR ${ref} as ${payload.event}: ${result.htmlUrl}`,
            }],
          };
        } catch (err: any) {
          if (err instanceof GhMissingError || err instanceof GhNotAuthedError) {
            return {
              content: [{ type: "text", text: err.message }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `post_pr_review failed: ${err?.message ?? err}` }],
            isError: true,
          };
        }
      }

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
