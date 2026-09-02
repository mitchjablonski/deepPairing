import { create } from "zustand";
import { apiBase, apiGet, safeFetch, sessionHeaders, ApiError } from "../lib/api";
import { normalizeBank, samePath, type ContextBank } from "../lib/bank";
import { useToastStore } from "./toast";

/**
 * THE CONTEXT BANK store — "what am I doing across all my projects".
 *
 * Read model only (`GET /api/context-bank`), plus the ONE write the surface
 * offers: closing a decision out without answering it.
 *
 * FETCH POSTURE — deliberately quiet. The endpoint is a synchronous disk walk
 * over every registered project behind a 20s TTL (and a 2s floor on `?fresh=1`),
 * so this store NEVER polls: one cached read at app bootstrap (which also feeds
 * the header badge and the landing heuristic), one `fresh` read each time the
 * surface is opened, and a manual Refresh button. Everything else is a
 * user-initiated action.
 */

/** A live peer daemon, from the /api/projects sweep — the projectRoot→port map. */
interface PeerProject {
  projectRoot: string;
  port: number;
}

interface CloseOutArgs {
  decisionId: string;
  artifactId: string;
  sessionId: string;
  projectRoot: string;
  note?: string;
}

interface ContextBankState {
  /** null = never loaded. Never render a bank we haven't read from the server. */
  bank: ContextBank | null;
  loading: boolean;
  error: string | null;
  /** Whether the bank surface is on screen. */
  open: boolean;
  /** Expanded re-entry cards, keyed by `${projectRoot}::${sessionId}`. */
  expanded: Record<string, boolean>;
  /**
   * Decision ARTIFACT ids this tab has optimistically closed out. Kept beside
   * the bank rather than spliced into it: the server payload stays exactly what
   * the server said, and a rollback is a single key delete. Lane membership is
   * deliberately NOT recomputed from it — a row must not leap between sections
   * under the cursor that just clicked it.
   */
  closedOut: Record<string, true>;
  /** In-flight close-outs, by artifact id (button disable + spinner). */
  closing: Record<string, true>;
  /**
   * A close-out note that did NOT land, kept by artifact id.
   *
   * The optimistic removal unmounts the row, so a rollback remounts a FRESH
   * DecisionRow — and the sentence the human just typed ("a later card replaced
   * this") died with the old component instance, on the one path where they are
   * most likely to retry. Held here so the remounted row can restore it (and
   * re-arm the confirm around it). Cleared the moment a close-out succeeds.
   */
  noteDrafts: Record<string, string>;
  /** projectRoot → "localhost:PORT" for every LIVE peer daemon. */
  peers: PeerProject[];

  load: (opts?: { fresh?: boolean }) => Promise<void>;
  setOpen: (open: boolean) => void;
  toggleExpanded: (key: string) => void;
  closeOut: (args: CloseOutArgs) => Promise<boolean>;
  reset: () => void;
}

export const useContextBankStore = create<ContextBankState>((set) => ({
  bank: null,
  loading: false,
  error: null,
  open: false,
  expanded: {},
  closedOut: {},
  closing: {},
  noteDrafts: {},
  peers: [],

  load: async ({ fresh } = {}) => {
    set({ loading: true, error: null });
    try {
      const res = await apiGet(`${apiBase()}/api/context-bank${fresh ? "?fresh=1" : ""}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      // Fail-soft normalization: a payload missing `totals` (older daemon,
      // truncated body) must not be able to crash the shell from a badge.
      const bank = normalizeBank(await res.json());
      if (!bank) throw new Error("The daemon returned an unreadable bank");
      set({ bank, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Couldn't load your threads",
      });
      return;
    }
    // The peer sweep is a SEPARATE, best-effort read: it only powers the
    // "switch to that project" affordance, so a dead sweep must not fail the
    // bank (which is the whole surface).
    try {
      const res = await apiGet(`${apiBase()}/api/projects`);
      if (!res.ok) return;
      const data = (await res.json()) as { projects?: Array<{ projectRoot?: string; port?: number }> };
      const peers: PeerProject[] = (data.projects ?? [])
        .filter((p): p is { projectRoot: string; port: number } =>
          typeof p.projectRoot === "string" && typeof p.port === "number")
        .map((p) => ({ projectRoot: p.projectRoot, port: p.port }));
      set({ peers });
    } catch {
      // best-effort
    }
  },

  setOpen: (open) => set({ open }),

  toggleExpanded: (key) =>
    set((s) => {
      const next = { ...s.expanded };
      if (next[key]) delete next[key];
      else next[key] = true;
      return { expanded: next };
    }),

  /**
   * Close a decision out WITHOUT answering it (POST …/close-out → `obsolete`).
   * Optimistic: the row disappears immediately, and a 4xx/5xx puts it straight
   * back with an error toast. Silently keeping the optimistic removal would tell
   * the human a stale loop is closed when the store still owes it — the exact
   * failure class U3 exists to stop.
   *
   * CROSS-PROJECT is refused by the route (400) and the UI never offers the
   * button off-project, so this is only ever called for the current project.
   */
  closeOut: async ({ decisionId, artifactId, sessionId, projectRoot, note }) => {
    set((s) => ({
      closedOut: { ...s.closedOut, [artifactId]: true },
      closing: { ...s.closing, [artifactId]: true },
    }));
    try {
      await safeFetch(`${apiBase()}/api/decisions/${encodeURIComponent(decisionId)}/close-out`, {
        method: "POST",
        headers: sessionHeaders(sessionId),
        body: JSON.stringify({ projectRoot, sessionId, note: note?.trim() || undefined }),
      });
      set((s) => {
        const noteDrafts = { ...s.noteDrafts };
        delete noteDrafts[artifactId];
        return { noteDrafts };
      });
      return true;
    } catch (err) {
      set((s) => {
        const closedOut = { ...s.closedOut };
        delete closedOut[artifactId];
        const trimmed = note?.trim();
        return {
          closedOut,
          // Give the remounted row its note back — see noteDrafts.
          noteDrafts: trimmed ? { ...s.noteDrafts, [artifactId]: trimmed } : s.noteDrafts,
        };
      });
      const apiErr = err instanceof ApiError ? err : null;
      useToastStore.getState().push({
        kind: "error",
        title:
          apiErr?.code === "decision_already_resolved"
            ? "That decision was already answered"
            : "Couldn't close that decision out",
        body:
          apiErr?.message ??
          "The card is still open — nothing was changed. Try again, or open it in its session.",
      });
      return false;
    } finally {
      set((s) => {
        const closing = { ...s.closing };
        delete closing[artifactId];
        return { closing };
      });
    }
  },

  reset: () =>
    set({
      bank: null,
      loading: false,
      error: null,
      open: false,
      expanded: {},
      closedOut: {},
      closing: {},
      noteDrafts: {},
      peers: [],
    }),
}));

/** "localhost:PORT" for a registered project with a LIVE daemon, else null. */
export function hostForProject(peers: PeerProject[], projectRoot: string): string | null {
  const match = peers.find((p) => samePath(p.projectRoot, projectRoot));
  return match ? `localhost:${match.port}` : null;
}
