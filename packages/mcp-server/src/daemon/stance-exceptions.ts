/**
 * #470 — one-proposal stance exceptions ("Allow this proposal once"), the
 * daemon core. Design: docs/design/stance-exceptions.md (rev 6).
 *
 * AUTHORITY (A1). Only `grant()` creates an allowance, and only the public,
 * bearer-gated, human-facing route below calls it. No MCP tool, IStore or
 * DaemonClient method, /api/internal/* route, hook, or file reaches it. An
 * allowance lives ONLY in this registry's memory (O1): nothing on disk can
 * arm one, and a daemon restart ends every grant. What IS durable is
 * non-authorizing — the block-log receipt, and the operation stamp on an
 * admitted artifact, which a replay reads to report and finish an operation
 * but never to create anything new. Receipts are not tamper-evident and never
 * name an authenticated person; `grantedVia` labels the door, nothing more.
 *
 * ORDERING. Single-threaded JS does not serialize across awaited flushes, so
 * every claim (runOperation), grant, revoke and startup reconciliation runs in
 * an explicit per-session queue held from the claim, through the child's
 * persistence and every follow-up, to the response (§13 condition 1).
 *
 * RELEASE ONLY ON PROOF (§13 condition 2). A claimed allowance is re-armed
 * only when the create threw AND the child is not in the store's memory (so no
 * buffer can still commit it). A failed flush is never proof: the child stays
 * buffered, the allowance stays consumed, and a retry replays the stamp.
 *
 * REPLAY (§13 condition 3). A stamped child is replayed without
 * re-authorization; only missing idempotent follow-ups are completed, never a
 * supersede over a status a human set since the claim, and only after every
 * follow-up target is checked against the lineage recorded on the child.
 */
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import type { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  ArtifactTypeSchema,
  ProposalPreconditionSchema,
  ProposalSnapshotSchema,
  type Artifact,
  type ArtifactAdmission,
  type ArtifactType,
  type DecisionOption,
  type PreflightTrace,
  type ProposalPrecondition,
  type ProposalSnapshot,
  type StanceAllowanceReceipt,
  type StanceAllowanceReceiptState,
  type StanceGrantOrigin,
  type StanceRef,
} from "@deeppairing/shared";
import type { FileStore } from "../store/file-store.js";
import { ERROR_CODES } from "../error-codes.js";
import { scanContentForSecrets } from "../secret-scan.js";
import { updatePreflightBlocks, readPreflightBlocks, type PreflightBlockEntry } from "../store/preflight-block-log.js";
import {
  EXCEPTION_TOOL_TYPES,
  MAX_SNAPSHOT_BYTES,
  checkPreconditions,
  effectiveDigest,
  sameStance,
  type PreconditionCheck,
} from "../mcp/proposal-resolution.js";

/** D1 + rev 3 amendment: an unused allowance never outlives 72 hours. */
export const ALLOWANCE_CEILING_MS = 72 * 60 * 60 * 1000;
/** Sent by DaemonClient on every request after /register (lower-cased). */
export const REGISTRATION_HEADER = "x-deeppairing-registration";
/** Self-reported grant origin label; `cli` or (default) `ui`. */
export const GRANT_ORIGIN_HEADER = "x-deeppairing-grant-origin";
/** In-memory block bindings kept for grants (the log itself keeps 50). */
const MAX_BLOCK_BINDINGS = 200;

type AllowanceState = "active" | "consumed" | "changed" | "revoked";
type DerivedState = AllowanceState | "ended" | "expired";

interface Registration {
  registrationId: string;
  sessionId: string;
  registeredAt: number;
  token: string;
}

interface BlockBinding {
  blockId: string;
  sessionId: string;
  source: "session" | "team";
  toolName?: string;
  stance?: StanceRef;
  registrationId?: string;
  callFingerprint?: string;
  snapshot?: ProposalSnapshot;
  preconditions?: ProposalPrecondition[];
  effectiveDigest?: string;
  eligible: boolean;
  ineligibleReason?: string;
  supersedesAllowanceId?: string;
}

export interface Allowance {
  id: string;
  state: AllowanceState;
  blockId: string;
  stance: StanceRef;
  sessionId: string;
  registrationId: string;
  toolName: string;
  artifactType: string;
  callFingerprint: string;
  effectiveDigest: string;
  snapshot: ProposalSnapshot;
  preconditions: ProposalPrecondition[];
  grantedAt: number;
  grantedVia: StanceGrantOrigin;
  reason: string;
  ceilingAt: number;
  operation?: { id: string; artifactId: string };
}

/** Test seam: throw at a named point to simulate a process crash there. */
export type StanceFaultPoint =
  | "after_claim"
  | "create_throws"
  | "after_child_flush"
  | "after_supersede"
  | "after_comment"
  | "after_decision"
  | "after_plan_review"
  | "after_trace"
  | "before_completed";

