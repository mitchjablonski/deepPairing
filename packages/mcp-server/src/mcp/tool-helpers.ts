import { createHash } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { IStore } from "../store/store-interface.js";
import type { TeamPreference, Comment } from "@deeppairing/shared";
import type { ToolResult } from "./tools/types.js";
import {
  ELICIT_APPROVE_SCHEMA,
  decideElicitResponse,
} from "./elicit.js";
import { runPreflight, type PreflightTracePartial } from "./preflight-validator.js";
import { getAdvisoryRecall, tokenSetKey } from "./advisory-recall.js";

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
  proposalConcepts: string[] = [],
): Promise<PreflightHelperResult> {
  const memory = await store.getSessionMemory();
  // AA7b — typed optional method on IStore.
  const teamPrefs: TeamPreference[] = (await store.getTeamPreferences?.()) ?? [];

  // Phase-1 (C, advisory-first) — surface cross-project 'avoid' stances as an
  // ADVISORY overlay, NOT a hard block. A stance rejected in project A must
  // never refuse an artifact in project B; it only NUDGES ("you avoided this in
  // <project> — still want it here?"). Local session/team rejections remain the
  // only hard-block authority.
  //
  // #143 step 3 — the recall itself lives behind the AdvisoryRecall adapter
  // (advisory-recall.ts); today's only provider reads the global philosophy
  // ledger. Fail-open is part of the adapter contract: a recall error must
  // never break the tool — without the advisory overlay the gate still
  // enforces session + team.
  //
  // Finding 2/3 — dedupe against BOTH local rejections AND local
  // approvals/overrides (an approved/retired concept must not even nudge),
  // keyed on tokenSetKey (the matcher's own basis; see advisory-recall.ts).
  const localKeys = new Set<string>();
  for (const r of memory.rejectedApproaches) {
    const k = tokenSetKey(r.concept ?? r.description);
    if (k) localKeys.add(k);
  }
  for (const a of memory.approvedPatterns) {
    const k = tokenSetKey(a);
    if (k) localKeys.add(k);
  }
  const globalAdvisoryConcepts = getAdvisoryRecall().conceptsFor({
    localConceptKeys: localKeys,
  });

  const result = runPreflight({
    toolName,
    proposalStrings,
    proposalPaths,
    proposalConcepts,
    rejectedApproaches: memory.rejectedApproaches,
    teamPreferences: teamPrefs,
    globalAdvisoryConcepts,
  });

  if (!result.blocked) {
    // Phase-1 (D) — instrument the residual. A LOCAL near-miss that was ADMITTED
    // (token coverage in [threshold,1)) is exactly the fuzzy signal Phase 2
    // (embeddings) would target. Count each one so the embeddings decision is
    // data-driven. Cross-project ("global") near-misses are a different signal
    // (advisory nudge), so they're excluded from this counter. Fire-and-forget;
    // recordMetric is a no-op on stores that don't implement it.
    for (const nm of result.trace.nearMisses) {
      if (nm.source === "session" || nm.source === "team") {
        void store.recordMetric?.({ kind: "preflight_near_miss", source: nm.source });
      }
    }
    return { ok: true, trace: result.trace };
  }

  // Make the invisible moat felt: broadcast the block so the companion UI
  // can surface a toast.
  broadcast(result.block.broadcastEvent);

  // Q2 — ...except that in the PRODUCTION install path the line above reaches
  // nobody: standalone.ts hands createMcpServer a `noop` broadcast (the daemon
  // does its own broadcasting on mutations it owns), and a block is not a
  // mutation the daemon ever sees. So the single most distinctive deepPairing
  // moment fired invisibly for everyone except demo users — whose block IS
  // daemon-side, and is even replayed to late joiners. Route it explicitly, on
  // the same F1 seam the metric already uses: the daemon fans it to attached
  // tabs (live toast) AND persists it to the project block log (durable, so a
  // closed browser or a reload no longer erases the moment). Fire-and-forget:
  // the refusal below is already correct; surfacing must never be able to
  // break it.
  void store.recordPreflightBlock?.(result.block.broadcastEvent);

  // F1 — record the preflight-block metric at its truth point. The broadcast
  // above is a no-op in standalone (the wrapper's broadcast), so the daemon's
  // tap never saw a real block; route it to the daemon explicitly instead.
  // Fire-and-forget (DaemonClient.recordMetric swallows errors).
  void store.recordMetric?.({ kind: "preflight_block", source: result.block.source });

  // CC1 — append the trace summary to the block message too. Pre-CC1 the
  // agent saw the matched concept on block ("...which the user previously
  // rejected as X") but not the broader consideredCount / near-misses the
  // trace had already computed. Asymmetric: BB5 added the summary to the
  // ADMIT path so the agent narrates the moat on every successful
  // proposal, but on BLOCK — exactly when the moat is biting hardest —
  // the agent got the least context. formatPreflightTraceSummary is a
  // no-op when there is nothing to report (no local stances considered AND
  // no near-misses) so this can't add noise on bootstrap.
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
 * Returns an empty string for the bootstrap case (no past stances yet AND
 * nothing to say) so the very first artifact in a fresh project doesn't
 * ship a noisy "considered 0 past stance(s)" line.
 *
 * Q2 — THE CROSS-PROJECT NUDGE, DELIVERED. Pre-Q2 this bailed on
 * `consideredCount === 0` alone. `consideredCount` counts LOCAL stances only
 * (session rejections + team prefs — see runPreflight's `considered` list;
 * cross-project advisory hits land in `nearMisses` with source "global" and
 * are deliberately NOT counted there). So a FRESH project — zero local
 * stances, which is EXACTLY the case the cross-project ledger exists for —
 * computed the advisory near-miss into preflight-traces.json, broadcast it to
 * the UI breadcrumb, and then returned "" to the agent. The promised sentence
 * ("You avoided this in projA — still want it here?") never reached the model
 * in its canonical scenario.
 *
 * The guard now keys on "is there anything to say" (a local count OR any
 * near-miss), and the "considered N" clause is emitted only when N > 0 — the
 * bootstrap quiet case is preserved for a genuinely empty consult (no local
 * stances, no near-misses → still ""), while the noisy "considered 0" prefix
 * never appears.
 *
 * Global near-misses additionally get the nudge spelled out (concept + which
 * project + your reason) rather than only appearing as a bare quoted concept
 * in the near-miss list: the whole value of an advisory is the question it
 * asks, and it must be unmistakably NOT a block.
 */
export function formatPreflightTraceSummary(trace: PreflightTracePartial): string {
  if (!trace) return "";
  const nm = trace.nearMisses ?? [];
  // Nothing local considered AND nothing brushed → stay silent (bootstrap).
  if (trace.consideredCount === 0 && nm.length === 0) return "";
  const clauses: string[] = [];
  if (trace.consideredCount > 0) {
    clauses.push(
      `considered ${trace.consideredCount} past stance${trace.consideredCount === 1 ? "" : "s"}`,
    );
  }
  if (nm.length) {
    clauses.push(
      `near-miss${nm.length === 1 ? "" : "es"}: ${nm.map((n) => `"${n.concept}"`).join(", ")}`,
    );
  }
  let out = ` Preflight: ${clauses.join("; ")}.`;
  const nudges = nm
    .filter((n) => n.source === "global")
    .map((n) => {
      const where = n.project ? `in "${n.project}"` : "in another project";
      const because = n.reason ? ` (your reason: "${n.reason}")` : "";
      return `You avoided "${n.concept}" ${where}${because} — still want it here?`;
    });
  if (nudges.length) {
    out += ` Cross-project advisory (not a block, and you have no local stance on this here): ${nudges.join(" ")}`;
  }
  return out;
}

/**
 * #225 (N1, F1) — an obligation-bearing comment is one whose only faithful
 * delivery is check_feedback's RICH lane: a suggested edit (must-respond
 * apply/counter) or an unanswered question (answer_question). A plain comment
 * carries no such lane — its full content IS the delivery.
 */
export function isObligationBearingComment(c: Comment): boolean {
  return !!c.suggestion || (c.intent === "question" && !c.answeredByCommentId);
}

/**
 * Drain unacknowledged human comments and format them for the agent. Returns
 * an empty string when nothing is pending (so the caller can append it
 * unconditionally).
 *
 * #225 (N1, F1) — the drain SKIPS obligation-bearing comments (questions /
 * suggested edits). This passive drain acknowledges what it surfaces and renders
 * it as a bare context-free line — lossless for chatter (a plain comment's whole
 * content is right here, and acking it loses nothing check_feedback would have
 * re-shown), but LOSSY for an obligation: a suggested edit's must-respond lane
 * and a question's answer_question lane exist ONLY in check_feedback. If this
 * drain acked those, the obligation would silently die on the next poll (the
 * suggestion lane vanishes entirely; a question survives only via the #192
 * carryover backstop). So leave obligation-bearing comments UNACKNOWLEDGED for
 * the next check_feedback to deliver richly; drain only the plain comments. This
 * is the same swallow class the supersede fix closed, one level down: it applies
 * to EVERY tool return that appends passive feedback (present_*, withdraw,
 * revise retract/obsolete, log_reasoning) after a carry.
 *
 * N2 (#226 scope 6) — `excludeIds` suppresses specific comments from the ECHOED
 * text while STILL acknowledging them, stacked ON TOP of the N1 skip. It exists
 * because an answered question is NO LONGER obligation-bearing (answeredBy-
 * CommentId is set → isObligationBearingComment false), so it becomes a plain
 * drainable comment: answer_question passes the just-answered comment id here so
 * its own reply doesn't splice the human's question back as "[Human feedback]: -
 * <the question>" (a lie — that text is not new feedback). We still acknowledge
 * the excluded id so it doesn't linger unacknowledged and re-drain later.
 */
export async function getPassiveFeedback(store: IStore, excludeIds: string[] = []): Promise<string> {
  const comments = await store.getUnacknowledgedComments();
  if (comments.length === 0) return "";
  // N1 (#225) — never drain/ack obligation-bearing comments (questions /
  // suggested edits); leave them for check_feedback's rich lane.
  const drainable = comments.filter((c) => !isObligationBearingComment(c));
  if (drainable.length === 0) return "";
  // Acknowledge ALL drainable comments (including N2-excluded ones — they have
  // now been seen/handled) so nothing re-surfaces on a later unrelated drain.
  await store.acknowledgeComments(drainable.map((c) => c.id));
  // N2 (#226 scope 6) — keep excluded comments out of the visible echo.
  const exclude = new Set(excludeIds);
  const shown = drainable.filter((c) => !exclude.has(c.id));
  if (shown.length === 0) return "";
  const formatted = shown.map((c) => `- ${c.content}`).join("\n");
  return `\n\n[Human feedback]: ${formatted}`;
}

/**
 * N2 (#226 scope 1) — short-window content-hash de-duplication for the
 * present_* tools. Two IDENTICAL calls in quick succession (an agent-side retry
 * wrapper re-sending, a double-fire) used to mint two draft artifacts — a twin
 * on the human's review queue for the same content. This registry catches that:
 * a matching (tool + content-hash) presentation seen within `windowMs`, whose
 * prior artifact is STILL a draft, returns the existing artifact instead of a
 * twin.
 *
 * Deliberately status-scoped: a re-present AFTER the human rejected (or the
 * artifact was superseded/withdrawn) is a LEGITIMATE fresh proposal and MUST
 * mint — the freshlyRejected re-propose flow depends on it. So a hit only
 * short-circuits while the prior artifact is `draft`; any other status falls
 * through to mint.
 *
 * Concurrency-safe: for a fresh key the get→reserve pair below has no `await`
 * between them, so two concurrent identical calls can never both become the
 * "owner". The second awaits the owner's in-flight promise, then checks the
 * committed artifact's live status.
 */
type PresentSettled = { artifactId: string } | null;

interface PresentEntry {
  at: number;
  promise: Promise<PresentSettled>;
  /** True once the owner has committed/aborted. Only settled+expired entries
   *  are swept — an in-flight reservation (a live owner, or a promise a waiter
   *  is mid-await on) is never evicted out from under anyone. */
  settled: boolean;
}

export interface PresentIdempotencyBegin {
  /** A live duplicate draft exists — return the dedup response, don't mint. */
  duplicate?: { artifactId: string; type: string };
  /** Caller owns creation: call after a SUCCESSFUL createArtifact. */
  commit?: (artifactId: string) => void;
  /** Caller owns creation but createArtifact threw — release the reservation
   *  so an honest retry can mint (nothing was created, so it's not a dup). */
  abort?: () => void;
}

export class PresentIdempotencyRegistry {
  private readonly entries = new Map<string, PresentEntry>();

  constructor(
    private readonly windowMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Live reservation count — for tests asserting the F1 sweep prunes. */
  get size(): number {
    return this.entries.size;
  }

  async begin(store: IStore, toolName: string, contentHash: string): Promise<PresentIdempotencyBegin> {
    const key = `${toolName}::${contentHash}`;
    // F1 - evict settled+expired reservations so the map cannot grow unbounded
    // (one entry per distinct present-hash for the whole process lifetime).
    this.sweep(this.now());
    // F2 - loop so that when we fall through from a settled-but-unusable
    // reservation (the owner's createArtifact threw, or the prior artifact left
    // draft), EXACTLY ONE caller re-adopts as the new owner and the rest wait on
    // it. Without this, N concurrent waiters all resolve, all fall through, and
    // all re-reserve -> all mint (the thundering-herd double-mint).
    for (;;) {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && now - existing.at < this.windowMs) {
      // A recent identical presentation is in flight or just landed. Wait for
      // the owner to settle (handles the concurrent double-fire), then verify
      // the committed artifact is STILL a draft before de-duplicating.
      const settled = await existing.promise;
      if (settled) {
        const art = (await store.getArtifacts()).find((a) => a.id === settled.artifactId);
        if (art && art.status === "draft") {
          return { duplicate: { artifactId: art.id, type: art.type } };
        }
      }
      // Owner failed, or the prior artifact is no longer a draft (rejected /
      // superseded / withdrawn) -> a re-present is legitimate. Re-adopt
      // atomically: only the caller that still sees `existing` as the current
      // entry becomes the new owner (there is no await between this get and
      // reserve's set); every other faller-through loops and waits on the
      // replacement reservation.
      if (this.entries.get(key) === existing) {
        return this.reserve(key, now);
      }
      continue;
    }
    return this.reserve(key, now);
    }
  }

  /** Create + register a fresh owner reservation for `key`. Synchronous, so a
   *  fresh-key get->reserve pair in begin() is atomic w.r.t. concurrent callers. */
  private reserve(key: string, now: number): PresentIdempotencyBegin {
    let resolve!: (v: PresentSettled) => void;
    const promise = new Promise<PresentSettled>((r) => {
      resolve = r;
    });
    const entry: PresentEntry = { at: now, promise, settled: false };
    this.entries.set(key, entry);
    let done = false;
    return {
      commit: (artifactId: string) => {
        if (done) return;
        done = true;
        entry.settled = true;
        resolve({ artifactId });
      },
      abort: () => {
        if (done) return;
        done = true;
        entry.settled = true;
        resolve(null);
        // Only evict if we're still the current reservation for this key, so a
        // faller-through that already re-adopted is not clobbered.
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    };
  }

  /** F1 - drop settled reservations older than the window. In-flight (unsettled)
   *  entries are always recent (the owner settles within its handler call) and
   *  are never swept - a live owner or a mid-await waiter keeps its promise. */
  private sweep(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.settled && now - e.at >= this.windowMs) this.entries.delete(k);
    }
  }
}

