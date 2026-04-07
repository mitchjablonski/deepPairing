import { create } from "zustand";
import type { Artifact, Comment, ArtifactStatus } from "@deeppairing/shared";

const API_BASE = `http://${window.location.host}`;

export interface ArtifactState {
  artifacts: Artifact[];
  comments: Record<string, Comment[]>;
  selectedArtifactId: string | null;

  addArtifact: (artifact: Artifact) => void;
  updateArtifact: (id: string, status: ArtifactStatus, version?: number) => void;
  addComment: (comment: Comment) => void;
  selectArtifact: (id: string | null) => void;

  submitComment: (
    artifactId: string,
    content: string,
    target?: Record<string, unknown>,
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
  ) => Promise<void>;

  reset: () => void;
}

export const useArtifactStore = create<ArtifactState>((set) => ({
  artifacts: [],
  comments: {},
  selectedArtifactId: null,

  addArtifact: (artifact) =>
    set((state) => ({
      artifacts: [...state.artifacts, artifact],
      selectedArtifactId: state.selectedArtifactId ?? artifact.id,
    })),

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
      return {
        comments: { ...state.comments, [key]: [...existing, comment] },
      };
    }),

  selectArtifact: (id) => set({ selectedArtifactId: id }),

  submitComment: async (artifactId, content, target) => {
    await fetch(`${API_BASE}/api/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactId,
        content,
        target: { artifactId, ...target },
      }),
    });
  },

  updateArtifactStatus: async (artifactId, status, feedback) => {
    await fetch(`${API_BASE}/api/artifacts/${artifactId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, feedback }),
    });
  },

  resolveDecision: async (decisionId, optionId, reasoning) => {
    await fetch(`${API_BASE}/api/decisions/${decisionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId, reasoning }),
    });
  },

  reset: () => set({ artifacts: [], comments: {}, selectedArtifactId: null }),
}));