export interface StanceExceptionDeps {
  /** The daemon instance; embedded in every registrationId (§5). */
  instanceId: string;
  projectRoot: string;
  /** create-daemon's broadcast: fans out AND persists `preflight_blocked`. */
  broadcast: (sessionId: string, event: Record<string, unknown>) => void;
  getStore: (sessionId: string) => FileStore | undefined;
  now?: () => number;
  log?: (msg: string) => void;
  fault?: (point: StanceFaultPoint, operationId: string) => void;
}

export interface OperationRequest {
  exceptionIds: string[];
  toolName: string;
  snapshot: ProposalSnapshot;
  preconditions: ProposalPrecondition[];
  /** The admitted call's preflight trace (persisted against the child). */
  trace?: Record<string, unknown>;
  /** This call's own `preflight_blocked` event (without snapshot fields — the
   *  daemon re-attaches this request's), recorded only if the claim is refused
   *  because a dependency moved (the "changed" linkage). */
  block?: Record<string, unknown>;
}

export type OperationOutcome =
  | { status: "none" }
  | {
      status: "admitted" | "replayed";
      replayed: boolean;
      artifactId: string;
      decisionId?: string;
      parentId?: string;
      kind: "create" | "revise";
      grantedVia: StanceGrantOrigin;
      stances: string[];
      reasons: string[];
      supersedeSkipped?: string;
    }
  | {
      status: "refused";
      code: string;
      reason: string;
      state?: DerivedState;
      artifactId?: string;
      ceilingAt?: string;
      dependency?: { id: string | null; what: "prior" | "target"; detail: string };
      newBlockId?: string;
    }
  | { status: "inconsistent"; code: string; reason: string; artifactId: string };

