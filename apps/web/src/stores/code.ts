import { create } from "zustand";
import type { CodeChangeEvent } from "@deeppairing/shared";

export interface CodeStore {
  changes: CodeChangeEvent[];
  selectedFile: string | null;

  addChange: (change: CodeChangeEvent) => void;
  selectFile: (path: string | null) => void;
  reset: () => void;
}

export const useCodeStore = create<CodeStore>((set) => ({
  changes: [],
  selectedFile: null,

  addChange: (change) =>
    set((state) => ({
      changes: [...state.changes, change],
      // Auto-select the first changed file
      selectedFile: state.selectedFile ?? change.filePath,
    })),

  selectFile: (path) => set({ selectedFile: path }),

  reset: () => set({ changes: [], selectedFile: null }),
}));
