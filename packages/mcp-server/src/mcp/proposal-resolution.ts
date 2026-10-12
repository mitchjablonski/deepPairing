import { createHash } from "node:crypto";
import {
  coerceChangesetContent,
  type Artifact,
  type ProposalPrecondition,
  type ProposalSnapshot,
  type StanceRef,
} from "@deeppairing/shared";

/**
 * #470 — the three identities of a stance-exception (design §2), as pure
 * functions shared by the MCP tools (which resolve a proposal) and the daemon
 * (which re-resolves its preconditions at claim time). One implementation, so
 * the tool and the daemon can never disagree about what a proposal depends on.
 *
 *  - call fingerprint: LOCATES an allowance or a committed operation for a
 *    retry. Raw tool args minus transport `_meta`. Never authorizes.
 *  - effective snapshot + preconditions: WHAT THE HUMAN ALLOWED. The exact
 *    create params the tool would persist (minus server-minted ids), plus the
 *    store facts the derivation read.
 *  - effective digest: sha256 over snapshot + preconditions.
 */

/** Key-sorted JSON. Shared with N2's hashPresentArgs (tool-helpers). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Exact stance identity, as the grant, the claim and the re-gate compare it. */
export function sameStance(row: { description: string; concept?: string; rejectedAt?: string }, ref: StanceRef): boolean {
  return row.description === ref.description && (row.concept ?? undefined) === (ref.concept ?? undefined) &&
    (row.rejectedAt ?? undefined) === (ref.rejectedAt ?? undefined);
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * The tools whose blocks can carry an allowance-eligible snapshot in slice 1,
 * with the artifact type each creates (null: revise_artifact's type is its
 * target's). A block from any other tool is recorded as NOT eligible, so a
 * grant on it is refused rather than arming an allowance nothing can consume.
 */
export const EXCEPTION_TOOL_TYPES: Readonly<Record<string, string | null>> = {
  present_code_change: "code_change",
  present_options: "decision",
  revise_artifact: null,
};

/** Above this the block is recorded but not eligible (design §2). */
export const MAX_SNAPSHOT_BYTES = 48 * 1024;

/** Drop the one transport key the fingerprint ignores: a top-level `_meta`. */
export function withoutTransportMeta(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (!Object.prototype.hasOwnProperty.call(args, "_meta")) return args;
  const { _meta: _transport, ...rest } = args as Record<string, unknown>;
  return rest;
}

/** The call fingerprint. Whitespace, case, Unicode form and order all count. */
export function callFingerprint(toolName: string, args: unknown): string {
  return sha256Hex(stableStringify({
    v: 1,
    toolName,
    type: EXCEPTION_TOOL_TYPES[toolName] ?? null,
    args: withoutTransportMeta(args) ?? null,
  }));
}

export function effectiveDigest(snapshot: ProposalSnapshot, preconditions: ProposalPrecondition[]): string {
  return sha256Hex(stableStringify({ v: 1, snapshot, preconditions }));
}

/** The wire form: what survives JSON (undefined keys dropped). Both sides
 *  digest this form, so a key the tool left undefined can't skew the hash. */
export function wireForm<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// --- present_code_change: `before` reconstructed from history (#3) ---------

/** The newest prior code_change for `filePath` with a non-empty `after`. The
 *  tool's #3 reconstruction and the daemon's claim re-check both use this. */
export function newestPriorCodeChange(artifacts: Artifact[], filePath: string): Artifact | undefined {
  return artifacts
    .filter((a) =>
      a.type === "code_change" &&
      (a.content as { filePath?: unknown } | null)?.filePath === filePath &&
      typeof (a.content as { after?: unknown } | null)?.after === "string" &&
      ((a.content as { after: string }).after).length > 0,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function codeChangePrecondition(artifacts: Artifact[], filePath: string): Extract<ProposalPrecondition, { kind: "code_change_prior" }> {
  const prior = newestPriorCodeChange(artifacts, filePath);
  return {
    kind: "code_change_prior",
    filePath,
    priorCodeChangeId: prior?.id ?? null,
    priorAfterHash: prior ? sha256Hex((prior.content as { after: string }).after) : null,
  };
}

export interface ProposalStoreReader {
  getArtifacts(): Artifact[] | Promise<Artifact[]>;
}

export interface CodeChangeResolution {
  before: string;
  changeType: string;
  /** Null when `before` was supplied (no store read). */
  precondition: ProposalPrecondition | null;
  /** False when history could not be read: the effective proposal is unknown,
   *  so the block must not be allowance-eligible. */
  resolvable: boolean;
}

/** #3 — when `before` is omitted, reconstruct it from the newest prior
 *  code_change for the file, and correct a mislabelled `create`. */
export async function resolveCodeChange(
  reader: ProposalStoreReader,
  input: { filePath: string; before: string; changeType: string },
): Promise<CodeChangeResolution> {
  let before = input.before;
  let precondition: ProposalPrecondition | null = null;
  let resolvable = true;
  if (!before) {
    try {
      const artifacts = await reader.getArtifacts();
      precondition = codeChangePrecondition(artifacts, input.filePath);
      const prior = newestPriorCodeChange(artifacts, input.filePath);
      if (prior) before = (prior.content as { after: string }).after;
    } catch {
      // best-effort; fall back to the empty before (full-file view)
      resolvable = false;
    }
  }
  const changeType = before && input.changeType === "create" ? "modify" : input.changeType;
  return { before, changeType, precondition, resolvable };
}

// --- revise_artifact supersede ---------------------------------------------

const CLOSED_TARGET_STATUSES: ReadonlySet<string> = new Set(["superseded", "retracted", "rejected", "obsolete"]);

/** Every field a revision can inherit from its target: title, an external
 *  changeset's identity and display provenance (never headSha), a decision's
 *  stakes, refs and feature. Hashed whether or not this revision inherits it,
 *  so ANY change to the target's inheritable state refuses the claim. */
export function reviseInheritedHash(target: Artifact): string {
  let provenance: unknown = null;
  if (target.type === "changeset") {
    const cs = coerceChangesetContent(target.content);
    if (cs.reviewIntent === "external") {
      const { headSha: _reviewedCommit, ...display } = (cs.source ?? {}) as Record<string, unknown>;
      provenance = { reviewIntent: "external", source: cs.source ? display : null };
    }
  }
  return sha256Hex(stableStringify({
    title: target.title,
    type: target.type,
    provenance,
    stakes: (target.content as { stakes?: unknown } | null)?.stakes ?? null,
    relatedArtifactIds: target.relatedArtifactIds ?? null,
    featureId: target.featureId ?? null,
  }));
}

export function reviseTargetPrecondition(target: Artifact): ProposalPrecondition {
  return {
    kind: "revise_target",
    targetId: target.id,
    targetVersion: target.version,
    targetStatus: target.status,
    inheritedHash: reviseInheritedHash(target),
  };
}

/** The supersede content exactly as revise_artifact persists it, minus the
 *  server-minted decisionId. */
export function deriveReviseContent(old: Artifact, supplied: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = { ...supplied };
  if (old.type === "changeset") {
    const oldChangeset = coerceChangesetContent(old.content);
    if (oldChangeset.reviewIntent === "external") {
      content.reviewIntent = "external";
      if (content.source === undefined && oldChangeset.source) {
        const { headSha: _reviewedCommit, ...displayProvenance } = oldChangeset.source;
        content.source = displayProvenance;
      }
    }
  }
  return content;
}

/** Applied after the gate (the projection never reads these fields). */
export function finalizeReviseContent(old: Artifact, content: Record<string, unknown>): Record<string, unknown> {
  if (old.type === "changeset") {
    delete content.reviewState;
    delete content.reviewReasons;
  }
  if (old.type === "decision" && Array.isArray(content.options)) {
    delete content.decisionId;
    const oldStakes = (old.content as { stakes?: "low" | "medium" | "high" } | null)?.stakes;
    if (content.stakes === undefined && oldStakes !== undefined) content.stakes = oldStakes;
  }
  return content;
}

export function reviseSnapshot(old: Artifact, title: string, reason: string, content: Record<string, unknown>): ProposalSnapshot {
  return wireForm({
    kind: "revise",
    type: old.type,
    title,
    content,
    agentReasoning: reason,
    parentId: old.id,
    version: old.version + 1,
    ...(old.relatedArtifactIds ? { relatedArtifactIds: old.relatedArtifactIds } : {}),
    ...(old.featureId ? { feature: old.featureId } : {}),
  } as ProposalSnapshot);
}

// --- claim-time re-resolution ----------------------------------------------

export type PreconditionCheck =
  | { ok: true }
  | {
      ok: false;
      /** What the allowed proposal depended on: the prior that supplied
       *  `before` (null when there was none), or the revise target. */
      dependencyId: string | null;
      what: "prior" | "target";
      detail: "newer_prior" | "prior_edited" | "prior_appeared" | "prior_vanished" | "target_missing" | "target_revised" | "target_status" | "target_changed";
    };

/** Re-resolve every precondition from `artifacts` (the daemon's own store). */
export function checkPreconditions(artifacts: Artifact[], preconditions: ProposalPrecondition[]): PreconditionCheck {
  for (const p of preconditions) {
    if (p.kind === "code_change_prior") {
      const now = codeChangePrecondition(artifacts, p.filePath);
      if (now.priorCodeChangeId === p.priorCodeChangeId && now.priorAfterHash === p.priorAfterHash) continue;
      const detail = p.priorCodeChangeId === null ? "prior_appeared"
        : now.priorCodeChangeId === null ? "prior_vanished"
        : now.priorCodeChangeId !== p.priorCodeChangeId ? "newer_prior" : "prior_edited";
      // Name what the ALLOWED proposal depended on (null: "no earlier change").
      return { ok: false, what: "prior", dependencyId: p.priorCodeChangeId, detail };
    }
    const target = artifacts.find((a) => a.id === p.targetId);
    if (!target) return { ok: false, what: "target", dependencyId: p.targetId, detail: "target_missing" };
    const hasSuccessor = artifacts.some((a) => a.parentId === p.targetId);
    if (hasSuccessor || target.version !== p.targetVersion || target.status === "superseded") {
      return { ok: false, what: "target", dependencyId: p.targetId, detail: "target_revised" };
    }
    if (target.status !== p.targetStatus || CLOSED_TARGET_STATUSES.has(target.status)) {
      return { ok: false, what: "target", dependencyId: p.targetId, detail: "target_status" };
    }
    if (reviseInheritedHash(target) !== p.inheritedHash) {
      return { ok: false, what: "target", dependencyId: p.targetId, detail: "target_changed" };
    }
  }
  return { ok: true };
}

/**
 * #501 review (Fable LOW) — the preconditions as they stand NOW, re-resolved
 * from `artifacts` (the daemon's own store). A "changed" block carries these,
 * so its copy can name the actual new dependency ("now depends on a newer
 * art_x") whatever the client sent.
 */
export function currentPreconditions(artifacts: Artifact[], preconditions: ProposalPrecondition[]): ProposalPrecondition[] {
  return preconditions.map((p) => {
    if (p.kind === "code_change_prior") return codeChangePrecondition(artifacts, p.filePath);
    const target = artifacts.find((a) => a.id === p.targetId);
    return target ? reviseTargetPrecondition(target) : p;
  });
}
