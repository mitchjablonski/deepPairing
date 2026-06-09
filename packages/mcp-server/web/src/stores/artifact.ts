import { create } from "zustand";
import type { Artifact, Comment, ArtifactStatus } from "@deeppairing/shared";
import { apiBase, sessionHeaders, safeFetch, ApiError } from "../lib/api";

// Monotonic counter for provisional (optimistic) comment ids until the server
// assigns a real one. Module-scoped so ids stay unique across submits.
let localCommentSeq = 0;

/**
 * U3 — surface a mutation failure as a toast. Pulled out of every catch
 * block so the message wording stays consistent and the import isn't
 * top-of-file (toast store is lazy-loaded to avoid Zustand circular-import
 * pain — same pattern as connection.ts).
 */
async function toastApiError(action: string, err: unknown): Promise<void> {
  const { useToastStore } = await import("./toast");
  const apiErr = err instanceof ApiError ? err : null;
  // BB10 — project_hash_mismatch is the AA4 stale-tab guard firing.
  // The user's tab is pinned to daemon-A's hash but the live daemon is
  // daemon-B (after an idle-shutdown / port re-bind). The fix is always
  // a reload to refetch the new hash. Pre-BB10 this came through as a
  // generic "request failed" toast and the user had no idea what to do.
  if (apiErr?.code === "project_hash_mismatch") {
    useToastStore.getState().push({
      kind: "error",
      title: "Tab is bound to a stale daemon",
      body: "This project's daemon was replaced. Reload the page to re-bind.",
      ttl: 0,
      action: {
        label: "Reload",
        onClick: () => {
          if (typeof window !== "undefined") window.location.reload();
        },
      },
    });
    return;
  }
  useToastStore.getState().push({
    kind: "error",
    title: `${action} failed`,
    body: apiErr?.message ?? (err instanceof Error ? err.message : "Unknown error"),
    ttl: 7000,
  });
}

export interface ArtifactState {
  artifacts: Artifact[];
  comments: Record<string, Comment[]>;
  selectedArtifactId: string | null;
  unreadIds: string[];

  addArtifact: (artifact: Artifact) => void;
  updateArtifact: (id: string, status: ArtifactStatus, version?: number) => void;
  addComment: (comment: Comment) => void;
  /** Upsert an existing comment by id (e.g. from a comment_updated WS event). */
  updateComment: (comment: Comment) => void;
  selectArtifact: (id: string | null) => void;
  /** Re-select the artifact you were last on (persisted across reloads), if
   *  it's present in the freshly-hydrated session. Called after hydration. */
  restoreSelection: () => void;

  submitComment: (
    artifactId: string,
    content: string,
    target?: Record<string, unknown>,
    options?: { intent?: "comment" | "question" | "suggestion"; parentCommentId?: string | null },
  ) => Promise<void>;

  updateArtifactStatus: (
    artifactId: string,
    // "obsolete" = human dismisses a draft as overcome by new information
    // (already used by ArtifactStatusActions' Dismiss; widen the type to match).
    status: "approved" | "revised" | "rejected" | "obsolete",
    feedback?: string,
  ) => Promise<void>;

  resolveDecision: (
    decisionId: string,
    optionId: string,
    reasoning?: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ) => Promise<void>;

  renameArtifact: (artifactId: string, title: string) => Promise<void>;

  /**
   * Mark a human's OWN unanswered question resolved. Optimistically stamps
   * humanResolvedAt locally then POSTs. VISIBILITY/waiting-signal only — does
   * NOT touch the comment's `acknowledged` field (the agent's drain queue).
   */
  markQuestionResolved: (commentId: string) => Promise<void>;

  reset: () => void;
}

// QOL — remember which artifact you were on so a reload returns you there
// instead of snapping to the first artifact. Guarded for non-browser contexts.
const SELECTION_KEY = "dp-selected-artifact";
function lsGetSelection(): string | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(SELECTION_KEY); } catch { return null; }
}
function lsSetSelection(id: string | null): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    if (id) localStorage.setItem(SELECTION_KEY, id);
    else localStorage.removeItem(SELECTION_KEY);
  } catch { /* private mode / quota — selection persistence is best-effort */ }
}

