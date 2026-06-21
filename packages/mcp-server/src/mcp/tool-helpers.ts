import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { IStore } from "../store/store-interface.js";
import type { TeamPreference } from "@deeppairing/shared";
import {
  ELICIT_APPROVE_SCHEMA,
  decideElicitResponse,
} from "./elicit.js";
import { runPreflight, type PreflightTracePartial } from "./preflight-validator.js";

type BroadcastFn = (event: any) => void;

/**
 * X4 — shared per-call helpers, lifted out of server.ts so the CallTool
 * dispatcher reads as routing. Each helper is called once-per-request from
 * the corresponding tool case; they were closure-scoped before, but
 * nothing in them needed the closure beyond `server`/`store`/`broadcast`,
 * which are now arguments.
 */

/**
 * Try to elicit a quick response from the user via MCP elicitation. Falls
 * back gracefully if the client doesn't support it. Behavior is pinned by
 * `decideElicitResponse` (exported from elicit.ts) so the response-handling
 * logic can be unit-tested without an SDK round trip.
 */
export async function tryElicit(
  server: Server,
  message: string,
): Promise<"approve" | "review" | null> {
  // OFF by default. Terminal elicitation (a) contradicts deepPairing's
  // "review in the companion UI, not the terminal" model, and (b) competes
  // with Claude Code's own permission prompts in the same terminal — a
  // deepPairing approve prompt can sit on top of (and block) a real permission
  // request. Returning null routes the artifact to the UI for review, which is
  // what every caller already falls back to. Opt back into the terminal
  // quick-accept with DEEPPAIRING_TERMINAL_APPROVE=1.
  if (!terminalApproveEnabled(process.env)) return null;
  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: ELICIT_APPROVE_SCHEMA,
    });
    return decideElicitResponse(result);
  } catch {
    // Client doesn't support elicitation — fall back to polling
    return null;
  }
}

/** Terminal quick-approve via MCP elicitation is opt-in: it bypasses the
 *  companion-UI review surface and collides with Claude Code's permission
 *  prompts. Enabled only via DEEPPAIRING_TERMINAL_APPROVE=1/true/yes. */
