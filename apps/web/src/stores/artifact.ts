import { create } from "zustand";
import type { Artifact, Comment, ArtifactStatus } from "@deeppairing/shared";

const API_BASE = "http://localhost:3001";

export interface ArtifactState {
  artifacts: Artifact[];
  comments: Record<string, Comment[]>;
  selectedArtifactId: string | null;

  addArtifact: (artifact: Artifact) => void;
  updateArtifact: (id: string, status: ArtifactStatus, version?: number) => void;
  addComment: (comment: Comment) => void;
  selectArtifact: (id: string | null) => void;

  submitComment: (
    sessionId: string,
    artifactId: string,
    content: string,
    target?: { lineNumber?: number; findingIndex?: number; stepIndex?: number },
    parentCommentId?: string,
  ) => Promise<void>;

  updateArtifactStatus: (
    sessionId: string,
    artifactId: string,
    status: "approved" | "revised" | "rejected",
    feedback?: string,
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

  submitComment: async (sessionId, artifactId, content, target, parentCommentId) => {
    await fetch(`${API_BASE}/api/sessions/${sessionId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { artifactId, ...target },
        content,
        parentCommentId: parentCommentId ?? null,
      }),
    });
    // The comment will arrive via SSE and be added through addComment
  },

  updateArtifactStatus: async (sessionId, artifactId, status, feedback) => {
    await fetch(
      `${API_BASE}/api/sessions/${sessionId}/artifacts/${artifactId}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, feedback }),
      },
    );
    // The status update will arrive via SSE
  },

  reset: () => set({ artifacts: [], comments: {}, selectedArtifactId: null }),
}));
