/**
 * SPIKE — MCP SDK v2 port of createMcpServer (server.ts stays untouched).
 *
 * Ported against @modelcontextprotocol/server@2.0.0-beta.2. This file is a
 * faithful copy of server.ts with the v1→v2 API deltas applied; every delta
 * is tagged with a `V2:` comment so the breakage catalogue can be assembled
 * by grepping this file.
 *
 * V2 delta summary:
 *  - Package: @modelcontextprotocol/sdk/server/index.js → @modelcontextprotocol/server
 *    (stdio moved to the /stdio subpath; types are exported from the root).
 *  - setRequestHandler(ZodRequestSchema, handler) → setRequestHandler("method/name", handler).
 *    The Zod request-schema constants (ListToolsRequestSchema et al.) no longer exist.
 *  - The low-level Server class is @deprecated (McpServer.registerTool is the
 *    blessed path) but still fully functional.
 *  - progressToken now comes from ctx.mcpReq._meta (handler 2nd arg), not
 *    request.params._meta.
 *  - elicitInput() survives for 2025-era connections but THROWS on 2026-07-28-era
 *    requests; the replacement is returning inputRequired(...) from the handler.
 *    tryElicit's try/catch fallback absorbs the throw, so behavior degrades to
 *    "review in companion UI" — acceptable, but a real port should branch.
 *  - start() for a modern-era-capable stdio server is serveStdio(factory), which
 *    owns the era decision (legacy initialize vs 2026 stateless per-request _meta).
 */
