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

const mkV = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, type: "plan", title: "Plan", status: "draft", version: 1, content: {}, parentId: null, ...over }) as any;

describe("revision selection — land on the live version, not the dead one", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    localStorage.clear();
  });

  it("does NOT default-select a superseded artifact during hydration", () => {
    const s = useArtifactStore.getState();
    // Hydration order: the (now superseded) v1 arrives first, then its revision.
    s.addArtifact(mkV("v1", { status: "superseded" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull(); // skipped
    s.addArtifact(mkV("v2", { parentId: "v1", version: 2 }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("v2"); // lands on the live revision
  });

  it("follows to the successor when the viewed artifact is superseded mid-session", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mkV("v1"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("v1");
    // The revision arrives, then v1 flips to superseded (the revise_artifact flow).
    s.addArtifact(mkV("v2", { parentId: "v1", version: 2 }));
    s.updateArtifact("v1", "superseded");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("v2");
  });

  // U8 — selectArtifact() itself resolves a stale id (handed by CausalChain
  // rows, related badges, the command palette, dp:focus-artifact, …) to the
  // live successor, so no caller lands on a dead read-only version.
  it("selectArtifact resolves a superseded id to its live successor", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mkV("v1", { status: "superseded" }));
    s.addArtifact(mkV("v2", { parentId: "v1", version: 2 }));
    s.selectArtifact("v1");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("v2");
  });

  it("selectArtifact follows a multi-step supersede chain to the latest live version", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mkV("v1", { status: "superseded" }));
    s.addArtifact(mkV("v2", { parentId: "v1", version: 2, status: "superseded" }));
    s.addArtifact(mkV("v3", { parentId: "v2", version: 3 }));
    s.selectArtifact("v1");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("v3");
  });

  it("selectArtifact(null) clears selection without resolving", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mkV("v1"));
    s.selectArtifact(null);
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });

  it("restoreSelection resolves a saved-but-now-superseded id to the live version", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(mkV("v1", { status: "superseded" }));
    s.addArtifact(mkV("v2", { parentId: "v1", version: 2 }));
    localStorage.setItem("dp-selected-artifact", "v1"); // saved before v1 was superseded
    s.restoreSelection();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("v2");
  });
});
