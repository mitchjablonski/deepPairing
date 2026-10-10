import { nanoid } from "nanoid";
import type { ProposalPrecondition, ProposalSnapshot, StanceRef } from "@deeppairing/shared";
import type { ToolContext, ToolResult } from "./tools/types.js";
import { recordPreflightBlockEvent, type PreflightBlockedEvent, type PreflightHelperResult } from "./tool-helpers.js";
import { callFingerprint, MAX_SNAPSHOT_BYTES } from "./proposal-resolution.js";

/**
 * #470 — the tool side of "Allow this proposal once" (design §6). The tool
 * never decides authority: the daemon claims, re-verifies and creates. This
 * module only sequences the calls and words the results for the agent.
 *
 *  0. beginStanceOperation — mint one operationId per invocation, compute the
 *     call fingerprint, and probe the operation route BEFORE any tool-level
 *     early return (N2 dedup, revise's closed-parent check): a committed
 *     operation is completed and replayed, never re-run.
 *  1. (the tool resolves its proposal and runs the gate — deferRecord)
 *  2–4. admitBlockedProposal — inspect (read-only), re-gate without the
 *     candidates' stances, then claim + create in ONE daemon operation.
 */

export const STANCE_MESSAGES = {
  blockHint:
    "If this is a false positive, ask your pair to choose **Allow this proposal once** on the block card. " +
    "Then retry this **identical** call (every argument the same, not only the matched text). You cannot grant this yourself.",
  admitted: (via: string, stances: string[], reasons: string[]) =>
    `Admitted once under an allowance your pair granted (${via.toUpperCase()}) for stance ${stances.map((s) => `"${s}"`).join(" and ")} ` +
    `(reason: ${reasons.map((r) => `"${r}"`).join("; ")}). It covered this exact version only. If you revise this artifact and the ` +
    `revision still matches the stance, your pair must allow it again. The stance still applies to everything else. ` +
    `A direct edit carrying this content will still prompt your pair.`,
  replayed: (artifactId: string) =>
    `Already admitted. Returning the original result for ${artifactId}. Nothing new was created.`,
  dependencyChanged: (dep: { id: string | null; what: "prior" | "target" }) =>
    `The proposal your pair allowed depended on ${dep.what === "target" ? `the state of ${dep.id}` : (dep.id ?? "there being no earlier change to this file")}, ` +
    `which changed. Ask your pair to allow the new version.`,
  versionMismatch:
    "The allowance your pair granted covers a different version of this call than the one you sent now, so nothing was created. " +
    "Retry the identical call you were blocked on, or ask your pair to allow this version.",
  inactive: (state: string, artifactId?: string, ceilingAt?: string) =>
    state === "used" ? `Your pair's allowance for this exact call was already used${artifactId ? ` (${artifactId})` : ""}.`
    : state === "revoked" ? "Your pair revoked the allowance for this exact call."
    : state === "ended" ? "Your pair's allowance for this exact call ended with its Claude session."
    : state === "expired" ? `Your pair's allowance for this exact call expired${ceilingAt ? ` at ${ceilingAt}` : ""}.`
    : state === "changed" ? "The allowance for this call was replaced after the proposal changed."
    : "",
} as const;

export interface StanceOperationHandle {
  operationId: string;
  callFingerprint: string;
}

type OperationResult = Record<string, unknown> & { status?: string };

/**
 * §6 step 0. `replay` is set when a committed operation was found; `refusal`
 * when the daemon could NOT establish whether one exists.
 *
 * #499 review P2 — only a DEFINITIVE "none" lets the tool continue. A failed
 * probe (a transport/server error, or a stamp the daemon refuses as
 * inconsistent) is not "none": a stamped child may exist, and the stance it
 * was allowed past may have been retired since, so the normal path could
 * present a duplicate. The sole compatibility exception is a daemon that has
 * no operation route at all (a bare 404, no structured code): it predates
 * allowances, so no admitted operation can exist there.
 */
