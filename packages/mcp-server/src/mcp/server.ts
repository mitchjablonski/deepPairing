import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { nanoid } from "nanoid";
import type { IStore, RejectedApproach } from "../store/store-interface.js";
import type { TeamPreference } from "@deeppairing/shared";
import { formatSessionMarkdown, buildGitHubReviewPayload } from "../export/format-markdown.js";
import { getGlobalStore, deriveStance } from "../store/global-store.js";
import { postPrReview, GhMissingError, GhNotAuthedError } from "../github/post-review.js";

/**
 * Check a set of proposal strings against previously rejected approaches.
 * Returns the first match found, or null if none.
 *
 * Matching has two layers:
 *   1) Surface: case-insensitive substring against the rejection description
 *      (and its colon-delimited fragments, so "Deploy: Railway" catches bare
 *      "Railway" proposals).
 *   2) Concept: when a rejected approach carries a `concept`, match if the
 *      concept's keywords appear anywhere in the proposal. This catches
 *      paraphrased re-proposals — e.g. "Deploy to Fly.io" still blocks after
 *      rejecting Railway with concept "pay-per-request serverless hosting".
 */
/**
 * Concept-token check used by both rejected-approach matching and team-pref
 * matching. Returns true when every meaningful (≥4 char) token from `concept`
 * appears in `proposal`. Substring-based and case-insensitive — good enough
 * to catch paraphrases without false positives on common words.
 */
function conceptMatchesProposal(concept: string, proposal: string): boolean {
  const tokens = concept.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  const p = proposal.toLowerCase();
  return tokens.every((t) => p.includes(t));
}

/**
 * Minimal glob matcher for team-preference scope paths. Supports:
 *   - `**` matches any sequence (including path separators)
 *   - `*`  matches any run of non-separator chars
 * Everything else is literal. Good enough for scoping rules like
 * `packages/auth/**`, `src/*.ts`. We avoid adding minimatch as a dependency
 * just for this.
 */
export function matchesGlob(pathStr: string, glob: string): boolean {
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++; // consume second *
    } else if (glob[i] === "*") {
      re += "[^/]*";
    } else {
      re += escape(glob[i]);
    }
  }
  return new RegExp(`^${re}$`).test(pathStr);
}

/**
 * Team-preference violation check. Two paths:
 *   - kind: "avoid"   → matches just like a rejected approach (concept tokens
 *     present in proposal). Returns the matched preference.
 *   - kind: "require" → only enforced when the concept is phrased as
 *     "<thing> for <domain>" (e.g. "argon2id for password hashing"). A
 *     proposal mentioning the domain ("password hashing") but lacking the
 *     required thing ("argon2id") is a violation. Concepts without a "for"
 *     clause stay advisory (firstCallHint surfaces them).
 *
 * Why advisory require: detecting "you should have done X but didn't" without
 * a domain ontology is too noisy. The "X for Y" convention is opt-in; teams
 * that want enforcement write their preferences that way.
 */
function findTeamPreferenceViolation(
  proposalStrings: string[],
  prefs: TeamPreference[],
  proposalPaths: string[] = [],
): { proposal: string; pref: TeamPreference; via: "avoid" | "require" } | null {
  for (const pref of prefs) {
    if (pref.kind === "prefer") continue; // 'prefer' is taste, never blocks

    // Scope check: if the pref is scoped AND the proposal carries path info,
    // require at least one proposal path to match the scope. If the proposal
    // has NO paths, skip this pref — we can't verify scope, so we bias toward
    // NOT blocking (avoid false positives on unrelated work).
    if (pref.scope?.paths?.length) {
      if (proposalPaths.length === 0) continue;
      const hit = proposalPaths.some((p) => pref.scope!.paths!.some((g) => matchesGlob(p, g)));
      if (!hit) continue;
    }

    if (pref.kind === "avoid") {
      for (const proposal of proposalStrings) {
        if (!proposal.trim()) continue;
        if (conceptMatchesProposal(pref.concept, proposal)) {
          return { proposal, pref, via: "avoid" };
        }
      }
    }

    if (pref.kind === "require") {
      const forIdx = pref.concept.toLowerCase().indexOf(" for ");
      if (forIdx === -1) continue; // no "X for Y" → can't infer domain → advisory only
      const required = pref.concept.slice(0, forIdx).trim();
      const domain = pref.concept.slice(forIdx + 5).trim();
      if (!required || !domain) continue;
      for (const proposal of proposalStrings) {
        if (!proposal.trim()) continue;
        const mentionsDomain = conceptMatchesProposal(domain, proposal);
        if (!mentionsDomain) continue;
        const hasRequired = conceptMatchesProposal(required, proposal);
        if (!hasRequired) {
          return { proposal, pref, via: "require" };
        }
      }
    }
  }
  return null;
}

