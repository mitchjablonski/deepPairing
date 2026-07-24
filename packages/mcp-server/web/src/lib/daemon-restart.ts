/**
 * #182 — daemon-restart-under-an-open-tab recovery.
 *
 * Field bug: the daemon restarts (idle auto-shutdown, crash, manual kill, a
 * `doctor --fix`) while a companion tab is open. The WS reconnect loop
 * (connection.ts) re-attaches to the NEW daemon on the same port, so READS and
 * live broadcasts keep flowing — the tab looks alive. But two things are now
 * stale and only a hard reload fixes them:
 *   1. the bearer token the page was served at load time (SP1) — the new
 *      process minted a fresh one, so every WRITE 401s ("Authorization
 *      required for this action.");
 *   2. the JS bundle itself — the tab keeps running the pre-restart code.
 *
 * So the recovery is a PERSISTENT, dismissible toast telling the human to
 * reload — NOT an auto-reload (an unsaved composer draft would be lost). Two
 * detection paths feed it and share the dedup here so they never double-toast
 * the same restart:
 *   - the WS `connected` handler compares daemonStartedAt across reconnects;
 *   - toastApiError re-checks identity when a write 401/403s (catches the race
 *     where the reconnect hasn't reconciled yet, or detection was missed).
 *
 * This is distinct from the II3/BB10 cross-project mismatch toast ("Tab is
 * bound to a stale daemon"): that fires on a project-HASH mismatch (a DIFFERENT
 * project's daemon took the port). This one fires on a startedAt/identity change
 * for the SAME project. The two conditions are mutually exclusive, and the
 * project_hash_mismatch branch in toastApiError short-circuits before the
 * 401/403 identity check here, so they never collide.
 */
import { apiBase } from "./api";
import { useToastStore } from "../stores/toast";

// Fire the reload toast ONCE per detected restart, keyed by the new daemon's
// startedAt. Shared module state so the `connected` path and the 401-on-write
// path dedupe against each other — the reconnect loop retries and a burst of
// failed writes must not stack N identical toasts.
let restartToastFiredFor: string | null = null;

/** Read the daemon identity the tab currently knows (the value it booted with,
 *  until a WS reconnect reconciles it — set by connection.ts's `connected`
 *  handler). Read off the window-exposed connection store to avoid a circular
 *  import, the same way lib/api.ts reads projectHash. */
export function knownDaemonStartedAt(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const s = (window as unknown as {
      __dpConnectionStore?: { getState?: () => { daemonStartedAt?: string | null } };
    }).__dpConnectionStore?.getState?.();
    return typeof s?.daemonStartedAt === "string" ? s.daemonStartedAt : null;
  } catch {
    return null;
  }
}

/**
 * Push the persistent "the daemon restarted — reload" toast. Deduped by
 * `newStartedAt`: repeated reconnects to the same new daemon (or a flurry of
 * failed writes) fire it exactly once. kind "error" + ttl 0 + a Reload action
 * mirrors the II3/BB10 stale-daemon toast family (assertive role=alert,
 * dismissible, sticky).
 */
export function pushDaemonRestartToast(newStartedAt: string | null): void {
  const key = newStartedAt ?? "__unknown__";
  if (restartToastFiredFor === key) return;
  restartToastFiredFor = key;
  // Push synchronously (static toast import, no back-edges to this module) so
  // the toast is present the moment a caller's await settles.
  useToastStore.getState().push({
    kind: "error",
    title: "Daemon restarted",
    body: "Reload this tab to reconnect.",
    ttl: 0, // persistent — the stale bundle + bearer token only recover on reload
    action: {
      label: "Reload",
      onClick: () => {
        if (typeof window !== "undefined") window.location.reload();
      },
    },
  });
}

/**
 * Confirm — via an authoritative /api/daemon-info fetch — whether the daemon on
 * this port is a DIFFERENT process than the one the tab knows. Returns the live
 * startedAt when a restart is confirmed, else null (same daemon, an older daemon
 * that omits startedAt, no known baseline, or the probe failed → "not
 * confirmed", so a genuine auth error keeps its own message).
 *
 * /api/daemon-info is a GET, exempt from the bearer + X-Project-Hash gates, so a
 * plain fetch answers even when the tab's write credentials are stale.
 */
export async function confirmDaemonRestart(): Promise<string | null> {
  const known = knownDaemonStartedAt();
  if (!known) return null;
  try {
    const res = await fetch(`${apiBase()}/api/daemon-info`);
    if (!res.ok) return null;
    const body = await res.json();
    const live = typeof body?.startedAt === "string" ? body.startedAt : null;
    return live && live !== known ? live : null;
  } catch {
    return null;
  }
}

/** Test-only — clear the once-per-restart dedup latch between cases. */
export function __resetDaemonRestartToast(): void {
  restartToastFiredFor = null;
}