export async function beginStanceOperation(
  ctx: ToolContext,
  toolName: string,
  args: unknown,
): Promise<{ handle: StanceOperationHandle; replay?: OperationResult; refusal?: ToolResult }> {
  const handle = { operationId: `op_${nanoid(16)}`, callFingerprint: callFingerprint(toolName, args) };
  if (!ctx.store.runStanceOperation) return { handle };
  try {
    const result = await ctx.store.runStanceOperation(handle.operationId, { callFingerprint: handle.callFingerprint }) as OperationResult;
    if (result?.status === "replayed") return { handle, replay: result };
    if (result?.status === "none") return { handle };
    return { handle, refusal: probeRefusal(false, `unexpected status ${String(result?.status)}`) };
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    if (e.status === 404 && !e.code) return { handle };
    if (e.code === "stance_exception_operation_inconsistent") return { handle, refusal: probeRefusal(true, e.message ?? "") };
    return { handle, refusal: probeRefusal(false, e.message ?? String(error)) };
  }
}

function probeRefusal(inconsistent: boolean, detail: string): ToolResult {
  return {
    content: [{
      type: "text",
      text: inconsistent
        ? `An earlier allowed version of this exact call left an operation record that doesn't match its own history, so deepPairing won't finish or repeat it. Nothing new was created. Tell your pair; don't retry this identical call. (${detail})`
        : `deepPairing couldn't confirm whether an earlier identical call already went through, so nothing new was created. Retry this identical call in a moment. (${detail})`,
    }],
    isError: true,
    _meta: { code: inconsistent ? "STANCE_OPERATION_INCONSISTENT" : "STANCE_OPERATION_UNCONFIRMED", retryable: !inconsistent },
  } as ToolResult;
}

/** The agent-facing result of an admitted (or replayed) operation. `extra`
 *  carries what the tool's normal path would also have said (review URL,
 *  close-note). */
export function admittedResult(op: OperationResult, extra = ""): ToolResult {
  const artifactId = String(op.artifactId);
  const decisionId = typeof op.decisionId === "string" ? op.decisionId : undefined;
  const ids = `${artifactId}${decisionId ? `, decision ${decisionId}` : ""}`;
  const skipped = typeof op.supersedeSkipped === "string"
    ? ` (${String(op.parentId)} was left ${op.supersedeSkipped}: your pair closed it after the allowance, so it was not superseded.)`
    : "";
  const text = op.status === "replayed"
    ? `${STANCE_MESSAGES.replayed(ids)}${skipped}`
    : `Presented for review (${ids}). ${STANCE_MESSAGES.admitted(String(op.grantedVia ?? "ui"), (op.stances as string[]) ?? [], (op.reasons as string[]) ?? [])}${skipped} Call check_feedback for your pair's response.`;
  const fullText = `${text}${extra}`;
  return {
    content: [{ type: "text", text: fullText }],
    structuredContent: {
      artifactId,
      ...(decisionId ? { decisionId } : {}),
      admitted: true,
      ...(op.status === "replayed" ? { replayed: true } : {}),
    },
  };
}

function withLine(response: ToolResult, line: string): ToolResult {
  if (!line) return response;
  const [first, ...rest] = response.content;
  return { ...response, content: [{ type: "text", text: `${first!.text}\n\n${line}` }, ...rest] };
}

/**
 * §6 steps 2–4 for a call the gate refused. Returns either the tool's final
 * block response, or the daemon's admitted operation.
 */
