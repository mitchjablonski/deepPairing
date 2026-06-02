import { describe, it, expect, beforeEach } from "vitest";
import { useArtifactStore } from "../artifact";

/**
 * QOL — a reload should return you to the artifact you were last on, not snap
 * to the first one. selectArtifact persists the id; restoreSelection (called
 * after the session re-hydrates) re-selects it if it's still present.
 *
 * `.dom.test.ts` so happy-dom gives a real localStorage.
 */
const mk = (id: string) =>
  ({ id, type: "finding", title: id, status: "draft", version: 1, content: {} }) as any;

describe("artifact selection survives reload (restoreSelection)", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    localStorage.clear();
  });

  it("persists the selection and restores it after re-hydration", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mk("a1"));
    s.addArtifact(mk("a2"));
    s.selectArtifact("a2");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("a2");

    // Simulate a reload: reset, then hydrate again (a1 added first → default pick).
    s.reset();
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
    useArtifactStore.getState().addArtifact(mk("a1"));
    useArtifactStore.getState().addArtifact(mk("a2"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1"); // hydration default

    useArtifactStore.getState().restoreSelection();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a2"); // restored to where you were
  });

  it("no-ops when the saved artifact is not in the session (falls back to default)", () => {
    localStorage.setItem("dp-selected-artifact", "not-here");
    useArtifactStore.getState().addArtifact(mk("a1"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
    useArtifactStore.getState().restoreSelection();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });

  it("clears the persisted id when selection is cleared", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mk("a1"));
    s.selectArtifact("a1");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("a1");
    s.selectArtifact(null);
    expect(localStorage.getItem("dp-selected-artifact")).toBeNull();
  });
});