export function terminalApproveEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.DEEPPAIRING_TERMINAL_APPROVE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Pre-flight: refuse to record an artifact whose content matches an
 * approach the human previously rejected (session-scoped) OR violates a
 * team-agreed avoid/require preference (committed to .deeppairing/team.json).
 *
 * Y1' — return shape now ALWAYS carries the trace (even on admit) so the
 * caller can persist it via store.recordPreflightTrace and the UI can
 * render the "Cross-checked your N prior stances" breadcrumb. Pre-Y1'
 * the helper returned `null` on admit and an error object on block,
 * which threw away the trace and forced the caller to re-run matchers
 * if they wanted to render it.
 *
 *   { ok: true, trace } — admitted; caller proceeds to createArtifact then
 *                         persists trace against the new artifact id.
 *   { ok: false, response, trace } — blocked; caller returns the error
 *                         response. Trace also has `decision: "blocked"`
 *                         and a populated `block` field for callers that
 *                         want to record it on the (un-created) artifact's
 *                         "would-have-been" id (most don't).
 *
 * U5 — the matching/orchestration logic lives in preflight-validator.ts.
 * This wrapper handles the side-effecty bits: reading the store, broad-
 * casting the block event, shaping the MCP tool-error response.
 */
export type PreflightHelperResult =
  | { ok: true; trace: PreflightTracePartial }
  | {
      ok: false;
      response: {
        content: Array<{ type: "text"; text: string }>;
        isError: true;
        // IV10 — structured error metadata; preflight blocks are
        // explicitly NOT retryable (the agent must revise the
        // approach, not the call shape).
        _meta?: { code?: string; retryable?: boolean };
      };
      trace: PreflightTracePartial;
    };

export async function preflightRejectedApproaches(
  store: IStore,
  broadcast: BroadcastFn,
  toolName: string,
  proposalStrings: string[],
  proposalPaths: string[] = [],
): Promise<PreflightHelperResult> {
  const memory = await store.getSessionMemory();
  // AA7b — typed optional method on IStore.
  const teamPrefs: TeamPreference[] = (await store.getTeamPreferences?.()) ?? [];

  const result = runPreflight({
    toolName,
    proposalStrings,
    proposalPaths,
    rejectedApproaches: memory.rejectedApproaches,
    teamPreferences: teamPrefs,
  });

  if (!result.blocked) {
    return { ok: true, trace: result.trace };
  }

  // Make the invisible moat felt: broadcast the block so the companion UI
  // can surface a toast.
  broadcast(result.block.broadcastEvent);

  // CC1 — append the trace summary to the block message too. Pre-CC1 the
  // agent saw the matched concept on block ("...which the user previously
  // rejected as X") but not the broader consideredCount / near-misses the
  // trace had already computed. Asymmetric: BB5 added the summary to the
  // ADMIT path so the agent narrates the moat on every successful
  // proposal, but on BLOCK — exactly when the moat is biting hardest —
  // the agent got the least context. formatPreflightTraceSummary is a
  // no-op when consideredCount===0 so this can't add noise on bootstrap.
  const blockSummary = formatPreflightTraceSummary(result.trace);
  return {
    ok: false,
    trace: result.trace,
    response: {
      content: [{ type: "text", text: result.block.message + blockSummary }],
      isError: true as const,
      // IV10 — REJECTED_APPROACH_BLOCKED is the headline machine code
      // the agent (and any downstream tooling) should branch on. The
      // same string is in result.block.message text — _meta lifts it
      // so strict clients can read it without prose-parsing. Not
      // retryable: re-issuing the same call hits the same gate; the
      // agent has to revise the approach.
      _meta: { code: "REJECTED_APPROACH_BLOCKED", retryable: false },
    },
  };
}

/**
 * Auto-name the session from the first meaningful artifact title. Idempotent
 * across the SessionNameLatch instance — once latched, subsequent calls are
 * no-ops, even with different titles.
 */
export class SessionNameLatch {
  private named = false;

  constructor(private readonly store: IStore) {}

  async maybeName(title: string): Promise<void> {
    if (this.named || !title || title === "Research Findings" || title === "Reasoning") return;
    this.named = true;
    // AA7b — renameSession is now optional on IStore (added in AA7a).
    await this.store.renameSession?.(title);
  }
}

/**
 * Y1' — persist the validator's trace against the freshly-created artifact
 * and broadcast it so the companion UI's PreflightBreadcrumb renders
 * without waiting for an HTTP roundtrip.
 *
 * Z1 — `recordPreflightTrace` is now properly optional on the IStore
 * interface (was a `(store as any)` cast pre-Z1), and DaemonClient
 * implements it. Pre-Z1 this silently no-op'd in daemon mode — the
 * production install path — so every standalone-wrapper user got the
 * Y1' broadcast but never the persisted trace, meaning a refresh
 * lost the breadcrumb. Now the optional check is type-safe and the
 * daemon path persists.
 */
export async function persistPreflightTrace(
  store: IStore,
  broadcast: BroadcastFn,
  artifact: { id: string },
  toolName: string,
  partial: PreflightTracePartial,
): Promise<void> {
  if (!store.recordPreflightTrace) return;
  const trace = {
    version: 1 as const,
    at: new Date().toISOString(),
    artifactId: artifact.id,
    toolName,
    decision: partial.decision,
    consideredCount: partial.consideredCount,
    consideredConcepts: partial.consideredConcepts,
    nearMisses: partial.nearMisses,
    block: partial.block,
  };
  await store.recordPreflightTrace(artifact.id, trace);
  broadcast({ type: "preflight_trace_recorded", artifactId: artifact.id, trace });
}

/**
 * HH10 — fire-and-forget MCP notifications/resources/list_changed
 * notification. Each present_* handler mints a new
 * deeppairing://artifact/{id} resource; pre-HH10 the agent had no
 * protocol-level signal that the resource list moved, so long-running
 * Claude Code sessions never speculatively re-listed and missed
 * mid-session artifacts.
 *
 * Wrap in try/catch — a buggy notification path must never break the
 * tool return. The MCP SDK's notification() is async-noisy under
 * adverse transports.
 */
export function notifyResourcesListChanged(server: any): void {
  try {
    server?.notification?.({ method: "notifications/resources/list_changed" });
  } catch {
    // Non-fatal; the next list call will still resolve correctly.
  }
}

/**
 * BB5 — short, agent-facing summary of the preflight consult that just
 * fired. Couples to the trace persisted by persistPreflightTrace so the
 * tool's return text mentions the moat at the moment it bit (or didn't).
 *
 * Pre-BB5 the trace was persisted + broadcast but the present_* return
 * string never mentioned consideredCount/nearMisses. Agents had to
 * separately call recall(mode='ledger') to learn that they'd just been
 * shaped — by which point the proposal was already on the human's
 * screen. With this in the return text, the agent's NEXT statement
 * to the user can acknowledge "considered 3 past stances; near-miss
 * on 'global mutable state'" without an extra round trip.
 *
 * Returns an empty string for the bootstrap case (no past stances yet)
 * so the very first artifact in a fresh project doesn't ship a noisy
 * "considered 0 past stance(s)" line.
 */
export function formatPreflightTraceSummary(trace: PreflightTracePartial): string {
  if (!trace || trace.consideredCount === 0) return "";
  const nm = trace.nearMisses ?? [];
  const nearMissText = nm.length
    ? `; near-miss${nm.length === 1 ? "" : "es"}: ${nm.map((n) => `"${n.concept}"`).join(", ")}`
    : "";
  return ` Preflight: considered ${trace.consideredCount} past stance${trace.consideredCount === 1 ? "" : "s"}${nearMissText}.`;
}

/**
 * Drain unacknowledged human comments and format them for the agent. Returns
 * an empty string when nothing is pending (so the caller can append it
 * unconditionally).
 */
export async function getPassiveFeedback(store: IStore): Promise<string> {
  const comments = await store.getUnacknowledgedComments();
  if (comments.length === 0) return "";
  await store.acknowledgeComments(comments.map((c) => c.id));
  const formatted = comments.map((c) => `- ${c.content}`).join("\n");
  return `\n\n[Human feedback]: ${formatted}`;
}

/**
 * Near-duplicate revision nudge. The agent tends to RE-POST a fresh present_*
 * when it's actually revising an artifact it already presented — which orphans
 * the thread and skips the revision diff (the human never sees what changed).
 * When a present_plan / present_spec lands and a LIVE artifact of the same type
 * with a similar title already exists, append a nudge pointing the agent at
 * revise_artifact — and hand it the artifactId so revising is frictionless.
 *
 * Advisory only: the artifact IS still created; this steers the NEXT call. We
 * gate on title similarity so genuinely-new artifacts (a second, unrelated plan)
 * don't get nagged.
 */
const LIVE_STATUSES = new Set(["draft", "approved", "revised"]);

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

/** Cheap title similarity: normalized equality, containment, or ≥50% token overlap. */
export function titlesSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const inter = [...ta].filter((w) => tb.has(w)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.5;
}

export async function revisionNudge(
  store: IStore,
  type: string,
  title: string,
  excludeId?: string,
): Promise<string> {
  const all = await store.getArtifacts();
  const prior = all
    .filter(
      (a) =>
        a.type === type &&
        a.id !== excludeId &&
        LIVE_STATUSES.has(a.status) &&
        titlesSimilar(a.title ?? "", title),
    )
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (prior.length === 0) return "";
  const match = prior[prior.length - 1]; // most recent live look-alike
  return (
    `\n\n↻ This looks like a revision of a live ${type} you already presented ` +
    `(${match.id}${match.title ? ` "${match.title}"` : ""}). Next time, call ` +
    `\`revise_artifact\` mode='supersede' artifactId='${match.id}' with the new content — ` +
    `it links the versions and gives your pair a clean before/after diff, instead of a ` +
    `separate ${type} that orphans the thread. (This one was still created.)`
  );
}