export async function admitBlockedProposal(
  ctx: ToolContext,
  input: {
    toolName: string;
    handle: StanceOperationHandle;
    pre: Extract<PreflightHelperResult, { ok: false }>;
    /** Null when the effective proposal couldn't be resolved: never admitted. */
    resolved: { snapshot: ProposalSnapshot; preconditions: ProposalPrecondition[] } | null;
    /** Re-run the gate with these stance rows removed (deferRecord). */
    regate: (exclude: StanceRef[]) => Promise<PreflightHelperResult> | null;
  },
): Promise<{ response: ToolResult } | { admitted: OperationResult }> {
  const { toolName, handle, pre, resolved } = input;
  // The block event, carrying what a grant would bind to. An oversized
  // snapshot is left off (the daemon records the block as not eligible)
  // so the block itself still reaches the log under the body cap.
  const fits = !!resolved && Buffer.byteLength(JSON.stringify(resolved.snapshot)) <= MAX_SNAPSHOT_BYTES;
  const exceptionFields = { callFingerprint: handle.callFingerprint, ...(fits ? { snapshot: resolved!.snapshot, preconditions: resolved!.preconditions } : {}) };
  const blockOf = (event: PreflightBlockedEvent): PreflightBlockedEvent => ({ ...event, ...exceptionFields });
  const refuse = (event: PreflightBlockedEvent, source: "session" | "team", response: ToolResult, line = ""): { response: ToolResult } => {
    recordPreflightBlockEvent(ctx.store, ctx.broadcast, blockOf(event), source);
    // Only where an allowance can exist (a daemon-backed store).
    const hint = source === "session" && ctx.store.runStanceOperation ? STANCE_MESSAGES.blockHint : "";
    return { response: withLine(response, [line, hint].filter(Boolean).join("\n")) };
  };

  if (pre.source !== "session" || !ctx.store.inspectStanceExceptions || !ctx.store.runStanceOperation) {
    return refuse(pre.event, pre.source, pre.response);
  }
  // 2. Inspect — read-only, never consumes.
  let candidates: Array<{ id: string; stance: StanceRef }> = [];
  let inactiveLine = "";
  try {
    const seen = await ctx.store.inspectStanceExceptions(handle.callFingerprint);
    candidates = (seen.candidates ?? []) as Array<{ id: string; stance: StanceRef }>;
    const first = (seen.inactive ?? [])[0] as { state?: string; artifactId?: string; ceilingAt?: string } | undefined;
    if (first?.state) inactiveLine = STANCE_MESSAGES.inactive(first.state, first.artifactId, first.ceilingAt);
  } catch {
    candidates = [];
  }
  if (candidates.length === 0 || !resolved) return refuse(pre.event, pre.source, pre.response, inactiveLine);

  // 3. Re-gate without the candidates' stances, for this call only. Anything
  // else that blocks wins, and nothing is consumed.
  const regate = await input.regate(candidates.map((c) => c.stance));
  if (regate && !regate.ok) return refuse(regate.event, regate.source, regate.response);

  // 4. Claim + create + follow-ups, in one daemon operation.
  const result = await ctx.store.runStanceOperation(handle.operationId, {
    callFingerprint: handle.callFingerprint,
    admission: {
      exceptionIds: candidates.map((c) => c.id),
      toolName,
      snapshot: resolved.snapshot,
      preconditions: resolved.preconditions,
      ...(regate?.ok ? { trace: { ...regate.trace } } : {}),
      // Without snapshot fields: the daemon re-attaches this request's.
      block: { ...pre.event },
    },
  }) as OperationResult;
  if (result.status === "admitted" || result.status === "replayed") return { admitted: result };
  const dep = result.dependency as { id: string | null; what: "prior" | "target" } | undefined;
  if (result.code === "stance_exception_dependencies_changed" && dep && typeof result.newBlockId === "string") {
    // The daemon already recorded this call's block, linked to the old allowance.
    void ctx.store.recordMetric?.({ kind: "preflight_block", source: "session" });
    return { response: withLine(pre.response, `${STANCE_MESSAGES.dependencyChanged(dep)}\n${STANCE_MESSAGES.blockHint}`) };
  }
  const line = dep ? STANCE_MESSAGES.dependencyChanged(dep)
    : result.reason === "client_snapshot_mismatch" || result.reason === "snapshot_mismatch" ? STANCE_MESSAGES.versionMismatch
    : STANCE_MESSAGES.inactive(String(result.state ?? result.reason ?? ""), result.artifactId as string | undefined, result.ceilingAt as string | undefined);
  return refuse(pre.event, pre.source, pre.response, line);
}
