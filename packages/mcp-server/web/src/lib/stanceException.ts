import type { ProposalPrecondition, ProposalSnapshot, StanceAllowanceReceipt, StanceRef } from "@deeppairing/shared";
import { apiBase, apiGet, sessionHeaders } from "./api";
import { usePreflightBlockStore } from "../stores/preflightBlocks";
import { useToastStore } from "../stores/toast";
import { usePreferencesStore } from "../stores/preferences";
import { announce } from "../stores/announce";

/**
 * #470 slice 2 — "Allow this proposal once", the companion-UI side.
 *
 * The daemon decides everything: whether a block can be allowed, what the
 * allowance covers, and when it ends. This module only fetches the daemon's
 * own preview, posts the human's grant, and words receipts. Receipts label
 * the door a grant came through (UI or CLI) — a self-reported label. Nothing
 * here may say "verified" or name a person (§13 condition 3).
 */

export type ReceiptState = StanceAllowanceReceipt["state"];

export interface ExceptionPreview {
  blockId: string;
  source: "session" | "team";
  toolName?: string;
  eligible: boolean;
  ineligibleReason?: string;
  stance?: StanceRef;
  snapshot?: ProposalSnapshot;
  preconditions?: ProposalPrecondition[];
  allowance?: StanceAllowanceReceipt;
}

/** The scope sentence the dialog is described by (§3a). */
export const SCOPE_SENTENCE =
  "Allows this exact proposal, once, until this Claude session ends (at most 72 hours). The stance stays on for everything else.";

export const MIN_REASON = 3;
export const MAX_REASON = 280;
export const REASON_HINT = `Give a reason of ${MIN_REASON}–${MAX_REASON} characters.`;

export function reasonIsValid(reason: string): boolean {
  const t = reason.trim();
  return t.length >= MIN_REASON && t.length <= MAX_REASON;
}

/** One honest line for a block that can't be allowed once. */
export function ineligibleText(reason: string | undefined): string {
  switch (reason) {
    case "team_rule": return "Team rules can't be allowed once — edit .deeppairing/team.json to change them.";
    case "unsupported_tool": return "Allow once isn't available for this kind of proposal yet.";
    case "too_large": return "This proposal is too large to allow once.";
    case "secret_flagged": return "Allow once is off for this proposal: it looks like it contains a secret.";
    case "session_ended": return "That Claude session has ended, so there's nothing left to allow.";
    case "demo_session": return "Demo blocks can't be allowed.";
    case "stance_retired": return "That stance is no longer on file.";
    default: return "This block can't be allowed once.";
  }
}

/** The receipt word shown on a block (§4 "Where you see it"). */
export function receiptLabel(state: ReceiptState, via?: "ui" | "cli"): string {
  const door = via ? ` (${via.toUpperCase()})` : "";
  switch (state) {
    case "allowed": return `Allowed once${door} · waiting for Claude to retry`;
    case "used": return `Allowed once${door} · used`;
    case "changed": return "Allowed once · changed";
    case "revoked": return "Allowed once · revoked";
    case "ended": return "Allowed once · ended (not used)";
    case "expired": return "Allowed once · expired (not used)";
  }
}

/** "`before` comes from art_x (your last change to this file)" / "Revises art_y v3". */
export function preconditionLine(p: ProposalPrecondition): string {
  if (p.kind === "code_change_prior") {
    return p.priorCodeChangeId
      ? `\`before\` comes from ${p.priorCodeChangeId} (your last change to ${p.filePath})`
      : `\`before\` is empty: there was no earlier change to ${p.filePath}`;
  }
  return `Revises ${p.targetId} v${p.targetVersion}`;
}

/** The dialog footer (§2 "The preview shows what is covered"). */
export function preconditionFooter(pre: ProposalPrecondition[]): string {
  const ids = pre.map((p) => (p.kind === "code_change_prior" ? p.priorCodeChangeId : p.targetId)).filter(Boolean);
  return ids.length
    ? `If the agent changes anything, or if ${ids.join(" / ")} changes first, this allowance won't apply.`
    : "If the agent changes anything, this allowance won't apply.";
}