import { Server } from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
// V2: the v1 `Server` type is still what ToolContext/tool-helpers are typed
// against. The v2 Server is structurally compatible for everything the tool
// handlers touch (notification(), elicitInput(), sendResourceListChanged()),
// so the spike casts at the boundary instead of forking 14 tool files.
import type { Server as V1Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import { TOOL_INPUT_SCHEMAS, toMcpInputSchema } from "./validate-tool-input.js";

type BroadcastFn = (event: any) => void;

export function createMcpServerV2(store: IStore, broadcast: BroadcastFn, port = 3847) {
  const server = new Server(
    { name: "deeppairing", version: "0.1.0" },
    {
      // V2: capabilities option shape is unchanged.
      capabilities: { tools: {}, resources: { listChanged: true }, prompts: {} },
    },
  );

  // V2: ToolContext + helpers are typed against the v1 Server. Structural
  // cast — see header comment.
  const serverForTools = server as unknown as V1Server;

  // --- List Tools ---
  // V2: setRequestHandler takes the method STRING; the Zod request-schema
  // constant import is gone.
  // V2: the Tool wire type is now STRICTLY typed JSON Schema (v1's was a
  // passthrough Zod object with `unknown` properties). A heterogeneous array
  // of hand-written descriptor literals no longer infers to something
  // assignable — the array must be annotated Tool[] (and each inputSchema
  // must genuinely conform).
  server.setRequestHandler("tools/list", async () => {
    const tools: Tool[] = [
      {
        name: "present_findings",
        annotations: { title: "Present findings", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          `Present research findings as a structured artifact in the companion UI (${port ? `localhost:${port}` : ""}). Each finding carries evidence, category, significance, severity.` +
          `\n\nSchema note: \`findings\` is an array of objects (NOT a string). Required per-finding: category, detail, significance. Validation runs at the boundary; mismatch returns INPUT_VALIDATION_FAILED with the bad path + an example.` +
          `\n\nWorkflow: SINGLE REVIEW SURFACE — the companion UI is the only review surface. Don't paste findings in chat; call check_feedback for the verdict.`,
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_findings),
      },
      {
        name: "present_options",
        annotations: { title: "Present options", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present 2–4 options with pros/cons/effort/risk for the human to choose." +
          "\n\nSchema note: `options` is an array of 2–4 objects. INPUT_VALIDATION_FAILED on mismatch." +
          "\n\nWorkflow: SINGLE REVIEW SURFACE — human selects in the companion UI. Call check_feedback for the selection.",
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_options),
      },
      {
        name: "present_spec",
        annotations: { title: "Present spec", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present a feature spec — objective, requirements (each with rationale + acceptance criteria), optional design notes and tasks.",
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_spec),
      },
      {
        name: "present_plan",
        annotations: { title: "Present plan", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description:
          "Present an implementation plan as steps with file changes and before/after previews.",
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_plan),
      },
      {
        name: "log_reasoning",
        annotations: { title: "Log reasoning", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description: "Log the reasoning for an action before taking it.",
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.log_reasoning),
      },
      {
        name: "check_feedback",
        annotations: { title: "Check feedback", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description:
          "Poll for the human's response to artifacts you've presented. The human responds in the companion UI; this tool waits up to 30s and returns status + any comments / decisions / plan verdicts.",
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
        outputSchema: {
          type: "object" as const,
          properties: {
            status: {
              type: "string",
              enum: ["feedback", "waiting", "proceed"],
              description: "feedback = something to act on below; waiting = reviews still pending; proceed = clear.",
            },
            suggestedAction: { type: "string" },
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
        description: "Present a code change as a before/after diff with reasoning.",
        inputSchema: toMcpInputSchema(TOOL_INPUT_SCHEMAS.present_code_change),
      },
      {
        name: "recall",
        annotations: { title: "Recall philosophy", readOnlyHint: true, openWorldHint: false },
        description: "Search deepPairing memory.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Free-text query." },
            mode: { type: "string", enum: ["philosophy", "sessions", "ledger", "any"] },
            stance: { type: "string", enum: ["avoid", "prefer", "mixed"] },
            source: { type: "string", enum: ["user-seeded", "session"] },
            limit: { type: "number", description: "Max results (default 20, cap 100)" },
          },
        },
      },
      {
        name: "post_pr_review",
        annotations: { title: "Post PR review", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        description: "Post this session's approved findings as inline comments on a GitHub PR via the `gh` CLI.",
        inputSchema: {
          type: "object" as const,
          properties: {
            pr: { type: "string", description: "PR number, '#42', or a full PR URL" },
            event: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES", "APPROVE"] },
            owner: { type: "string" },
            repo: { type: "string" },
          },
          required: ["pr"],
        },
      },
      {
        name: "export_session",
        annotations: { title: "Export session", readOnlyHint: true, openWorldHint: false },
        description: "Export the current session as markdown.",
        inputSchema: {
          type: "object" as const,
          properties: {
            format: { type: "string", enum: ["pr-description", "pr-comments", "adr", "full", "replay", "learnings"] },
          },
        },
      },
      {
        name: "answer_question",
        annotations: { title: "Answer question", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        description: "Reply to a question comment from the human.",
        inputSchema: {
          type: "object" as const,
          properties: {
            commentId: { type: "string" },
            answer: { type: "string" },
            evidence: {
              type: "array",
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
        description: "Mark plan steps as in_progress/done/skipped while EXECUTING an approved plan.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifactId: { type: "string" },
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  stepIndex: { type: "number" },
                  status: { type: "string", enum: ["pending", "in_progress", "done", "skipped"] },
                  statusNote: { type: "string" },
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
        description: "Revise a prior artifact (supersede / retract / obsolete).",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifactId: { type: "string" },
            mode: { type: "string", enum: ["supersede", "retract", "obsolete"] },
            reason: { type: "string" },
            title: { type: "string" },
            content: { type: "object" },
          },
          required: ["artifactId", "mode", "reason"],
        },
      },
    ];
    return { tools };
  });

  // --- MCP resources (same URIs/cursor logic as v1) ---
  const canListPast = typeof store.listPastSessions === "function";
  const canLoadPast = typeof store.loadPastSession === "function";
  const LIST_PAGE_SIZE = 100;
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

  server.setRequestHandler("resources/list", async (request) => {
    const resources: Array<{ uri: string; name: string; description?: string; mimeType: string }> = [];
    // V2: request is still the full {method, params} object for the typed
    // method overload — cursor access is unchanged.
    const rawCursor = request.params?.cursor;
    const cursor = decodeCursor(rawCursor);
    const isFirstPage = cursor === null;

    if (isFirstPage) {
      resources.push({
        uri: "deeppairing://onboarding",
        name: "Session onboarding — read first",
        description: "Rejected approaches, approved patterns, philosophy ledger snapshot, team rules, and autonomy hint.",
        mimeType: "text/plain",
      });
      resources.push({
        uri: "deeppairing://session/current",
        name: "Active session state",
        description: "Full JSON snapshot of the active session.",
        mimeType: "application/json",
      });
    }

    const allArtifacts = await store.getArtifacts();
    const orderedArtifacts = [...allArtifacts]
      .map((a) => ({ a, at: String((a as any).updatedAt ?? (a as any).createdAt ?? "") }))
      .sort((x, y) => {
        const cmp = y.at.localeCompare(x.at);
        return cmp !== 0 ? cmp : y.a.id.localeCompare(x.a.id);
      });

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

    if (isFirstPage && canListPast) {
      resources.push({
        uri: "deeppairing://sessions",
        name: "Past sessions in this project",
        description: "Index of prior deepPairing sessions.",
        mimeType: "application/json",
      });
      try {
        const past = (await store.listPastSessions?.()) ?? [];
        const pastPage = past.slice(0, LIST_PAGE_SIZE);
        for (const s of pastPage) {
          if (s.id === store.getSessionId()) continue;
          resources.push({
            uri: `deeppairing://session/${s.id}`,
            name: `Past session: ${s.summary ?? s.id}`,
            description: `${s.artifactCount} artifacts · ${s.lastActivity ?? s.createdAt}`,
            mimeType: "application/json",
          });
        }
      } catch {
        // non-fatal
      }
    }

    const result: { resources: typeof resources; nextCursor?: string } = { resources };
    if (hasMoreArtifacts && lastOnPage) {
      result.nextCursor = encodeCursor(lastOnPage.at, lastOnPage.a.id);
    }
    return result;
  });

  server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri;

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
      if (sessionId === "onboarding" || sessionId === "current") {
        throw new Error(`Reserved session id: '${sessionId}'.`);
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

  // --- MCP prompts ---
  server.setRequestHandler("prompts/list", async () => {
    return {
      prompts: [
        {
          name: "recall",
          description: "Query your philosophy ledger (cross-project stances) and past sessions.",
          arguments: [
            { name: "query", description: "Concept or substring to look up. Omit to list everything.", required: false },
            { name: "mode", description: "'philosophy', 'sessions', or 'any' (default).", required: false },
          ],
        },
        {
          name: "seed",
          description: "Encode a stance you want the cross-project ledger to remember.",
          arguments: [
            { name: "concept", description: "Short name for the pattern you're rejecting.", required: true },
            { name: "reason", description: "Why you're rejecting it.", required: false },
          ],
        },
      ],
    };
  });

  server.setRequestHandler("prompts/get", async (request) => {
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
                `. Summarize the top entries plain-text.`,
            },
          },
        ],
      };
    }
    if (name === "seed") {
      const concept = String(request.params.arguments?.concept ?? "").trim();
      if (!concept) {
        throw new Error("seed prompt requires a `concept` argument.");
      }
      const reason = String(request.params.arguments?.reason ?? "").trim();
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
                `}.`,
            },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${name}`);
  });

  const getPassiveFeedback = () => getPassiveFeedbackHelper(store);

  // --- Call Tool ---
  let firstToolCall = true;
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
  const sessionNameLatch = new SessionNameLatch(store);
  let checkFeedbackPollCount = 0;
  const reportedRejectedVerdicts = new Set<string>();
  const reportedPlanVerdicts = new Set<string>();

  // V2: handler receives (request, ctx) — progressToken moved from
  // request.params._meta to ctx.mcpReq._meta.
  server.setRequestHandler("tools/call", async (request, handlerCtx) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, any>;

    let firstCallHint = "";
    if (firstToolCall && HINT_TOOLS.has(name)) {
      firstToolCall = false;
      firstCallHint = await buildFirstCallHint(store, port);
    }

    const tryElicit = (message: string) => tryElicitHelper(serverForTools, message);
    const preflightRejectedApproaches = (
      toolName: string,
      proposalStrings: string[],
      proposalPaths: string[] = [],
    ) => preflightHelper(store, broadcast, toolName, proposalStrings, proposalPaths);
    const autoNameSession = (title: string) => sessionNameLatch.maybeName(title);

    const ctx: ToolContext = {
      server: serverForTools,
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
      // V2: progressToken comes off the handler context's _meta view.
      progressToken: handlerCtx.mcpReq._meta?.progressToken,
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
        return handleCheckFeedback(ctx, args);
      case "update_plan_progress":
        return await handleUpdatePlanProgress(ctx, args);
      case "answer_question":
        return handleAnswerQuestion(ctx, args);
      case "revise_artifact":
        return handleReviseArtifact(ctx, args);
      case "recall":
        return handleRecall(ctx, args);
      case "post_pr_review":
        return handlePostPrReview(ctx, args);
      case "export_session":
        return handleExportSession(ctx, args);
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    } })();

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
      // V2: serveStdio(factory) replaces `server.connect(new StdioServerTransport())`
      // as the blessed stdio entry — it owns the era decision (a 2025
      // `initialize` opening pins legacy; a 2026-07-28 per-request-_meta
      // opening pins modern). Returning the SAME instance from the factory
      // matches v1 semantics (one server per process).
      return serveStdio(() => server);
    },
  };
}