export const useArtifactStore = create<ArtifactState>((set) => ({
  artifacts: [],
  comments: {},
  selectedArtifactId: null,
  unreadIds: [],

  // U0.1 — upsert by id. Field bug: a single comment posted to an artifact
  // visibly increased its count over time while the user just sat on the
  // page. Root cause: addArtifact / addComment blindly appended to the
  // store on every WS event, so any broadcast loop, replay scrub, or
  // reconnect-driven re-hydration multiplied the local count even though
  // the daemon's store had exactly one record. Idempotent upserts collapse
  // any redelivery (planned or accidental) into a single visible record.
  addArtifact: (artifact) =>
    set((state) => {
      const idx = state.artifacts.findIndex((a) => a.id === artifact.id);
      if (idx >= 0) {
        const next = state.artifacts.slice();
        next[idx] = { ...state.artifacts[idx], ...artifact };
        return { artifacts: next };
      }
      return {
        artifacts: [...state.artifacts, artifact],
        selectedArtifactId: state.selectedArtifactId ?? artifact.id,
        unreadIds: state.selectedArtifactId && state.selectedArtifactId !== artifact.id
          ? [...state.unreadIds, artifact.id]
          : state.unreadIds,
      };
    }),

  updateArtifact: (id, status, version) =>
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === id ? { ...a, status, ...(version != null ? { version } : {}) } : a,
      ),
    })),

  addComment: (comment) =>
    set((state) => {
      const key = comment.target.artifactId;
      const existing = state.comments[key] ?? [];
      // U0.1 dedupe: skip if a comment with this id is already in the bucket.
      if (existing.some((c) => c.id === comment.id)) return state;
      return {
        comments: { ...state.comments, [key]: [...existing, comment] },
      };
    }),

  updateComment: (comment) =>
    set((state) => {
      const key = comment.target.artifactId;
      const existing = state.comments[key] ?? [];
      const idx = existing.findIndex((c) => c.id === comment.id);
      // Upsert: replace in place if present, else append (a comment_updated
      // for an unseen comment shouldn't be dropped).
      const next = idx >= 0
        ? existing.map((c) => (c.id === comment.id ? { ...c, ...comment } : c))
        : [...existing, comment];
      return { comments: { ...state.comments, [key]: next } };
    }),

  selectArtifact: (id) => set((state) => {
    lsSetSelection(id);
    return {
      selectedArtifactId: id,
      unreadIds: state.unreadIds.filter((uid) => uid !== id),
    };
  }),

  restoreSelection: () => set((state) => {
    const saved = lsGetSelection();
    // Only restore if it's still in the session; otherwise leave the default
    // (first artifact) that addArtifact picked during hydration.
    if (saved && state.artifacts.some((a) => a.id === saved)) {
      return {
        selectedArtifactId: saved,
        unreadIds: state.unreadIds.filter((uid) => uid !== saved),
      };
    }
    return {};
  }),

  // U3 — every mutation goes through safeFetch and toasts on failure.
  // Pre-U3 these dropped the response on the floor: a 4xx or 5xx (or a
  // network blip) was indistinguishable from success. The user clicked
  // approve, the optimistic UI showed APPROVED, but the daemon's store
  // never received the POST — the agent kept polling check_feedback
  // forever. Now every silent failure surfaces as an error toast so the
  // user can react (re-try, run doctor, restart Claude Code, etc).

  submitComment: async (artifactId, content, target, options) => {
    // Optimistic: render the comment immediately instead of waiting on the
    // session-scoped `comment_added` WS broadcast. Pre-this, submitComment was
    // the last broadcast-only mutation — the user hit send and nothing appeared
    // until the round-trip, and in the global-client window right after a
    // project switch (before a session is selected) the comment could appear to
    // vanish entirely. Snapshot for rollback, insert a provisional, then
    // reconcile with the server-assigned comment (addComment dedupes by id, so
    // the later WS echo collapses into one record).
    const prev = useArtifactStore.getState().comments;
    const sid =
      (typeof window !== "undefined" &&
        (window as any).__dpConnectionStore?.getState?.().sessionId) || "";
    const provisional: Comment = {
      id: `local_${Date.now().toString(36)}_${++localCommentSeq}`,
      sessionId: sid,
      target: { artifactId, ...target },
      parentCommentId: options?.parentCommentId ?? null,
      author: "human",
      content,
      acknowledged: false,
      createdAt: new Date().toISOString(),
      ...(options?.intent ? { intent: options.intent } : {}),
    } as Comment;
    useArtifactStore.getState().addComment(provisional);
    try {
      const res = await safeFetch(`${apiBase()}/api/comments`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({
          artifactId,
          content,
          target: { artifactId, ...target },
          intent: options?.intent,
          parentCommentId: options?.parentCommentId ?? null,
        }),
      });
      // Reconcile: swap the provisional for the real (server-id'd) comment.
      let serverComment: Comment | null = null;
      try { serverComment = (await res.json())?.comment ?? null; } catch { /* keep provisional */ }
      set((state) => {
        const list = (state.comments[artifactId] ?? []).filter((c) => c.id !== provisional.id);
        const next =
          serverComment && !list.some((c) => c.id === serverComment!.id)
            ? [...list, serverComment]
            : list;
        return { comments: { ...state.comments, [artifactId]: next } };
      });
    } catch (err) {
      // Roll back the provisional so a failed send doesn't leave a phantom.
      set({ comments: prev });
      await toastApiError("Send comment", err);
      throw err;
    }
  },

  updateArtifactStatus: async (artifactId, status, feedback) => {
    // Optimistic: flip the local status immediately so the item leaves the
    // "waiting for you" set (PendingBanner/TurnIndicator/cross-project badge)
    // the instant you act on it — don't wait on the WS `artifact_updated`
    // broadcast. That broadcast is session-scoped; when you're viewing a
    // project you SWITCHED into (a cross-project connection), it may never
    // reach this tab, leaving a just-dismissed draft rendering as "waiting
    // for you" (e.g. an obsolete item that won't clear). Same optimistic +
    // rollback pattern as renameArtifact / markQuestionResolved.
    const prev = useArtifactStore.getState().artifacts;
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, status } : a,
      ),
    }));
    try {
      await safeFetch(`${apiBase()}/api/artifacts/${artifactId}/status`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ status, feedback }),
      });
    } catch (err) {
      // Roll back so the UI reflects truth (still awaiting your review).
      set({ artifacts: prev });
      await toastApiError(
        status === "approved" ? "Approve" : status === "rejected" ? "Reject" : "Revise",
        err,
      );
      throw err;
    }
  },

  resolveDecision: async (decisionId, optionId, reasoning, prediction) => {
    // Optimistic: flip the decision artifact to "approved" locally so it leaves
    // the "waiting for you" set the instant you choose — don't wait on the
    // session-scoped `decision_resolved` WS broadcast (which never reaches a
    // tab viewing a project it switched into). The server route ALSO marks the
    // artifact approved, so this just closes the local-state gap. Same
    // optimistic + rollback pattern as updateArtifactStatus.
    const prev = useArtifactStore.getState().artifacts;
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        // ArtifactPanel resolves decisions by content.decisionId, falling back
        // to the artifact id (effectiveDecisionId), so match both.
        (a.content as any)?.decisionId === decisionId ||
        (a.type === "decision" && a.id === decisionId)
          ? { ...a, status: "approved" as ArtifactStatus }
          : a,
      ),
    }));
    try {
      await safeFetch(`${apiBase()}/api/decisions/${decisionId}`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({
          optionId,
          reasoning,
          confidence: prediction?.confidence,
          predictedOutcome: prediction?.predictedOutcome,
        }),
      });
    } catch (err) {
      // Roll back so the decision is still shown as awaiting your choice.
      set({ artifacts: prev });
      await toastApiError("Resolve decision", err);
      throw err;
    }
  },

  renameArtifact: async (artifactId, title) => {
    // Optimistic UI: apply the rename locally first; roll back on failure.
    const prev = useArtifactStore.getState().artifacts;
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, title } : a,
      ),
    }));
    try {
      await safeFetch(`${apiBase()}/api/artifacts/${artifactId}/rename`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ title }),
      });
    } catch (err) {
      // Roll back the optimistic update so the UI reflects truth.
      set({ artifacts: prev });
      await toastApiError("Rename artifact", err);
      throw err;
    }
  },

  markQuestionResolved: async (commentId) => {
    const resolvedAt = new Date().toISOString();
    // Optimistic: stamp humanResolvedAt locally so the waiting signal clears
    // immediately. Snapshot for rollback on failure.
    const prev = useArtifactStore.getState().comments;
    set((state) => {
      const nextComments: Record<string, Comment[]> = {};
      for (const [key, list] of Object.entries(state.comments)) {
        nextComments[key] = list.map((c) =>
          c.id === commentId ? { ...c, humanResolvedAt: resolvedAt } : c,
        );
      }
      return { comments: nextComments };
    });
    try {
      await safeFetch(`${apiBase()}/api/comments/${commentId}/mark-resolved`, {
        method: "POST",
        headers: sessionHeaders(),
        body: JSON.stringify({ resolvedAt }),
      });
    } catch (err) {
      // Roll back so the UI reflects truth (still awaiting).
      set({ comments: prev });
      await toastApiError("Mark question resolved", err);
      throw err;
    }
  },

  reset: () => set({ artifacts: [], comments: {}, selectedArtifactId: null, unreadIds: [] }),
}));