/** Agent-facing receipt states (what the human sees, too). */
function receiptStateOf(state: DerivedState): StanceAllowanceReceiptState {
  return state === "active" ? "allowed" : state === "consumed" ? "used" : state;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class StanceExceptionRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly byToken = new Map<string, string>();
  private readonly blocks = new Map<string, BlockBinding>();
  /** Events this registry prepared; only these produce grantable bindings. */
  private readonly prepared = new WeakSet<object>();
  private readonly allowances = new Map<string, Allowance>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Admitted children not yet announced (first durable commit only). */
  private readonly pendingAnnounce = new Set<string>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: StanceExceptionDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  // --- Registrations (§5) ---------------------------------------------------

  /** Mint a registration for a wrapper's /register. In split mode a newer
   *  registration for the same session evicts the older ones (/mcp reconnect,
   *  --resume); fallback mode shares one session id across conversations, so
   *  nothing is evicted there. */
  register(sessionId: string, opts: { split: boolean }): { registrationId: string; registrationToken: string } {
    if (opts.split) {
      for (const reg of [...this.registrations.values()]) {
        if (reg.sessionId === sessionId) this.dropRegistration(reg);
      }
    }
    const registrationId = `reg_${this.deps.instanceId}_${randomBytes(8).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    this.registrations.set(registrationId, { registrationId, sessionId, registeredAt: this.now(), token });
    this.byToken.set(token, registrationId);
    return { registrationId, registrationToken: token };
  }

  /** /unregister. With the caller's token, only that registration ends; an old
   *  wrapper that sends none ends every registration of the session. */
  unregister(sessionId: string, token: string | undefined): void {
    const reg = this.resolveToken(token);
    if (token && reg) {
      if (reg.sessionId === sessionId) this.dropRegistration(reg);
      return;
    }
    for (const r of [...this.registrations.values()]) {
      if (r.sessionId === sessionId) this.dropRegistration(r);
    }
  }

  private dropRegistration(reg: Registration): void {
    this.registrations.delete(reg.registrationId);
    this.byToken.delete(reg.token);
  }

  /** The registration THIS daemon issued for a token. Never read from a body. */
  resolveToken(token: string | undefined | null): Registration | undefined {
    if (!token) return undefined;
    const id = this.byToken.get(token);
    return id ? this.registrations.get(id) : undefined;
  }

  private isLive(registrationId: string): boolean {
    return this.registrations.has(registrationId);
  }

  // --- Blocks ---------------------------------------------------------------

  /**
   * The internal preflight-block route hands every block through here. The
   * daemon strips whatever exception fields the caller sent and recomputes
   * them: the registration comes from the issued token, the digest is
   * computed here, and eligibility is decided here. Only the returned event
   * (tracked in `prepared`) can produce a grantable binding.
   */
  prepareBlockEvent(sessionId: string, token: string | undefined, body: Record<string, unknown>): Record<string, unknown> {
    const {
      artifactType: _a, callFingerprint: rawFingerprint, effectiveDigest: _d, snapshot: rawSnapshot,
      preconditions: rawPreconditions, stance: _s, registrationId: _r, eligible: _e, ineligibleReason: _i,
      supersedesAllowanceId: _x, ...event
    } = body;
    const reg = this.resolveToken(token);
    const match = (event.match && typeof event.match === "object" ? event.match : {}) as Record<string, unknown>;
    const source = event.source === "team" ? "team" : "session";
    const stance: StanceRef | undefined = source === "session" && typeof match.description === "string"
      ? {
          description: match.description,
          ...(typeof match.concept === "string" ? { concept: match.concept } : {}),
          ...(typeof match.rejectedAt === "string" ? { rejectedAt: match.rejectedAt } : {}),
        }
      : undefined;
    const fingerprint = typeof rawFingerprint === "string" && /^[0-9a-f]{64}$/.test(rawFingerprint) ? rawFingerprint : undefined;
    const base: Record<string, unknown> = {
      ...event,
      ...(fingerprint ? { callFingerprint: fingerprint } : {}),
      ...(stance ? { stance } : {}),
      ...(reg && reg.sessionId === sessionId ? { registrationId: reg.registrationId } : {}),
    };
    const ineligible = (why: string) => {
      const out = { ...base, eligible: false, ineligibleReason: why };
      this.prepared.add(out);
      return out;
    };
    if (source !== "session") return ineligible("team_rule");
    if (sessionId.startsWith("demo_")) return ineligible("demo_session");
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (!(toolName in EXCEPTION_TOOL_TYPES)) return ineligible("unsupported_tool");
    if (!stance) return ineligible("no_stance");
    if (!reg || reg.sessionId !== sessionId) return ineligible("no_registration");
    if (!fingerprint) return ineligible("no_snapshot");
    const snap = ProposalSnapshotSchema.safeParse(rawSnapshot);
    const pre = z.array(ProposalPreconditionSchema).safeParse(rawPreconditions);
    if (!snap.success || !pre.success || !ArtifactTypeSchema.safeParse(snap.data.type).success) return ineligible("no_snapshot");
    const expectedType = EXCEPTION_TOOL_TYPES[toolName];
    const expectedKind = toolName === "revise_artifact" ? "revise" : "create";
    if ((expectedType && snap.data.type !== expectedType) || snap.data.kind !== expectedKind) return ineligible("no_snapshot");
    if (Buffer.byteLength(JSON.stringify(snap.data)) > MAX_SNAPSHOT_BYTES) return ineligible("too_large");
    // The snapshot is persisted on the block entry for the preview, so it
    // passes the same scanner createArtifact uses. Flagged → not persisted.
    if (scanContentForSecrets({ title: snap.data.title, content: snap.data.content }).length > 0) return ineligible("secret_flagged");
    const out = {
      ...base,
      artifactType: snap.data.type,
      snapshot: snap.data,
      preconditions: pre.data,
      effectiveDigest: effectiveDigest(snap.data, pre.data),
      eligible: true,
    };
    this.prepared.add(out);
    return out;
  }

  /** create-daemon's broadcast calls this after it persists a block entry. */
  noteBlock(entry: PreflightBlockEntry | null, event: unknown): void {
    if (!entry || !event || typeof event !== "object" || !this.prepared.has(event)) return;
    const e = event as Record<string, unknown>;
    this.blocks.set(entry.id, {
      blockId: entry.id,
      sessionId: entry.sessionId,
      source: entry.source,
      toolName: entry.toolName,
      stance: e.stance as StanceRef | undefined,
      registrationId: e.registrationId as string | undefined,
      callFingerprint: e.callFingerprint as string | undefined,
      snapshot: e.snapshot as ProposalSnapshot | undefined,
      preconditions: e.preconditions as ProposalPrecondition[] | undefined,
      effectiveDigest: e.effectiveDigest as string | undefined,
      eligible: e.eligible === true,
      ineligibleReason: e.ineligibleReason as string | undefined,
      supersedesAllowanceId: e.supersedesAllowanceId as string | undefined,
    });
    while (this.blocks.size > MAX_BLOCK_BINDINGS) this.blocks.delete(this.blocks.keys().next().value!);
  }

  // --- The per-session operation queue (§13 condition 1) ---------------------

  private enqueue<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(sessionId, next.catch(() => undefined));
    return next;
  }

  // --- State -----------------------------------------------------------------

  private derived(a: Allowance): DerivedState {
    if (a.state !== "active") return a.state;
    if (this.now() >= a.ceilingAt) return "expired";
    if (!this.isLive(a.registrationId)) return "ended";
    return "active";
  }

  private receipt(a: Allowance, extra: Partial<StanceAllowanceReceipt> = {}): StanceAllowanceReceipt {
    return {
      id: a.id,
      grantedVia: a.grantedVia,
      grantedAt: iso(a.grantedAt),
      reason: a.reason,
      ceilingAt: iso(a.ceilingAt),
      state: receiptStateOf(this.derived(a)),
      ...(a.operation ? { artifactId: a.operation.artifactId } : {}),
      ...extra,
    };
  }

  /** The receipt as the human should see it now: an `allowed` receipt this
   *  daemon no longer holds is `ended` (or `expired` past its ceiling). */
  deriveReceipt(entry: PreflightBlockEntry): PreflightBlockEntry {
    const r = entry.allowance;
    if (!r) return entry;
    const live = this.allowances.get(r.id);
    let state = r.state;
    if (live) state = receiptStateOf(this.derived(live));
    else if (r.state === "allowed") state = this.now() >= Date.parse(r.ceilingAt) ? "expired" : "ended";
    return state === r.state ? entry : { ...entry, allowance: { ...r, state } };
  }

  private view(a: Allowance) {
    return {
      id: a.id,
      blockId: a.blockId,
      state: receiptStateOf(this.derived(a)),
      stance: a.stance,
      sessionId: a.sessionId,
      toolName: a.toolName,
      artifactType: a.artifactType,
      grantedAt: iso(a.grantedAt),
      grantedVia: a.grantedVia,
      reason: a.reason,
      ceilingAt: iso(a.ceilingAt),
      ...(a.operation ? { artifactId: a.operation.artifactId } : {}),
      snapshot: a.snapshot,
      preconditions: a.preconditions,
    };
  }

  list() {
    return [...this.allowances.values()].map((a) => this.view(a));
  }

  // --- Human routes: grant / revoke (§3, §4) -------------------------------

  async grant(blockId: string, reason: string, via: StanceGrantOrigin): Promise<{ status: number; body: Record<string, unknown> }> {
    const binding = this.blocks.get(blockId);
    if (!binding) {
      return { status: 404, body: { error: "No block with that id is held by this daemon.", code: ERROR_CODES.stance_exception_block_not_found } };
    }
    return this.enqueue(binding.sessionId, () => {
      // Idempotent: a double grant returns the same allowance.
      const existing = [...this.allowances.values()].find((a) => a.blockId === blockId);
      if (existing) return { status: 200, body: { allowance: this.view(existing), existing: true } };
      const refuse = (why: string, message: string) =>
        ({ status: 409, body: { error: message, code: ERROR_CODES.stance_exception_not_eligible, reason: why } });
      // D4 — the human's own stances only.
      if (binding.source !== "session") return refuse("team_rule", "Team rules can't be allowed once — only your own stances.");
      if (binding.sessionId.startsWith("demo_")) return refuse("demo_session", "Demo blocks can't be allowed.");
      if (!binding.eligible || !binding.snapshot || !binding.preconditions || !binding.effectiveDigest ||
          !binding.callFingerprint || !binding.registrationId || !binding.stance || !binding.toolName) {
        return refuse(binding.ineligibleReason ?? "not_eligible", "This block can't be allowed once.");
      }
      if (!this.isLive(binding.registrationId)) return refuse("session_ended", "That Claude session has ended, so there is nothing to allow.");
      const store = this.deps.getStore(binding.sessionId);
      const stanceRows = store?.getSessionMemory().rejectedApproaches ?? [];
      if (!stanceRows.some((r) => sameStance(r, binding.stance!))) {
        return refuse("stance_retired", "That stance is no longer on file (it was retired or changed).");
      }
      const grantedAt = this.now();
      const allowance: Allowance = {
        id: `sx_${nanoid(12)}`,
        state: "active",
        blockId,
        stance: binding.stance,
        sessionId: binding.sessionId,
        registrationId: binding.registrationId,
        toolName: binding.toolName,
        artifactType: binding.snapshot.type,
        callFingerprint: binding.callFingerprint,
        effectiveDigest: binding.effectiveDigest,
        snapshot: binding.snapshot,
        preconditions: binding.preconditions,
        grantedAt,
        grantedVia: via,
        reason,
        ceilingAt: grantedAt + ALLOWANCE_CEILING_MS,
      };
      this.allowances.set(allowance.id, allowance);
      const receipt = this.receipt(allowance);
      updatePreflightBlocks(this.deps.projectRoot, (e) =>
        e.id === blockId ? { ...e, allowance: receipt, seenAt: e.seenAt ?? iso(grantedAt) } : null);
      this.deps.broadcast(binding.sessionId, { type: "stance_exception_granted", blockId, allowance: receipt, stance: allowance.stance });
      this.log(`[stance-exception] granted ${allowance.id} via=${via} block=${blockId} sid=${binding.sessionId}`);
      return { status: 201, body: { allowance: this.view(allowance) } };
    });
  }

  async revoke(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const a = this.allowances.get(id);
    if (!a) return { status: 404, body: { error: "No allowance with that id is held by this daemon.", code: ERROR_CODES.stance_exception_block_not_found } };
    return this.enqueue(a.sessionId, () => {
      if (a.state === "consumed") {
        return { status: 409, body: { error: `Already used by ${a.operation?.artifactId ?? "an artifact"}.`, code: ERROR_CODES.stance_exception_claim_refused, state: "used", artifactId: a.operation?.artifactId } };
      }
      if (a.state === "changed") {
        return { status: 409, body: { error: "Already replaced: the proposal changed after you allowed it.", code: ERROR_CODES.stance_exception_claim_refused, state: "changed" } };
      }
      if (a.state === "active") {
        a.state = "revoked";
        const revokedAt = iso(this.now());
        const receipt = this.receipt(a, { revokedAt });
        updatePreflightBlocks(this.deps.projectRoot, (e) => (e.id === a.blockId ? { ...e, allowance: receipt } : null));
        this.deps.broadcast(a.sessionId, { type: "stance_exception_updated", blockId: a.blockId, allowance: receipt });
      }
      return { status: 200, body: { allowance: this.view(a) } };
    });
  }

  // --- Agent side: inspect (read-only) -------------------------------------

  /** §6 step 2 — never consumes. Candidates: ACTIVE allowances of the calling
   *  registration for this fingerprint. `inactive` explains a refusal. */
  inspect(sessionId: string, token: string | undefined, fingerprint: string) {
    const reg = this.resolveToken(token);
    const candidates: Array<{ id: string; stance: StanceRef; grantedVia: StanceGrantOrigin; reason: string }> = [];
    const inactive: Array<{ id: string; state: StanceAllowanceReceiptState; artifactId?: string; ceilingAt: string }> = [];
    const held = new Set<string>();
    for (const a of this.allowances.values()) {
      if (a.sessionId !== sessionId || a.callFingerprint !== fingerprint) continue;
      held.add(a.id);
      const st = this.derived(a);
      if (st === "active") {
        // Fallback mode: another live wrapper's allowance is not ours to claim.
        if (reg && a.registrationId === reg.registrationId) {
          candidates.push({ id: a.id, stance: a.stance, grantedVia: a.grantedVia, reason: a.reason });
        }
        continue;
      }
      inactive.push({ id: a.id, state: receiptStateOf(st), ...(a.operation ? { artifactId: a.operation.artifactId } : {}), ceilingAt: iso(a.ceilingAt) });
    }
    // An allowance granted by an EARLIER daemon instance (restart) survives
    // only as a receipt; report it as ended so the refusal names why.
    for (const e of readPreflightBlocks(this.deps.projectRoot)) {
      const r = e.allowance;
      if (!r || held.has(r.id) || e.sessionId !== sessionId || e.callFingerprint !== fingerprint) continue;
      const shown = this.deriveReceipt(e).allowance!;
      if (shown.state === "used") continue;
      inactive.push({ id: r.id, state: shown.state, ...(r.artifactId ? { artifactId: r.artifactId } : {}), ceilingAt: r.ceilingAt });
    }
    return { candidates, inactive };
  }

  // --- Agent side: the one authoritative operation route (§7) ---------------

  runOperation(
    sessionId: string,
    store: FileStore,
    token: string | undefined,
    operationId: string,
    fingerprint: string,
    request?: OperationRequest,
  ): Promise<OperationOutcome> {
    return this.enqueue(sessionId, () => {
      // 1. Replay or complete, before anything else.
      const stamped = findStamped(store.getArtifacts(), operationId, fingerprint);
      if (stamped) return this.complete(sessionId, store, stamped, true);
      if (!request) return { status: "none" } as const;
      return this.claimAndCreate(sessionId, store, token, operationId, fingerprint, request);
    });
  }

  private claimAndCreate(
    sessionId: string,
    store: FileStore,
    token: string | undefined,
    operationId: string,
    fingerprint: string,
    request: OperationRequest,
  ): OperationOutcome {
    const reg = this.resolveToken(token);
    const refused = (reason: string, extra: Partial<Extract<OperationOutcome, { status: "refused" }>> = {}): OperationOutcome =>
      ({ status: "refused", code: ERROR_CODES.stance_exception_claim_refused, reason, ...extra });
    const list = request.exceptionIds.map((id) => this.allowances.get(id));
    if (list.length === 0 || list.some((a) => !a)) return refused("unknown_allowance");
    const allowances = list as Allowance[];
    // 2. Claim: every listed allowance must be ours, active, and bound here.
    for (const a of allowances) {
      if (!reg || a.sessionId !== sessionId || a.registrationId !== reg.registrationId) return refused("not_this_registration");
      const st = this.derived(a);
      if (st !== "active") {
        return refused(st, { state: st, ceilingAt: iso(a.ceilingAt), ...(a.operation ? { artifactId: a.operation.artifactId } : {}) });
      }
      if (a.callFingerprint !== fingerprint) return refused("fingerprint_mismatch");
    }
    const bound = allowances[0]!;
    if (allowances.some((a) => a.effectiveDigest !== bound.effectiveDigest)) return refused("snapshot_mismatch");
    // A fresh read of preferences.json: a stance retired since the grant ends it.
    const rows = store.getSessionMemory().rejectedApproaches;
    if (allowances.some((a) => !rows.some((r) => sameStance(r, a.stance)))) return refused("stance_retired");
    // Re-resolve the preconditions from the daemon's OWN store.
    const check = checkPreconditions(store.getArtifacts(), bound.preconditions);
    if (!check.ok) return this.markChanged(sessionId, token, fingerprint, allowances, check, request);
    // The client's resolution must hash equal to what was allowed. What is
    // created is the STORED snapshot either way; a mismatch refuses and
    // (nothing having moved underneath) leaves the allowance active.
    if (effectiveDigest(request.snapshot, request.preconditions) !== bound.effectiveDigest) {
      return { status: "refused", code: ERROR_CODES.stance_exception_dependencies_changed, reason: "client_snapshot_mismatch" };
    }
    for (const a of allowances) a.state = "consumed";
    this.deps.fault?.("after_claim", operationId);

    // 3. Create the child from the stored snapshot; mint every id now.
    const snapshot = structuredClone(bound.snapshot);
    const childId = `art_${nanoid(10)}`;
    const content = snapshot.content;
    const followUps: ArtifactAdmission["followUps"] = {};
    let parent: Artifact | undefined;
    if (snapshot.kind === "revise") {
      parent = store.getArtifacts().find((a) => a.id === snapshot.parentId);
      followUps.supersede = { parentId: snapshot.parentId!, fromStatus: parent?.status ?? "missing" };
      followUps.comment = { id: `cmt_op_${operationId}`, artifactId: snapshot.parentId!, content: `Superseded by ${childId}: ${snapshot.agentReasoning ?? ""}` };
    }
    if (snapshot.type === "decision" && Array.isArray(content.options)) {
      const decisionId = `dec_${nanoid(10)}`;
      content.decisionId = decisionId;
      const contextText = typeof content.context === "string" ? content.context : snapshot.title;
      followUps.decision = {
        decisionId,
        artifactId: childId,
        context: snapshot.kind === "revise" ? contextText : String(content.context ?? ""),
        ...(snapshot.kind === "create" && typeof content.title === "string" ? { title: content.title } : {}),
        options: content.options as unknown[],
        ...(content.stakes === "low" || content.stakes === "medium" || content.stakes === "high" ? { stakes: content.stakes } : {}),
      };
    }
    if (snapshot.type === "plan") followUps.planReview = true;
    if (request.trace) {
      followUps.trace = {
        ...request.trace,
        version: 1,
        at: iso(this.now()),
        artifactId: childId,
        toolName: request.toolName,
        exception: { allowanceIds: allowances.map((a) => a.id), grantedVia: bound.grantedVia, stances: allowances.map((a) => a.stance.concept ?? a.stance.description) },
      };
    }
    const admission: ArtifactAdmission = {
      operationId,
      callFingerprint: fingerprint,
      effectiveDigest: bound.effectiveDigest,
      kind: snapshot.kind,
      exceptionIds: allowances.map((a) => a.id),
      grantedVia: bound.grantedVia,
      followUps,
    };
    for (const a of allowances) a.operation = { id: operationId, artifactId: childId };
    try {
      this.deps.fault?.("create_throws", operationId);
      store.createAdmittedArtifact({
        id: childId,
        type: snapshot.type as ArtifactType,
        title: snapshot.title,
        content,
        ...(snapshot.agentReasoning !== undefined ? { agentReasoning: snapshot.agentReasoning } : {}),
        ...(snapshot.relatedArtifactIds ? { relatedArtifactIds: snapshot.relatedArtifactIds } : {}),
        ...(snapshot.parentId ? { parentId: snapshot.parentId } : {}),
        ...(snapshot.version ? { version: snapshot.version } : {}),
        ...(snapshot.feature ? { feature: snapshot.feature } : {}),
      }, admission);
    } catch (error) {
      // Release only on proof: nothing in memory means nothing can commit.
      if (!store.getArtifacts().some((a) => a.id === childId)) {
        for (const a of allowances) { a.state = "active"; delete a.operation; }
      }
      throw error;
    }
    this.pendingAnnounce.add(childId);
    // A failed flush throws to the route (503/500) with the child BUFFERED and
    // the allowance consumed: a retry replays the stamp; nothing is re-armed.
    store.forceFlush();
    this.announce(sessionId, store, childId);
    this.deps.fault?.("after_child_flush", operationId);
    const child = store.getArtifacts().find((a) => a.id === childId)!;
    return this.complete(sessionId, store, child, false);
  }

  /** §7 Races — the dependency moved: refuse, mark `changed`, and record this
   *  call's block as the new entry the human can allow instead. */
  private markChanged(
    sessionId: string,
    token: string | undefined,
    fingerprint: string,
    allowances: Allowance[],
    check: Extract<PreconditionCheck, { ok: false }>,
    request: OperationRequest,
  ): OperationOutcome {
    for (const a of allowances) a.state = "changed";
    let newBlockId: string | undefined;
    if (request.block && typeof request.block === "object") {
      // The new block carries THIS call's resolution (the request's snapshot),
      // so the human previews what would be created now.
      const ev = this.prepareBlockEvent(sessionId, token, {
        ...request.block, callFingerprint: fingerprint, snapshot: request.snapshot, preconditions: request.preconditions,
      });
      ev.supersedesAllowanceId = allowances[0]!.id;
      this.deps.broadcast(sessionId, ev);
      newBlockId = [...this.blocks.values()].find((b) => b.supersedesAllowanceId === allowances[0]!.id)?.blockId;
    }
    for (const a of allowances) {
      const receipt = this.receipt(a, newBlockId ? { supersededByBlockId: newBlockId } : {});
      updatePreflightBlocks(this.deps.projectRoot, (e) => (e.id === a.blockId ? { ...e, allowance: receipt } : null));
      this.deps.broadcast(sessionId, { type: "stance_exception_updated", blockId: a.blockId, allowance: receipt });
    }
    return {
      status: "refused",
      code: ERROR_CODES.stance_exception_dependencies_changed,
      reason: check.detail,
      state: "changed",
      dependency: { id: check.dependencyId, what: check.what, detail: check.detail },
      ...(newBlockId ? { newBlockId } : {}),
    };
  }

  /** Steps 4–6: finish every missing follow-up (each checks its own effect),
   *  set completedAt, mark the receipts used, respond. Shared by a fresh
   *  admission, both replay shapes, and startup reconciliation. */
  private complete(sessionId: string, store: FileStore, child: Artifact, replayed: boolean): OperationOutcome {
    const admission = structuredClone(child.admission!);
    const lineage = lineageProblem(child, admission, store.getArtifacts());
    if (lineage) {
      this.log(`[stance-exception] replay refused for ${child.id}: ${lineage}`);
      return { status: "inconsistent", code: ERROR_CODES.stance_exception_operation_inconsistent, reason: lineage, artifactId: child.id };
    }
    const fu = admission.followUps;
    const opId = admission.operationId;
    const persist = () => {
      store.setArtifactAdmission(child.id, admission);
      store.forceFlush();
    };
    // (a) supersede — only from the status the claim saw; never over a
    // verdict a human set since (record why instead).
    if (fu.supersede && !fu.supersede.skipped) {
      const parent = store.getArtifacts().find((a) => a.id === fu.supersede!.parentId);
      if (parent && parent.status !== "superseded") {
        if (parent.status === fu.supersede.fromStatus) {
          store.updateArtifactStatus(parent.id, "superseded", "agent_supersede");
          this.deps.broadcast(sessionId, { type: "artifact_updated", artifactId: parent.id, status: "superseded", reason: "agent_supersede" });
        } else {
          fu.supersede.skipped = parent.status;
        }
      } else if (!parent) {
        fu.supersede.skipped = "missing";
      }
      persist();
      this.deps.fault?.("after_supersede", opId);
    }
    // (b) the carryover comment, by its operation-derived id.
    if (fu.comment && !store.hasComment(fu.comment.id)) {
      const comment = store.addComment({ id: fu.comment.id, artifactId: fu.comment.artifactId, content: fu.comment.content, author: "agent" });
      persist();
      this.deps.broadcast(sessionId, { type: "comment_added", comment });
      this.deps.fault?.("after_comment", opId);
    }
    // (c) the decision request.
    if (fu.decision && !store.getDecision(fu.decision.decisionId)) {
      store.recordDecisionRequest({ ...fu.decision, options: fu.decision.options as DecisionOption[] });
      persist();
      this.deps.fault?.("after_decision", opId);
    }
    // (d) the plan review.
    if (fu.planReview && !store.hasPlanReview(child.id)) {
      store.recordPlanReview(child.id);
      persist();
      this.deps.fault?.("after_plan_review", opId);
    }
    // (e) the trace, keyed by artifact id (an atomic sidecar write).
    if (fu.trace && !store.getPreflightTrace(child.id)) {
      store.recordPreflightTrace(child.id, fu.trace as unknown as PreflightTrace);
      this.deps.fault?.("after_trace", opId);
    }
    this.deps.fault?.("before_completed", opId);
    // 5. Flush, then completedAt, then flush again.
    store.forceFlush();
    if (!admission.completedAt) {
      admission.completedAt = iso(this.now());
      persist();
    }
    this.announce(sessionId, store, child.id);
    for (const id of admission.exceptionIds) {
      updatePreflightBlocks(this.deps.projectRoot, (e) =>
        e.allowance?.id === id && (e.allowance.state !== "used" || e.allowance.artifactId !== child.id)
          ? { ...e, allowance: { ...e.allowance, state: "used", artifactId: child.id } }
          : null);
    }
    const held = admission.exceptionIds.map((id) => this.allowances.get(id)).filter((a): a is Allowance => !!a);
    const decisionId = (child.content as { decisionId?: unknown }).decisionId;
    return {
      status: replayed ? "replayed" : "admitted",
      replayed,
      artifactId: child.id,
      ...(typeof decisionId === "string" ? { decisionId } : {}),
      ...(child.parentId ? { parentId: child.parentId } : {}),
      kind: admission.kind,
      grantedVia: admission.grantedVia,
      stances: held.map((a) => a.stance.concept ?? a.stance.description),
      reasons: held.map((a) => a.reason),
      ...(fu.supersede?.skipped ? { supersedeSkipped: fu.supersede.skipped } : {}),
    };
  }

  /** First durable commit only: one artifact_created per admitted child. */
  private announce(sessionId: string, store: FileStore, childId: string): void {
    if (!this.pendingAnnounce.delete(childId)) return;
    const artifact = store.getArtifacts().find((a) => a.id === childId);
    if (artifact) this.deps.broadcast(sessionId, { type: "artifact_created", artifact });
  }

  /** Startup reconciliation: when the daemon loads a session, finish every
   *  stamped child that has no completedAt — through the same queue. */
  reconcile(sessionId: string, store: FileStore): Promise<void> {
    return this.enqueue(sessionId, () => {
      for (const child of store.getArtifacts()) {
        if (!child.admission || child.admission.completedAt) continue;
        try {
          this.complete(sessionId, store, child, true);
        } catch (error) {
          this.log(`[stance-exception] reconcile ${child.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }
}

/** Step 1 lookup: by operation id, else the newest by call fingerprint. */
function findStamped(artifacts: Artifact[], operationId: string, fingerprint: string): Artifact | undefined {
  const byOp = artifacts.find((a) => a.admission?.operationId === operationId);
  if (byOp) return byOp;
  return artifacts
    .filter((a) => a.admission?.callFingerprint === fingerprint)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

/** §13 condition 3 — every durable follow-up target must match the lineage
 *  recorded on the child itself. Null = consistent. */
function lineageProblem(child: Artifact, admission: ArtifactAdmission, artifacts: Artifact[]): string | null {
  const fu = admission.followUps ?? {};
  if (admission.kind === "revise") {
    if (!child.parentId) return "revise stamp on an artifact with no parent";
    if (!fu.supersede || fu.supersede.parentId !== child.parentId) return "supersede target is not the child's parent";
    if (!fu.comment || fu.comment.artifactId !== child.parentId) return "comment target is not the child's parent";
    if (fu.comment.id !== `cmt_op_${admission.operationId}`) return "comment id is not derived from the operation id";
    const parent = artifacts.find((a) => a.id === child.parentId);
    if (parent && child.version !== parent.version + 1) return "child version does not follow its parent";
  } else if (fu.supersede || fu.comment) {
    return "create stamp carries revise follow-ups";
  }
  if (fu.decision) {
    const decisionId = (child.content as { decisionId?: unknown }).decisionId;
    if (fu.decision.decisionId !== decisionId || fu.decision.artifactId !== child.id) return "decision target is not the child's decision";
  }
  if (fu.planReview && child.type !== "plan") return "plan review on a non-plan artifact";
  return null;
}

// --- Public, human-facing routes (A1: the ONLY door to grant()) -------------

const GrantBody = z.object({ reason: z.string() }).strict();

/**
 * Registered directly on createHttpRoutes' app, AFTER its middleware, so every
 * request here has already passed the loopback-Host, X-Project-Hash and (for
 * non-GET) bearer gates. On top of those, a request carrying a wrapper's
 * registration header is refused: that header is how DaemonClient — the
 * agent's side — identifies itself.
 */
export function registerStanceExceptionRoutes(app: Hono, registry: StanceExceptionRegistry): void {
  const fromAgent = (c: Context) => !!c.req.header(REGISTRATION_HEADER);
  const agentRefusal = (c: Context) =>
    c.json({ error: "Allowances are granted by your pair in the companion UI, never by the agent.", code: ERROR_CODES.stance_exception_interactive_required }, 403);

  app.post("/api/preflight-blocks/:blockId/exception", async (c) => {
    if (fromAgent(c)) return agentRefusal(c);
    let body: z.infer<typeof GrantBody>;
    try {
      body = GrantBody.parse(await c.req.json());
    } catch {
      return c.json({ error: "Expected exactly { reason }.", code: ERROR_CODES.validation_error }, 400);
    }
    const reason = body.reason.trim();
    if (reason.length < 3 || reason.length > 280) {
      return c.json({ error: "Give a reason of 3–280 characters.", code: ERROR_CODES.stance_exception_reason_required }, 400);
    }
    const via: StanceGrantOrigin = c.req.header(GRANT_ORIGIN_HEADER) === "cli" ? "cli" : "ui";
    const out = await registry.grant(c.req.param("blockId"), reason, via);
    return c.json(out.body, out.status as 200);
  });

  app.post("/api/stance-exceptions/:id/revoke", async (c) => {
    if (fromAgent(c)) return agentRefusal(c);
    const out = await registry.revoke(c.req.param("id"));
    return c.json(out.body, out.status as 200);
  });

  app.get("/api/stance-exceptions", (c) => c.json({ allowances: registry.list() }));
}
