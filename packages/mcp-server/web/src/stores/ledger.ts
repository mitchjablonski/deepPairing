import { create } from "zustand";
import { apiBase, sessionHeaders } from "../lib/api";

/**
 * EE2 — shared ledger digest store. Pre-EE2 three independent fetchers
 * (PreflightBreadcrumb, IdleHome, LedgerDrawer LedgerPanel) each
 * mounted their own /api/ledger/digest fetch + dp:preflight-trace
 * listener. With 50 artifacts on screen + a fresh trace event, that
 * was 50 redundant network roundtrips per broadcast. The 2s server
 * cache (BB2) absorbed the disk cost but every request still went
 * through CORS, X-Project-Hash middleware, and JSON serialization.
 *
 * One fetch, one listener, all subscribers re-render.
 *
 * Optional `error` preserves the prior per-component behavior of
 * surfacing a load failure inline (LedgerPanel renders "Could not
 * load the ledger: {error}" when set).
 */
export interface LedgerDigest {
  shapedThisProject: number;
  nearMissesThisProject: number;
  blockedThisProject: number;
  sessionsTouched: number;
  topCitedStances: Array<{
    concept: string;
    source: "session" | "team";
    citationCount: number;
    /**
     * EE3 — cross-project citation count (sum of non-manual instances
     * for this concept across the whole global ledger, including the
     * project-local count). Lets PreflightBreadcrumb escalate to
     * signal tier when a stance has accumulated multi-project weight
     * even if it hasn't fired enough times in THIS project yet.
     * Optional for back-compat with pre-EE3 fixtures.
     */
    globalCitationCount?: number;
    sampleArtifactId?: string;
    sampleSessionId?: string;
  }>;
  seededStances?: Array<{
    concept: string;
    stance: "avoid" | "prefer" | "mixed";
    citedTimesElsewhere: number;
    /**
     * FF1 — when a seed has been cited in a real session, the digest
     * threads the citing artifact through so the LedgerPanel can render
     * the BB6 jump-to-citing-artifact button on the seeded row. Pre-FF1
     * EE4's dedup deleted the duplicate top-cited row, taking the link
     * with it.
     */
    sampleArtifactId?: string;
    sampleSessionId?: string;
  }>;
  globalLedger: { concepts: number; projects: number; multiProjectConcepts: number };
}

/**
 * R2 — "does this human actually have a ledger?", in ONE place.
 *
 * Round 13 (cold-journey lens) caught the companion UI telling the user "Your
 * philosophy ledger is empty" on a page where the block card beside it was
 * quoting one of their stances back at them and the durable log held nine
 * firings. Two surfaces were answering the same question from different
 * evidence: LedgerPanel tested `shaped === 0 && globalConcepts === 0 &&
 * seeds === 0`, while PreflightBreadcrumb didn't test the ledger at all — it
 * read ONE ARTIFACT's preflight trace and reported `consideredCount === 0` as
 * "your ledger is empty". Those are different claims: an artifact can be
 * preflighted against nothing relevant while the ledger is full.
 *
 * Both now call this predicate, so the drift can't reopen — and it counts the
 * two signals the old test missed: stances that have FIRED (blocks/near-misses
 * in this project) and stances that have accumulated CITATIONS. A local ledger
 * with publishing off contributes nothing to `globalLedger.concepts`, which is
 * exactly the shape the round-13 repro was in.
 *
 * Deliberately positive-only: every clause requires a POSITIVE number, so a
 * malformed or partially-shaped digest reads as "don't know" (false) rather
 * than as proof of a ledger. Callers treat `null` (not loaded) as "don't know"
 * too.
 */
export function ledgerHasStances(digest: LedgerDigest | null | undefined): boolean {
  if (!digest) return false;
  const pos = (n: unknown): boolean => typeof n === "number" && n > 0;
  return (
    pos(digest.shapedThisProject) ||
    pos(digest.nearMissesThisProject) ||
    pos(digest.blockedThisProject) ||
    pos(digest.globalLedger?.concepts) ||
    (digest.topCitedStances?.length ?? 0) > 0 ||
    (digest.seededStances?.length ?? 0) > 0
  );
}

interface LedgerState {
  digest: LedgerDigest | null;
  error: string | null;
  loading: boolean;
  /** Bumps every successful fetch so callers can react to refresh. */
  version: number;
  /** Force-refetch (drops the in-flight request and starts a new one). */
  refetch: () => Promise<void>;
  /**
   * Scope-down a personal pre-flight block the user judged a false positive.
   * POSTs /api/philosophy/override (retire local stance + global counter-
   * instance), toasts the outcome, and refreshes the digest on success.
   */
  overrideStance: (payload: {
    source: "session" | "team";
    description?: string;
    concept?: string;
  }) => Promise<void>;
}