/**
 * N2 — canonical content hash of a present_* call's raw arguments. Hashing the
 * agent-supplied ARGS (not the post-processed artifact content) sidesteps the
 * internally-generated ids — a decision's fresh `dec_`/`art_` nanoid would make
 * two identical calls' stored content differ — so two byte-identical calls hash
 * the same. Stable key ordering makes it order-insensitive.
 */
export function hashPresentArgs(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * N2 — the success response returned in place of minting a twin. Generic across
 * every present_* tool: it names the existing artifact id (so the agent can
 * withdraw/revise it) and states plainly that no duplicate was created.
 *
 * F4 — `port` must be the LIVE port (callers pass `store.getLivePort?.() ?? port`)
 * so the URL is correct after a mid-session daemon respawn. `extraStructured`
 * carries tool-specific ids (e.g. present_options' decisionId) alongside the
 * artifactId so the agent can drive the resolve flow from the dedup reply too.
 */
export function buildDedupResponse(
  dup: { artifactId: string; type: string },
  port: number,
  extraStructured?: Record<string, unknown>,
): ToolResult {
  const at = Number.isFinite(port) && port > 0 ? ` at localhost:${port}` : "";
  return {
    content: [
      {
        type: "text",
        text:
          `Already presented — returning the existing ${dup.type} artifact (${dup.artifactId}). ` +
          `An identical ${dup.type} was presented moments ago and is still awaiting review${at}; ` +
          `no duplicate was created. Call check_feedback for the human's response, or ` +
          `revise_artifact / withdraw_artifact on ${dup.artifactId} if it needs changing.`,
      },
    ],
    structuredContent: { artifactId: dup.artifactId, deduplicated: true, ...(extraStructured ?? {}) },
  };
}

/**
 * G1 (#198b) — when a present_* call carries a `servedRequestId`, link the
 * freshly-created artifact to the human's request so the composer flips it to a
 * served state and it drops out of the pending obligations. Best-effort +
 * fire-and-forget: serving an artifact must never FAIL because the link didn't
 * land. But the confirmation must be HONEST — markRequestServed reports whether
 * a request with that id actually existed, so an unknown/foreign id yields a
 * "not found" note rather than a false "Linked" claim.
 *
 * DELIBERATE (review item 3): a request STAYS served once linked, even if its
 * fulfilling artifact is later rejected. The reject posture already tells the
 * agent to revise, and a supersede carries the thread forward — auto-reopening
 * the request would double-nag. So there is no un-serve on reject by design.
 * Returns a short suffix for the tool's text result (or "").
 */
export async function linkServedRequest(
  store: IStore,
  args: Record<string, unknown> | null | undefined,
  artifactId: string,
): Promise<string> {
  const servedRequestId = (args as { servedRequestId?: unknown } | null | undefined)?.servedRequestId;
  if (typeof servedRequestId !== "string" || servedRequestId.length === 0) return "";
  try {
    const linked = (await store.markRequestServed?.(servedRequestId, artifactId)) ?? false;
    return linked
      ? ` Linked to request ${servedRequestId}.`
      : ` (request ${servedRequestId} not found — not linked.)`;
  } catch {
    // A transport failure is not proof either way; stay silent rather than
    // claim or deny a link we can't confirm.
    return "";
  }
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
  const match = prior.at(-1); // most recent live look-alike
  if (!match) return "";
  return (
    `\n\n↻ This looks like a revision of a live ${type} you already presented ` +
    `(${match.id}${match.title ? ` "${match.title}"` : ""}). Next time, call ` +
    `\`revise_artifact\` mode='supersede' artifactId='${match.id}' with the new content — ` +
    `it links the versions and gives your pair a clean before/after diff, instead of a ` +
    `separate ${type} that orphans the thread. (This one was still created.)`
  );
}
