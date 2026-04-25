import { create } from "zustand";
import type { Artifact, Comment, ArtifactStatus } from "@deeppairing/shared";
import { API_BASE, sessionHeaders } from "../lib/api";

export interface ArtifactState {
  artifacts: Artifact[];
  comments: Record<string, Comment[]>;
  selectedArtifactId: string | null;
  unreadIds: string[];

  addArtifact: (artifact: Artifact) => void;
  updateArtifact: (id: string, status: ArtifactStatus, version?: number) => void;
  addComment: (comment: Comment) => void;
  selectArtifact: (id: string | null) => void;

  submitComment: (
    artifactId: string,
    content: string,
    target?: Record<string, unknown>,
    options?: { intent?: "comment" | "question" | "suggestion"; parentCommentId?: string | null },
  ) => Promise<void>;

  updateArtifactStatus: (
    artifactId: string,
    status: "approved" | "revised" | "rejected",
    feedback?: string,
  ) => Promise<void>;

  resolveDecision: (
    decisionId: string,
    optionId: string,
    reasoning?: string,
    prediction?: { confidence?: "low" | "medium" | "high"; predictedOutcome?: string },
  ) => Promise<void>;

  renameArtifact: (artifactId: string, title: string) => Promise<void>;

  reset: () => void;
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

  selectArtifact: (id) => set((state) => ({
    selectedArtifactId: id,
    unreadIds: state.unreadIds.filter((uid) => uid !== id),
  })),

  submitComment: async (artifactId, content, target, options) => {
    await fetch(`${API_BASE}/api/comments`, {
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
  },

  updateArtifactStatus: async (artifactId, status, feedback) => {
    await fetch(`${API_BASE}/api/artifacts/${artifactId}/status`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ status, feedback }),
    });
  },

  resolveDecision: async (decisionId, optionId, reasoning, prediction) => {
    await fetch(`${API_BASE}/api/decisions/${decisionId}`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({
        optionId,
        reasoning,
        confidence: prediction?.confidence,
        predictedOutcome: prediction?.predictedOutcome,
      }),
    });
  },

  renameArtifact: async (artifactId, title) => {
    await fetch(`${API_BASE}/api/artifacts/${artifactId}/rename`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ title }),
    });
    set((state) => ({
      artifacts: state.artifacts.map((a) =>
        a.id === artifactId ? { ...a, title } : a,
      ),
    }));
  },

  reset: () => set({ artifacts: [], comments: {}, selectedArtifactId: null, unreadIds: [] }),
}));