function findRejectedApproachMatch(
  proposalStrings: string[],
  rejected: RejectedApproach[],
): { proposal: string; rejected: RejectedApproach; via: "surface" | "concept" } | null {
  const clean = (s: string) => s.trim().toLowerCase();
  for (const rej of rejected) {
    const rejNormalized = clean(rej.description);
    if (!rejNormalized) continue;
    // The portion AFTER the first colon is the specific rejection noun
    // ("Deploy: Railway" → "railway"); the prefix is the category and
    // recurs across unrelated rejections, so we don't match on it.
    const specificNoun = rejNormalized.includes(":")
      ? rejNormalized.split(":").slice(1).join(":").trim()
      : rejNormalized;
    const conceptTokens = rej.concept
      ? clean(rej.concept).split(/\s+/).filter((t) => t.length >= 4)
      : [];
    for (const proposal of proposalStrings) {
      const p = clean(proposal);
      if (!p) continue;
      // Direct substring in either direction (whole rejection description)
      if (rejNormalized.includes(p) || p.includes(rejNormalized)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      // Specific noun fragment of the rejection (post-colon)
      if (specificNoun.length >= 3 && p.includes(specificNoun)) {
        return { proposal, rejected: rej, via: "surface" };
      }
      // Concept match: every non-stopword concept token present in the proposal
      if (conceptTokens.length > 0 && conceptTokens.every((t) => p.includes(t))) {
        return { proposal, rejected: rej, via: "concept" };
      }
    }
  }
  return null;
}

type BroadcastFn = (event: any) => void;

export function createMcpServer(store: IStore, broadcast: BroadcastFn, port = 3847) {
  const server = new Server(
    { name: "deeppairing", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "present_findings",
        description: `Present research findings as a structured artifact in the companion UI (${port ? `localhost:${port}` : ""}). Each finding carries evidence (code snippets with explanations), category, significance, and severity. Use instead of dumping findings as plain chat text.`,
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
          "Present 2–4 options with pros/cons/effort/risk for the human to choose. Set `stakes: \"high\"` for architecturally significant / hard-to-reverse decisions (schema, auth, billing, infra); the UI then prompts the human for a prediction (calibration material).",
        inputSchema: {
          type: "object" as const,
          properties: {
            context: { type: "string", description: "What decision needs to be made" },
            stakes: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Consequentiality — on 'high', the UI captures the human's prediction + confidence",
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
          "Present a feature spec — objective, requirements (each with rationale + acceptance criteria), optional design notes and tasks. For non-trivial features, cross-cutting changes, or anything that'd otherwise skip straight to code without agreement on what's being built.",
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
          },
          required: ["title", "objective", "requirements"],
        },
      },
      {
        name: "present_plan",
        description: "Present an implementation plan as steps with file changes and before/after previews.",
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
          },
          required: ["title", "steps", "estimatedChanges"],
        },
      },
      {
        name: "log_reasoning",
        description:
          "Log the reasoning for an action before taking it. Name the underlying concept in `concept` (e.g. 'dependency inversion', 'optimistic UI') whenever one applies — the human learns the pattern, not just the fix. Attach `evidence` for reasoning grounded in the codebase, and `alternativeDetails` for structured rejected alternatives.",
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
          required: ["action", "reasoning", "confidence"],
        },
      },
      {
        name: "check_feedback",
        description: "Poll for the human's response to artifacts you've presented. The human responds in the companion UI; this tool waits up to 30s and returns status + any comments / decisions / plan verdicts.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "present_code_change",
        description: "Present a code change as a before/after diff with reasoning and confidence.",
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
          },
          required: ["filePath", "changeType", "after", "reasoning"],
        },
      },
      {
        name: "recall",
        description:
          "Search deepPairing memory. `mode: 'philosophy'` queries cross-project stances (avoid/prefer/mixed) with optional stance filter; empty query lists the whole ledger. `mode: 'sessions'` queries past artifacts in this project. `mode: 'any'` (default) unions both, philosophy first. All modes require a query except philosophy.",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Free-text query (concept, title, or content substring). Empty string with mode='philosophy' lists the whole ledger." },
            mode: {
              type: "string",
              enum: ["philosophy", "sessions", "any"],
              description: "Which layer to search. Default 'any'.",
            },
            stance: {
              type: "string",
              enum: ["avoid", "prefer", "mixed"],
              description: "Only applies when mode='philosophy' — filter to this derived stance.",
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
        description: "Export the current session as markdown. Formats: 'pr-description' (PR body), 'pr-comments' (findings as file:line PR comments), 'adr' (architecture decision record), 'full' (complete session), 'replay' (chronological walkthrough).",
        inputSchema: {
          type: "object" as const,
          properties: {
            format: { type: "string", enum: ["pr-description", "pr-comments", "adr", "full", "replay"], description: "Export format" },
          },
        },
      },
      {
        name: "request_horizon_check",
        description:
          "Ask the human to predict a failure mode for an architecturally-significant artifact on a 3mo / 1y / 2y horizon. The human's prediction is stored for later review; good signal for calibration. Use sparingly on schema, auth, caching, pipeline, or queue-semantics decisions.",
        inputSchema: {
          type: "object" as const,
          properties: {
            artifactId: { type: "string", description: "The artifact (plan, decision, code change) to anchor the horizon check to" },
            horizon: {
              type: "string",
              enum: ["3mo", "1y", "2y"],
              description: "How far out to project — shorter = operational risks, longer = scale/design risks",
            },
            prompt: {
              type: "string",
              description: "Optional concrete prompt. If omitted, a reasonable default is used based on the artifact type.",
            },
          },
          required: ["artifactId", "horizon"],
        },
      },
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
              enum: ["supersede", "retract"],
              description: "'supersede' to replace with a v(N+1) draft; 'retract' to mark as retracted.",
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

  const canListPast = typeof (store as any).listPastSessions === "function";
  const canLoadPast = typeof (store as any).loadPastSession === "function";

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Array<{ uri: string; name: string; description?: string; mimeType: string }> = [];

    // Current session
    resources.push({
      uri: "deeppairing://session/current",
      name: "Active session state",
      description: "Full JSON snapshot of the active session — artifacts, comments, decisions, plan reviews, autonomy level, session memory.",
      mimeType: "application/json",
    });

    // Per-artifact resources in the active session
    const artifacts = await store.getArtifacts();
    for (const a of artifacts) {
      resources.push({
        uri: `deeppairing://artifact/${a.id}`,
        name: `${a.type}: ${a.title}`,
        description: `v${a.version} · ${a.status}${a.parentId ? ` · supersedes ${a.parentId}` : ""}`,
        mimeType: "application/json",
      });
    }

    // Past sessions index (only when the store supports it — DaemonClient does)
    if (canListPast) {
      resources.push({
        uri: "deeppairing://sessions",
        name: "Past sessions in this project",
        description: "Index of prior deepPairing sessions — titles, timestamps, artifact counts. Read to decide which past session to pull.",
        mimeType: "application/json",
      });

      try {
        const past = await (store as any).listPastSessions();
        for (const s of past) {
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

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

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
      const past = await (store as any).listPastSessions();
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(past, null, 2) }],
      };
    }

    const sessionMatch = uri.match(/^deeppairing:\/\/session\/(.+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      if (!canLoadPast) {
        throw new Error("Past session reads require a DaemonClient store.");
      }
      const state = await (store as any).loadPastSession(sessionId);
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(state, null, 2) }],
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  });

  // --- Passive feedback helper ---
  async function getPassiveFeedback(): Promise<string> {
    const comments = await store.getUnacknowledgedComments();
    if (comments.length === 0) return "";
    await store.acknowledgeComments(comments.map((c) => c.id));
    const formatted = comments.map((c) => `- ${c.content}`).join("\n");
    return `\n\n[Human feedback]: ${formatted}`;
  }

  // --- Call Tool ---
  let firstToolCall = true;
  let sessionNamed = false;
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
    if (firstToolCall) {
      firstToolCall = false;
      const hintParts: string[] = [
        `[First use this session] The companion UI is at http://localhost:${port} — the human can review artifacts, comment, and make decisions there.`,
      ];
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
        hintParts.push(`\n📋 From previous sessions in this project:\n${memoryParts.join("\n")}`);
      }

      // J6 — codebase-sensed guardrails. Filesystem signals tell us which
      // paths are sensitive (migrations, CI workflows, infra). The agent
      // gets this list on first call so it knows to stay supervised for
      // changes in those paths even when autonomy is "autonomous". Zero
      // user configuration — we just detected it.
      try {
        if (typeof (store as any).getProjectGuardrails === "function") {
          const guardrails = await (store as any).getProjectGuardrails();
          if (Array.isArray(guardrails) && guardrails.length > 0) {
            const lines = guardrails.map((g: any) =>
              `  - ${g.category} (${(g.paths ?? []).join(", ")}): ${g.rationale}`,
            );
            hintParts.push(
              `\n🛡 Project guardrails (escalate to supervised for changes in these paths, even when autonomy is 'autonomous'):\n${lines.join("\n")}`,
            );
          }
        }
      } catch {
        // Non-fatal — we just won't surface guardrails
      }

      // N6.3 — team conventions from .deeppairing/team.json. Kept in a
      // distinct section from personal philosophy and structural guardrails
      // (NEVER merged — they're different kinds of authority). Groups by
      // kind so the agent can act on require/avoid first, prefer as taste.
      try {
        if (typeof (store as any).getTeamPreferences === "function") {
          const prefs = await (store as any).getTeamPreferences();
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
              hintParts.push(
                `\n🏢 Team conventions (from .deeppairing/team.json — treat 'require' as hard rules, 'avoid' as refusal triggers, 'prefer' as taste):\n${sections.join("\n")}`,
              );
            }
          }
        }
      } catch {
        // Non-fatal — team prefs are advisory; keep polling shape intact.
      }

      // J4 — cross-project philosophy kickoff brief. Pull the top few
      // strongly-held cross-project stances so the agent has the user's
      // taste before it proposes anything. Keep it tight (3 avoid + 3 prefer
      // max) — this is a primer, not a dump.
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
          hintParts.push(
            `\n🧭 Cross-project philosophy ledger (use recall with mode='philosophy' for more):\n${philosophyParts.join("\n")}`,
          );
        }
      } catch {
        // Ledger read failure is non-fatal — we still have session-scoped memory.
      }

      // Q4: surface unanswered questions from the human at first-call so the
      // agent knows to reach for answer_question. Catches the case where a
      // previous agent session left questions dangling — the new session's
      // first call learns about them immediately, not after several
      // check_feedback polls.
      try {
        const fullState = await store.getFullState();
        const unanswered = (fullState.comments ?? []).filter(
          (c: any) => c.author === "human" && c.intent === "question" && !c.answeredByCommentId,
        );
        if (unanswered.length > 0) {
          hintParts.push(
            `\n❓ ${unanswered.length} unanswered question${unanswered.length === 1 ? "" : "s"} from the human. Call check_feedback to read them, then reply with answer_question (not a plain comment) so the UI links the answer to the question.`,
          );
        }
      } catch {
        // Non-fatal — agent will catch them on the next check_feedback anyway
      }

      // N2.2: if the user installed via the plugin (which doesn't touch
      // CLAUDE.md), surface a one-line tip pointing at `npx deeppairing init`.
      // CLAUDE.md mutation is intentionally opt-in — the daemon won't do it
      // silently. Detect by checking for the deepPairing marker in CLAUDE.md.
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const claudeMd = path.join(process.cwd(), "CLAUDE.md");
        if (fs.existsSync(claudeMd)) {
          const content = fs.readFileSync(claudeMd, "utf-8");
          if (!content.includes("<!-- deepPairing -->")) {
            hintParts.push(
              "\n💡 Tip: run `npx deeppairing init` to add the deepPairing protocol to CLAUDE.md so the agent follows it on every session (optional — the plugin's pairing-protocol skill covers most of this already).",
            );
          }
        }
      } catch {
        // Non-fatal — skip the tip
      }

      firstCallHint = `\n${hintParts.join("\n")}`;
    }

    /**
     * Try to elicit a quick response from the user via MCP elicitation.
     * Falls back gracefully if the client doesn't support it.
     * Returns "approve" | "review" | "reject" | null (not supported).
     */
    /**
     * Try to elicit a quick response from the user via MCP elicitation.
     * Accept = approve, Decline = open companion UI for review.
     * Falls back gracefully if the client doesn't support it.
     */
    const tryElicit = async (message: string): Promise<"approve" | "review" | null> => {
      try {
        const result = await server.elicitInput({
          message,
          requestedSchema: {
            type: "object" as const,
            properties: {},
          },
        });
        // Accept = approve the artifact, Decline = review in companion UI
        if (result.action === "accept") return "approve";
        if (result.action === "decline" || result.action === "cancel") return "review";
      } catch {
        // Client doesn't support elicitation — fall back to polling
      }
      return null;
    };

    /**
     * Pre-flight: refuse to record an artifact whose content matches an
     * approach the human previously rejected (session-scoped) OR violates a
     * team-agreed avoid/require preference (committed to .deeppairing/team.json).
     * Returns a tool error response if either lane matches, or null otherwise.
     *
     * Order: session-rejected first (it's the user's most recent stance, and
     * it's what their brain expects to be enforced), then team prefs.
     */
    const preflightRejectedApproaches = async (
      toolName: string,
      proposalStrings: string[],
      proposalPaths: string[] = [],
    ): Promise<{ content: Array<{ type: "text"; text: string }>; isError: true } | null> => {
      const memory = await store.getSessionMemory();
      if (memory.rejectedApproaches.length > 0) {
        const match = findRejectedApproachMatch(proposalStrings, memory.rejectedApproaches);
        if (match) {
          const reasonLine = match.rejected.reason
            ? `\nPrior rejection reason: "${match.rejected.reason}"`
            : "";
          const conceptLine =
            match.via === "concept" && match.rejected.concept
              ? `\nMatched on underlying concept: "${match.rejected.concept}". ` +
                `A paraphrased proposal still counts — the user has rejected this kind of approach.`
              : "";
          const message =
            `REJECTED_APPROACH_BLOCKED: ${toolName} refused — your proposal contains "${match.proposal}" ` +
            `which the user previously rejected ("${match.rejected.description}").${reasonLine}${conceptLine}\n\n` +
            `Do NOT retry with this approach. Revise your proposal to exclude it, or — if you believe ` +
            `conditions have changed — present_findings first to make the case for reconsidering, then ` +
            `wait for the human's response via check_feedback. The artifact was NOT created.`;

          // Make the invisible moat felt: broadcast the block so the companion UI
          // can surface a toast. The MOST distinctive deepPairing mechanic — the
          // agent being stopped from re-proposing something the human already
          // rejected — used to happen silently. Now the human sees it.
          broadcast({
            type: "preflight_blocked",
            toolName,
            source: "session",
            match: {
              proposal: match.proposal,
              description: match.rejected.description,
              reason: match.rejected.reason,
              concept: match.rejected.concept,
              via: match.via,
            },
          });

          return {
            content: [{ type: "text", text: message }],
            isError: true as const,
          };
        }
      }

      // N6.4 — team-preferences lane. Distinct authority from session memory:
      // a team pref is something the team committed to a file in the repo, so
      // the block message attributes to "team policy" not "the user".
      const teamPrefs: TeamPreference[] = typeof (store as any).getTeamPreferences === "function"
        ? (await (store as any).getTeamPreferences()) ?? []
        : [];
      if (teamPrefs.length > 0) {
        const teamMatch = findTeamPreferenceViolation(proposalStrings, teamPrefs, proposalPaths);
        if (teamMatch) {
          const { pref, proposal, via } = teamMatch;
          const attribution = pref.addedBy ? ` (added by ${pref.addedBy})` : "";
          const scope = pref.scope?.paths?.length
            ? `\nScope: ${pref.scope.paths.join(", ")}`
            : "";
          const headline = via === "avoid"
            ? `your proposal touches "${proposal}" which conflicts with the team's "avoid: ${pref.concept}" policy`
            : `your proposal addresses "${proposal}" but is missing the team-required "${pref.concept}"`;
          const message =
            `REJECTED_APPROACH_BLOCKED: ${toolName} refused — ${headline}.\n` +
            `Team rationale: "${pref.rationale}"${attribution}.${scope}\n\n` +
            (via === "avoid"
              ? `Do NOT propose this. Revise to use an alternative approach, or call present_findings to make a case for changing the team policy. The artifact was NOT created.`
              : `Revise your proposal to use the required approach, or call present_findings to surface why this case warrants an exception. The artifact was NOT created.`);

          broadcast({
            type: "preflight_blocked",
            toolName,
            source: "team",
            match: {
              proposal,
              description: pref.concept,
              reason: pref.rationale,
              concept: pref.concept,
              via,
              kind: pref.kind,
              addedBy: pref.addedBy,
              scope: pref.scope?.paths,
            },
          });

          return {
            content: [{ type: "text", text: message }],
            isError: true as const,
          };
        }
      }

      return null;
    };

    /** Auto-name the session from the first meaningful artifact title */
    const autoNameSession = async (title: string) => {
      if (sessionNamed || !title || title === "Research Findings" || title === "Reasoning") return;
      sessionNamed = true;
      // If the store supports renaming sessions (DaemonClient does)
      if ("renameSession" in store && typeof (store as any).renameSession === "function") {
        await (store as any).renameSession(title);
      }
    };

    const result = await (async () => { switch (name) {
      case "present_findings": {
        const findings: any[] = Array.isArray(args?.findings) ? args.findings : [];
        const proposals: string[] = [
          args?.title ?? "",
          args?.summary ?? "",
          ...findings.map((f) => f?.title ?? ""),
          ...findings.map((f) => f?.recommendation ?? ""),
        ].filter(Boolean);
        // Paths from structured evidence feed scope-aware team-pref enforcement.
        const proposalPaths: string[] = findings.flatMap((f) =>
          Array.isArray(f?.evidence)
            ? f.evidence.map((e: any) => (typeof e === "object" && e?.filePath) || "").filter(Boolean)
            : [],
        );
        const blocked = await preflightRejectedApproaches("present_findings", proposals, proposalPaths);
        if (blocked) return blocked;

        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "research",
          title: args?.title ?? "Research Findings",
          content: {
            summary: args?.summary,
            findings: args?.findings,
            openQuestions: args?.openQuestions ?? [],
          },
        });
        broadcast({ type: "artifact_created", artifact });
        await autoNameSession(artifact.title);

        // Try elicitation for quick approval
        const elicitAction = await tryElicit(
          `Findings: "${artifact.title}"\n\n` +
          `Accept to approve these findings.\n` +
          `Decline to review in detail at http://localhost:${port}`
        );
        if (elicitAction === "approve") {
          await store.updateArtifactStatus(id, "approved");
          return {
            content: [{ type: "text", text: `Findings recorded and approved (${id}).${await getPassiveFeedback()}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Findings recorded (${id}). Human can review at localhost:${port}. Call check_feedback for their response.${await getPassiveFeedback()}` }],
        };
      }

      case "present_options": {
        const proposedOptions: any[] = Array.isArray(args?.options) ? args.options : [];
        const proposals: string[] = [
          args?.context ?? "",
          ...proposedOptions.map((o) => o?.title ?? ""),
          ...proposedOptions.map((o) => o?.description ?? ""),
        ].filter(Boolean);
        const blocked = await preflightRejectedApproaches("present_options", proposals);
        if (blocked) return blocked;

        const id = `art_${nanoid(10)}`;
        const decisionId = `dec_${nanoid(10)}`;
        const stakes = ["low", "medium", "high"].includes(args?.stakes) ? args.stakes : undefined;
        const artifact = await store.createArtifact({
          id,
          type: "decision",
          title: args?.context ?? "Decision",
          content: { context: args?.context, options: args?.options, decisionId, stakes },
          relatedArtifactIds: args?.relatedFindings,
        });
        await store.recordDecisionRequest({
          decisionId,
          artifactId: id,
          context: args?.context,
          options: args?.options,
          stakes,
        } as any);
        broadcast({ type: "artifact_created", artifact });
        broadcast({
          type: "decision_request",
          decisionId,
          artifactId: id,
          context: args?.context,
          options: args?.options,
          stakes,
        });

        // Try elicitation for quick selection
        const options = args?.options ?? [];
        // Decisions with multiple options are best reviewed in the companion UI
        // Skip elicitation — the option comparison UI is much richer than a terminal form

        return {
          content: [{ type: "text", text: `Decision "${args?.context}" presented to human (${decisionId}). They can select at localhost:${port}. Call check_feedback for their choice.${await getPassiveFeedback()}` }],
        };
      }

      case "present_spec": {
        const requirementsArr: any[] = Array.isArray(args?.requirements) ? args.requirements : [];
        const tasksArr: any[] = Array.isArray(args?.tasks) ? args.tasks : [];
        const proposals: string[] = [
          args?.title ?? "",
          args?.objective ?? "",
          ...requirementsArr.map((r) => r?.statement ?? ""),
          ...requirementsArr.map((r) => r?.rationale ?? ""),
          ...tasksArr.map((t) => t?.description ?? ""),
        ].filter(Boolean);
        const blocked = await preflightRejectedApproaches("present_spec", proposals);
        if (blocked) return blocked;

        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "spec",
          title: String(args?.title ?? "Specification"),
          content: {
            objective: args?.objective,
            context: args?.context,
            requirements: requirementsArr,
            design: args?.design,
            tasks: tasksArr,
            openQuestions: args?.openQuestions ?? [],
          },
        });
        broadcast({ type: "artifact_created", artifact });
        await autoNameSession(artifact.title);

        // Quick-approve path via elicitation for simple specs
        const elicitAction = await tryElicit(
          `Spec: "${artifact.title}"\n\n` +
          `Accept to approve these requirements as-is.\n` +
          `Decline to review requirements and acceptance criteria in the companion UI at http://localhost:${port}`,
        );
        if (elicitAction === "approve") {
          await store.updateArtifactStatus(id, "approved");
          return {
            content: [{ type: "text", text: `Spec "${artifact.title}" recorded and approved (${id}). Proceed with present_plan.${await getPassiveFeedback()}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Spec "${artifact.title}" presented for review (${id}). The human can challenge each requirement and acceptance criterion at localhost:${port}. Call check_feedback for their response.${await getPassiveFeedback()}` }],
        };
      }

      case "present_plan": {
        const planSteps: any[] = Array.isArray(args?.steps) ? args.steps : [];
        const proposals: string[] = [
          args?.title ?? "",
          ...planSteps.map((s) => s?.description ?? ""),
          ...planSteps.map((s) => s?.reasoning ?? ""),
          ...planSteps.flatMap((s) =>
            Array.isArray(s?.files) ? s.files.map((f: any) => String(f)) : [],
          ),
        ].filter(Boolean);
        const proposalPaths: string[] = planSteps.flatMap((s) =>
          Array.isArray(s?.files)
            ? s.files.map((f: any) => (typeof f === "string" ? f : f?.filePath)).filter(Boolean)
            : [],
        );
        const blocked = await preflightRejectedApproaches("present_plan", proposals, proposalPaths);
        if (blocked) return blocked;

        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "plan",
          title: args?.title ?? "Implementation Plan",
          content: { steps: args?.steps, estimatedChanges: args?.estimatedChanges },
          relatedArtifactIds: args?.relatedFindings,
        });
        await store.recordPlanReview(id);
        broadcast({ type: "artifact_created", artifact });
        broadcast({ type: "plan_review_request", artifactId: id, title: args?.title });

        // Try elicitation for quick approval
        const elicitAction = await tryElicit(
          `Plan: "${args?.title}" (${args?.steps?.length ?? 0} steps)\n\n` +
          `Accept to approve this plan.\n` +
          `Decline to review steps in detail at http://localhost:${port}`
        );
        if (elicitAction === "approve") {
          await store.updateArtifactStatus(id, "approved");
          await store.resolvePlanReview(id, "approved");
          return {
            content: [{ type: "text", text: `Plan "${args?.title}" approved (${id}). Proceed with implementation.${await getPassiveFeedback()}` }],
          };
        }

        return {
          content: [{ type: "text", text: `Plan "${args?.title}" presented for review (${id}). Human can approve/revise/reject at localhost:${port}. Call check_feedback for their verdict.${await getPassiveFeedback()}` }],
        };
      }

      case "log_reasoning": {
        const id = `art_${nanoid(10)}`;
        const relatedIds = args?.relatesTo?.artifactId ? [args.relatesTo.artifactId] : undefined;
        const artifact = await store.createArtifact({
          id,
          type: "reasoning",
          title: args?.action ?? "Reasoning",
          content: {
            action: args?.action,
            reasoning: args?.reasoning,
            concept: args?.concept,
            evidence: args?.evidence,
            relatesTo: args?.relatesTo,
            alternativesConsidered: args?.alternativesConsidered ?? [],
            alternativeDetails: args?.alternativeDetails,
            confidence: args?.confidence,
          },
          agentReasoning: args?.reasoning,
          relatedArtifactIds: relatedIds,
        });
        broadcast({ type: "artifact_created", artifact });
        // Gentle nudge when the agent omits `concept` — the pairing value
        // hinges on the concept being surfaced, not the reasoning prose.
        const nudge = args?.concept?.name
          ? ""
          : "\n(Pairing nudge: name the underlying concept via `concept` so the human learns the pattern, not just the fix.)";
        return {
          content: [{ type: "text", text: `Reasoning logged. Proceed with code changes.${nudge}${await getPassiveFeedback()}` }],
        };
      }

      case "present_code_change": {
        const proposals: string[] = [
          args?.filePath ?? "",
          args?.reasoning ?? "",
        ].filter(Boolean);
        const proposalPaths: string[] = args?.filePath ? [String(args.filePath)] : [];
        const blocked = await preflightRejectedApproaches("present_code_change", proposals, proposalPaths);
        if (blocked) return blocked;

        const id = `art_${nanoid(10)}`;
        const artifact = await store.createArtifact({
          id,
          type: "code_change",
          title: `${args?.changeType ?? "modify"} ${args?.filePath ?? "file"}`,
          content: {
            filePath: args?.filePath,
            changeType: args?.changeType ?? "modify",
            before: args?.before ?? "",
            after: args?.after ?? "",
            reasoning: args?.reasoning,
            confidence: args?.confidence,
          },
          agentReasoning: args?.reasoning,
          relatedArtifactIds: args?.relatedFindings,
        });
        broadcast({ type: "artifact_created", artifact });
        return {
          content: [{ type: "text", text: `Code change presented for review (${id}): ${args?.changeType} ${args?.filePath}. Human can review at localhost:${port}.${await getPassiveFeedback()}` }],
        };
      }

      case "check_feedback": {
        // If no immediate feedback exists, long-poll for up to 30 seconds
        const unackComments = await store.getUnacknowledgedComments();
        const resolvedDecs = await store.getResolvedDecisions();
        const hasImmediate = unackComments.length > 0 || resolvedDecs.length > 0;

        if (!hasImmediate) {
          // Check if there are draft artifacts — if so, wait for human action
          const allArts = await store.getArtifacts();
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
              await store.recordApprovedPattern(approvedDescription);
              broadcast({
                type: "ledger_write",
                kind: "approved",
                description: approvedDescription,
                sourceArtifactId: d.artifactId,
              });
              const rejected = d.options.filter((o: any) => o.id !== d.response?.optionId);
              // The winning option's description often encodes the concept
              // ("a managed queue — we pay per job, not per month"). Use it
              // as the concept tag so future pre-flight catches paraphrases.
              const concept = option?.description ?? undefined;
              for (const rej of rejected) {
                const rejectedDescription = `${d.context}: ${rej.title}`;
                await store.recordRejectedApproach(
                  rejectedDescription,
                  d.response?.reasoning,
                  d.artifactId,
                  concept,
                );
                broadcast({
                  type: "ledger_write",
                  kind: "rejected",
                  description: rejectedDescription,
                  concept,
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

      case "request_horizon_check": {
        const artifactId = String(args?.artifactId ?? "").trim();
        const horizon = String(args?.horizon ?? "").trim();
        if (!artifactId) {
          return {
            content: [{ type: "text", text: "request_horizon_check requires artifactId." }],
            isError: true,
          };
        }
        if (!["3mo", "1y", "2y"].includes(horizon)) {
          return {
            content: [{ type: "text", text: "request_horizon_check: horizon must be '3mo', '1y', or '2y'." }],
            isError: true,
          };
        }
        const artifacts = await store.getArtifacts();
        const artifact = artifacts.find((a) => a.id === artifactId);
        if (!artifact) {
          return {
            content: [{ type: "text", text: `request_horizon_check: no artifact with id ${artifactId}.` }],
            isError: true,
          };
        }

        const horizonLabel =
          horizon === "3mo" ? "3 months" :
          horizon === "1y" ? "1 year" :
          "2 years";

        const customPrompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
        const defaultPrompt =
          artifact.type === "decision"
            ? `In ${horizonLabel}, what's most likely to make us regret this choice? What signals would tell us it was wrong?`
            : artifact.type === "plan"
              ? `In ${horizonLabel}, what assumption in this plan is most likely to break? Which step has the most hidden coupling?`
              : artifact.type === "code_change"
                ? `In ${horizonLabel}, which line in this change would I look at first if this system broke?`
                : `In ${horizonLabel}, what's most likely to go wrong with this?`;

        const content = customPrompt || defaultPrompt;

        const horizonCommentId = `cmt_${nanoid(10)}`;
        const horizonComment = await store.addComment({
          id: horizonCommentId,
          artifactId,
          content,
          author: "agent",
          target: { artifactId, sectionId: `horizon_check:${horizon}` } as any,
          intent: "question",
        } as any);

        broadcast({ type: "comment_added", comment: horizonComment });

        return {
          content: [{
            type: "text",
            text: `Horizon check (${horizonLabel}) posted on ${artifactId}: "${content}"\nThe human will answer in the companion UI. Pick their reply up via check_feedback and consider it when you proceed.${await getPassiveFeedback()}`,
          }],
        };
      }

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
        let parent: any = undefined;
        if (typeof (store as any).getComment === "function") {
          parent = await (store as any).getComment(commentId);
        }
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

        if (typeof (store as any).markCommentAnswered === "function") {
          await (store as any).markCommentAnswered(commentId, answerId);
        }

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
        const mode = args?.mode as "supersede" | "retract" | undefined;
        const reason = String(args?.reason ?? "").trim();
        if (!artifactId || !reason || (mode !== "supersede" && mode !== "retract")) {
          return {
            content: [{ type: "text", text: "revise_artifact requires artifactId, mode ('supersede' | 'retract'), and reason." }],
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
          await store.updateArtifactStatus(old.id, "superseded");

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

          return {
            content: [{ type: "text", text: `Superseded ${artifactId} → ${newId} (v${old.version + 1}). Draft is awaiting review.${await getPassiveFeedback()}` }],
          };
        }

        // mode === "retract"
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
            content: [{ type: "text", text: `revise_artifact: ${artifactId} is ${artifact.status}, too late to retract. Use check_feedback instead.` }],
            isError: true,
          };
        }
        await store.updateArtifactStatus(artifactId, "retracted");
        await store.addComment({
          id: `cmt_${nanoid(10)}`,
          artifactId,
          content: `Retracted: ${reason}`,
          author: "agent",
        });
        broadcast({ type: "artifact_updated", artifactId, status: "retracted" });
        return {
          content: [{ type: "text", text: `Retracted ${artifactId}. Continue your workflow — call check_feedback or present a revised artifact.${await getPassiveFeedback()}` }],
        };
      }

      case "recall": {
        const query = String(args?.query ?? "").trim();
        const mode = (args?.mode ?? "any") as "philosophy" | "sessions" | "any";
        const stanceFilter = typeof args?.stance === "string" ? args.stance : undefined;
        const limit = Math.min(
          Math.max(typeof args?.limit === "number" ? args.limit : 20, 1),
          100,
        );

        // --- Philosophy branch ---
        const runPhilosophy = async () => {
          const concept = query || undefined;
          const entries = getGlobalStore().query({
            concept,
            stance: stanceFilter as "avoid" | "prefer" | "mixed" | undefined,
            limit,
          });
          return entries;
        };

        // --- Sessions branch ---
        const runSessions = async () => {
          if (!query) return [];
          if (typeof (store as any).searchSessions !== "function") return [];
          return (store as any).searchSessions(query, limit);
        };

        if (mode === "philosophy") {
          const entries = await runPhilosophy();
          if (entries.length === 0) {
            return {
              content: [{
                type: "text",
                text: query
                  ? `No philosophy-ledger entries match "${query}" yet. The user hasn't expressed a cross-project stance on this concept.`
                  : "The philosophy ledger is empty. It builds as the user approves / rejects concepts across sessions.",
              }],
            };
          }
          const formatted = entries.slice(0, 10).map((e) => {
            const rejections = e.instances.filter((i) => i.verdict === "rejected").length;
            const approvals = e.instances.filter((i) => i.verdict === "approved").length;
            const projects = new Set(e.instances.map((i) => i.project)).size;
            const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
            const reasonLine = latestReason ? `\n    latest reason: "${latestReason}"` : "";
            return `- [${e.stance.toUpperCase()}] "${e.concept}" — ${rejections} reject${rejections !== 1 ? "s" : ""}, ${approvals} approval${approvals !== 1 ? "s" : ""} across ${projects} project${projects !== 1 ? "s" : ""}${reasonLine}`;
          });
          const trailer = entries.length > 10 ? `\n…${entries.length - 10} more entries.` : "";
          return {
            content: [{
              type: "text",
              text: `Philosophy ledger (${entries.length} match${entries.length === 1 ? "" : "es"}${query ? ` for "${query}"` : ""}):\n${formatted.join("\n")}${trailer}\n\nWeight these strongly — especially 'avoid' stances with multi-project support.`,
            }],
          };
        }

        if (mode === "sessions") {
          if (!query) {
            return {
              content: [{ type: "text", text: "recall with mode='sessions' requires a query." }],
              isError: true,
            };
          }
          if (typeof (store as any).searchSessions !== "function") {
            return {
              content: [{ type: "text", text: "recall with mode='sessions' requires the daemon store (not available here)." }],
              isError: true,
            };
          }
          const results = await runSessions();
          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No past-session matches for "${query}".` }],
            };
          }
          const lines = results.slice(0, 20).map((r: any) => {
            const via = r.matchedVia?.length ? ` (via ${r.matchedVia.join(", ")})` : "";
            return `- [${r.sessionId}/${r.artifactId}] ${r.artifactType}: "${r.title}"${via}\n    ${r.excerpt}`;
          });
          const trailer = results.length > 20 ? `\n…${results.length - 20} more results.` : "";
          return {
            content: [{
              type: "text",
              text: `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${query}":\n${lines.join("\n")}${trailer}\n\nRead a full session via resource deeppairing://session/{id} or an artifact via deeppairing://artifact/{id}.`,
            }],
          };
        }

        // mode === "any" — union with philosophy first.
        if (!query) {
          return {
            content: [{ type: "text", text: "recall with mode='any' requires a query (or use mode='philosophy' with no query to list the ledger)." }],
            isError: true,
          };
        }
        const halfLimit = Math.max(5, Math.floor(limit / 2));
        const philosophyHits = getGlobalStore().query({ concept: query, limit: halfLimit });
        const sessionHits = await runSessions();

        if (philosophyHits.length === 0 && sessionHits.length === 0) {
          return {
            content: [{ type: "text", text: `No deepPairing memory matches "${query}".` }],
          };
        }

        const lines: string[] = [];
        if (philosophyHits.length > 0) {
          lines.push(`## Philosophy ledger (cross-project stances)`);
          for (const e of philosophyHits) {
            const latestReason = [...e.instances].reverse().find((i) => i.reason)?.reason;
            lines.push(`- [${e.stance.toUpperCase()}] "${e.concept}" × ${e.instances.length}${latestReason ? ` — "${latestReason}"` : ""}`);
          }
        }
        if (sessionHits.length > 0) {
          if (lines.length > 0) lines.push("");
          lines.push(`## Session artifacts (this project)`);
          for (const h of sessionHits.slice(0, 10)) {
            lines.push(`- ${h.artifactType}: "${h.title}" [${h.sessionId}]`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

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

      case "export_session": {
        const format = (args?.format ?? "full") as "full" | "pr-description" | "pr-comments" | "adr" | "replay";
        const state = await store.getFullState();
        // Include learner annotations when exporting as replay.
        const enriched =
          format === "replay" && typeof (store as any).getAnnotations === "function"
            ? { ...state, annotations: await (store as any).getAnnotations() }
            : state;
        const markdown = formatSessionMarkdown(enriched, format);
        return {
          content: [{ type: "text", text: markdown }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    } })();

    // Append firstCallHint to the outgoing text content of any tool result so
    // the agent receives session memory (rejected approaches) on its very
    // first tool call regardless of which tool it was.
    if (firstCallHint && result?.content && Array.isArray(result.content)) {
      const first = result.content[0] as any;
      if (first?.type === "text" && typeof first.text === "string") {
        first.text = `${first.text}${firstCallHint}`;
      }
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