let inflight: Promise<void> | null = null;
// FF3 — hold a reference to the listener so resetLedgerStoreForTests
// can actually removeEventListener it. Pre-FF3 reset only flipped the
// `traceListenerAttached` flag; the previous listener stayed wired and
// kept calling refetch() forever. In production this is one process
// (no leak), but in vitest jsdom is shared across files — N test files
// = N live listeners per `dp:preflight-trace` event = N redundant
// refetches on every test that dispatches.
let activeTraceListener: ((e: Event) => void) | null = null;

/**
 * FF3 — retry once on a 5xx with 500ms backoff before settling into the
 * error state. Pre-FF3 a transient flaky 500 stuck `error` in the store
 * and any subscribed component rendered "Could not load the ledger"
 * until the next dp:preflight-trace event triggered another attempt.
 * One retry catches the most common transient failure window without
 * pinning the user on a stale error during a brief blip.
 */
async function fetchOnce(): Promise<Response> {
  return fetch(`${apiBase()}/api/ledger/digest`, { headers: sessionHeaders() });
}

async function fetchWithRetry(): Promise<Response> {
  const res = await fetchOnce();
  if (res.ok || res.status < 500) return res;
  await new Promise((r) => setTimeout(r, 500));
  return fetchOnce();
}

async function doFetch(
  // Accept both the object and updater-function forms of zustand's set (the
  // version bump at the success path needs the previous state).
  set: (
    partial:
      | Partial<LedgerState>
      | ((s: LedgerState) => Partial<LedgerState>),
  ) => void,
): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    set({ loading: true });
    try {
      const res = await fetchWithRetry();
      if (!res.ok) {
        set({ error: `${res.status}`, loading: false });
        return;
      }
      const body = (await res.json()) as LedgerDigest;
      set((s: any) => ({
        digest: body,
        error: null,
        loading: false,
        version: (s.version ?? 0) + 1,
      }) as Partial<LedgerState>);
    } catch (err: any) {
      set({ error: err?.message ?? String(err), loading: false });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export const useLedgerStore = create<LedgerState>((set, get) => ({
  digest: null,
  error: null,
  loading: false,
  version: 0,
  refetch: () => doFetch(set as any),
  overrideStance: async (payload) => {
    const { useToastStore } = await import("./toast");
    const label = payload.concept || payload.description || "this approach";
    try {
      const res = await fetch(`${apiBase()}/api/philosophy/override`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        useToastStore.getState().push({
          kind: "error",
          title: "Couldn't override",
          body: body?.error ?? `Request failed (${res.status})`,
          ttl: 7000,
        });
        return;
      }
      useToastStore.getState().push({
        kind: "success",
        // R2 — same tofu class as the ledger-write toast: the compass was a
        // literal emoji in the title string. Named SVG mark instead.
        icon: "compass",
        title: "Overridden — won't block this again",
        body: `"${label}" scoped down in your Ledger.`,
        ttl: 5000,
      });
      void get().refetch();
    } catch (err: any) {
      useToastStore.getState().push({
        kind: "error",
        title: "Couldn't override",
        body: err?.message ?? String(err),
        ttl: 7000,
      });
    }
  },
}));

/**
 * Wire one global dp:preflight-trace listener that bumps the cache.
 * Idempotent — re-importing the module doesn't double-attach.
 * BB2's 2s server cache absorbs bursts; this is just the invalidation
 * trigger.
 */
export function ensureLedgerSubscriptions(): void {
  if (activeTraceListener || typeof window === "undefined") return;
  activeTraceListener = () => {
    // Don't await — refetch fires async; subscribers re-render when
    // the new digest lands.
    void useLedgerStore.getState().refetch();
  };
  window.addEventListener("dp:preflight-trace", activeTraceListener);
  // Initial fetch on subscription wiring so the very first subscriber
  // gets data without each component re-firing its own fetch.
  void useLedgerStore.getState().refetch();
}

/**
 * Reset module-level state (store + inflight + listener flag) for
 * tests. Each `render()` in vitest runs against a fresh-mocked
 * `fetch` and expects the digest to be re-fetched; without a reset
 * the store carries last-test data over.
 */
export function resetLedgerStoreForTests(): void {
  inflight = null;
  // FF3 — actually remove the listener (not just flip a flag) so vitest
  // doesn't accumulate live listeners across files.
  if (activeTraceListener && typeof window !== "undefined") {
    window.removeEventListener("dp:preflight-trace", activeTraceListener);
  }
  activeTraceListener = null;
  useLedgerStore.setState({
    digest: null,
    error: null,
    loading: false,
    version: 0,
  });
}
