import { describe, it, expect, afterEach, vi } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { useArtifactStore } from "../artifact";
import { useConnectionStore } from "../connection";
import { useToastStore } from "../toast";

/**
 * #422 — after a real session SWITCH, a stale failure neither writes into nor
 * toasts in the new session (session identity, the #415/#420 rule — not the
 * store generation). DOM env: the tab binding is read off window.
 */
function artifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id, sessionId: "sA", type: "changeset", version: 1, parentId: null, title: id, status: "draft",
    content: { files: [] }, agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z", ...over,
  } as Artifact;
}
const fail = () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  useConnectionStore.setState({ adapter: null, sessionId: null } as any);
  vi.unstubAllGlobals();
});

async function inAThenSwitch() {
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  (window as any).__dpConnectionStore = { getState: () => useConnectionStore.getState() };
  const switched: string[] = [];
  useConnectionStore.setState({ sessionId: "sA", adapter: { switchSession: (id: string) => switched.push(id) } } as any);
  let settle!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => { settle = res; })));
  return {
    switchToB: async () => {
      useConnectionStore.getState().switchSession("sB");
      await vi.waitFor(() => expect(switched).toEqual(["sB"]));
      // B's own snapshot — same artifact id by coincidence, B's own state.
      useArtifactStore.getState().addArtifact(artifact("cs", { sessionId: "sB", status: "draft", content: { files: [], reviewState: { "x.ts": "needs_changes" } } as any }));
    },
    fail: () => settle(fail()),
  };
}

describe("#422 — a stale failure after a real switch stays out of the new session", () => {
  it("setChangesetFileReview: no rollback into B and no toast in B; the caller still rejects", async () => {
    const t = await inAThenSwitch();
    useArtifactStore.setState({ artifacts: [artifact("cs")] });
    const a = useArtifactStore.getState().setChangesetFileReview("cs", "x.ts", "reviewed");
    await t.switchToB();
    t.fail();
    await expect(a).rejects.toBeTruthy();
    const c = useArtifactStore.getState().artifacts[0]!.content as { reviewState?: Record<string, string> };
    expect(c.reviewState?.["x.ts"]).toBe("needs_changes");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("updateArtifactStatus: no rollback into B and no toast in B", async () => {
    const t = await inAThenSwitch();
    useArtifactStore.setState({ artifacts: [artifact("cs")] });
    const a = useArtifactStore.getState().updateArtifactStatus("cs", "approved");
    await t.switchToB();
    useArtifactStore.getState().updateArtifact("cs", "revised");
    t.fail();
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("revised");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