export async function fetchExceptionPreview(blockId: string): Promise<ExceptionPreview | null> {
  try {
    const res = await apiGet(`${apiBase()}/api/preflight-blocks/${encodeURIComponent(blockId)}/exception`);
    if (!res.ok) return null;
    return (await res.json()) as ExceptionPreview;
  } catch {
    return null;
  }
}

export type GrantResult =
  | { ok: true; allowance: { id: string; state: ReceiptState }; receipt?: StanceAllowanceReceipt; seenAt?: string }
  | { ok: false; status: number; message: string; ambiguous?: boolean };

export async function postGrant(blockId: string, reason: string): Promise<GrantResult> {
  try {
    const res = await fetch(`${apiBase()}/api/preflight-blocks/${encodeURIComponent(blockId)}/exception`, {
      method: "POST",
      headers: { ...sessionHeaders(), "X-DeepPairing-Grant-Origin": "ui" },
      body: JSON.stringify({ reason: reason.trim() }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.allowance?.id) {
      return {
        ok: true,
        allowance: body.allowance,
        ...(body.receipt?.id ? { receipt: body.receipt as StanceAllowanceReceipt } : {}),
        ...(typeof body.seenAt === "string" ? { seenAt: body.seenAt } : {}),
      };
    }
    const message = typeof body?.error === "string" ? body.error
      : res.status === 503 ? "deepPairing is busy writing to disk — try again in a moment."
      : `The allowance wasn't saved (${res.status}).`;
    return { ok: false, status: res.status, message };
  } catch {
    // The request may or may not have reached the daemon: don't claim either.
    return { ok: false, status: 0, ambiguous: true, message: "Couldn't confirm whether this was allowed — check the gate log before trying again." };
  }
}

export async function postRevoke(allowanceId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${apiBase()}/api/stance-exceptions/${encodeURIComponent(allowanceId)}/revoke`, {
      method: "POST",
      headers: sessionHeaders(),
      body: "{}",
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, message: typeof body?.error === "string" ? body.error : `Revoke failed (${res.status})` };
  } catch {
    return { ok: false, message: "Couldn't reach deepPairing." };
  }
}

/** Open the ⋯ gate log scrolled to (and focused on) one block's entry. */
export function openGateLogEntry(blockId?: string): void {
  usePreflightBlockStore.getState().requestFocus(blockId);
}

export function gateEntryDomId(blockId: string): string {
  return `gate-block-${blockId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * #470 (§3a) — speak a stance-exception moment ONCE and leave a toast. With
 * the next-up bar on, its single announcer speaks and the toast stays quiet;
 * with the bar off, the toast's own polite role is the announcement. A CLI
 * grant gets the stronger style (it didn't come from this screen).
 */
export function notifyStanceMoment(text: string, opts: { cli?: boolean } = {}): void {
  const barOn = usePreferencesStore.getState().nextUpBar;
  if (barOn) announce(text);
  useToastStore.getState().push({
    kind: opts.cli ? "block" : "info",
    icon: "shield",
    title: text,
    ...(opts.cli ? { body: "Granted from the command line, not from this screen.", strong: true } : {}),
    quiet: barOn,
    ttl: 8000,
  });
}

/**
 * #501 review (Astra P2) — ONE announcement per allowance, whichever arrives
 * first: the daemon's `stance_exception_granted` broadcast or this tab's HTTP
 * result. Keyed by the server-minted allowance id, so the arbitration doesn't
 * depend on order, and a failed or ambiguous HTTP result announces nothing (if
 * the grant did land, the broadcast announces it).
 */
const announcedAllowances = new Set<string>();
export function announceGrantOnce(allowanceId: string, concept: string, opts: { cli?: boolean } = {}): boolean {
  if (announcedAllowances.has(allowanceId)) return false;
  announcedAllowances.add(allowanceId);
  notifyStanceMoment(`Allowed once: '${concept}'. Waiting for Claude to retry.`, opts);
  return true;
}

/** Tests only: allowance ids are unique per daemon, but test files reuse them. */
export function resetAnnouncedGrantsForTests(): void {
  announcedAllowances.clear();
}
