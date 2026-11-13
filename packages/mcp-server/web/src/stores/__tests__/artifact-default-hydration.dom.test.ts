import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useArtifactStore } from "../artifact";
import { useConnectionStore } from "../connection";
import { useReplayStore, replayRehydrateSettled } from "../replay";
import { computePending } from "../../lib/pending";
import type { ConnectionAdapter } from "../../lib/connection-adapter";

// Exercise the actual connected snapshot pipeline, with real DOM localStorage.
class HydrationAdapter implements ConnectionAdapter {
  message: ((data: any) => void) | null = null;
  connected: (() => void) | null = null;
  switched: string[] = [];
  switchSession(id: string) { this.switched.push(id); }
  connect() { this.connected?.(); }
  disconnect() {}
  onConnect(handler: () => void) { this.connected = handler; }
  onDisconnect(_handler: () => void) {}
  onMessage(handler: (data: any) => void) { this.message = handler; }
  emit(data: any) { this.message?.(data); }
}
const adapter = new HydrationAdapter();
vi.mock("../../lib/connection-adapter", () => ({ createAdapter: () => adapter }));

/**
 * L1 (#218) — selectDefaultOnHydration: the one-shot fallback that fills a
 * blank center pane after hydration. Ordinary calls never override a choice;
 * live hydration can replace its known provisional pick only without a valid
 * restored choice. Uses canonical Decide order, else the earliest visible
 * artifact (the served demo's hero rejected-research).
 *
 * `.dom.test.ts` for a real localStorage (the store touches it elsewhere).
 */
const mk = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    sessionId: "A", parentId: null, agentReasoning: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "research",
    title: id,
    status: "draft",
    version: 1,
    content: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as any;

/** Force selection to null WITHOUT going through addArtifact's auto-pick, to
 *  simulate a hydration that left nothing selected. */
function seedWithoutSelection(artifacts: any[]): void {
  useArtifactStore.setState({ artifacts, selectedArtifactId: null, unreadIds: [] });
}

describe("selectDefaultOnHydration (L1 #218)", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    localStorage.clear();
  });

  it("lands on a draft awaiting review when nothing is selected", () => {
    seedWithoutSelection([
      mk("rejected-hero", { status: "rejected", createdAt: "2026-01-01T00:00:01.000Z" }),
      mk("draft-plan", { type: "plan", status: "draft", createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("draft-plan");
  });

  it("uses canonical blocking/delegate priority even with missing legacy fixture timestamps", () => {
    seedWithoutSelection([
      mk("legacy-finding", { createdAt: undefined }),
      mk("brief", { type: "spec", content: { objective: "o", requirements: [], context: "Review: packet" } }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("brief");
  });

  it("does not replace an explicit choice when a different provisional id is supplied", () => {
    seedWithoutSelection([mk("finding"), mk("plan", { type: "plan", content: { steps: [] } })]);
    useArtifactStore.getState().selectArtifact("finding");
    useArtifactStore.getState().selectDefaultOnHydration("not-the-current-choice");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("finding");
  });

  it("falls back to the earliest VISIBLE artifact when no draft awaits review (the demo's rejected hero)", () => {
    // The scripted demo: research rejected, then read-only explainer/debrief.
    seedWithoutSelection([
      mk("hero-research", { status: "rejected", createdAt: "2026-01-01T00:00:01.000Z" }),
      mk("explainer", { type: "explainer", status: "approved", createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("hero-research");
  });

  it("ignores superseded artifacts", () => {
    seedWithoutSelection([
      mk("dead", { status: "superseded", createdAt: "2026-01-01T00:00:01.000Z" }),
      mk("live", { status: "rejected", createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("live");
  });

  it("no-ops when something is already selected (never steals focus)", () => {
    useArtifactStore.setState({
      artifacts: [mk("a"), mk("b")],
      selectedArtifactId: "b",
      unreadIds: [],
    });
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("b");
  });

  it("no-ops when there are no visible (non-superseded) artifacts", () => {
    seedWithoutSelection([mk("dead", { status: "superseded" })]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });

  it("does not persist the fallback pick (leaves a saved cross-session selection intact)", () => {
    localStorage.setItem("dp-selected-artifact", "from-another-session");
    seedWithoutSelection([mk("here", { status: "rejected" })]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("here");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("from-another-session");
  });
});


describe("#430 — canonical selection through real connected hydration", () => {
  beforeEach(() => {
    useConnectionStore.getState().disconnect();
    useConnectionStore.setState({ sessionId: null, projectRoot: null, activeSessions: [] });
    adapter.switched = [];
    useArtifactStore.getState().reset();
    useReplayStore.setState({ active: false, exiting: false, cursor: "" });
    localStorage.clear();
    vi.stubGlobal("Notification", undefined);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ blocks: [], sessions: [] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
  });
  afterEach(() => {
    useReplayStore.getState().completeExit();
    useConnectionStore.getState().disconnect();
    useReplayStore.setState({ active: false, exiting: false, cursor: "" });
    vi.unstubAllGlobals();
  });
  const decision = (id: string, over: Record<string, unknown> = {}) => mk(id, {
    type: "decision", content: { context: "Choose", options: [] },
    createdAt: "2026-01-01T00:00:02.000Z", ...over,
  });
  async function hydrate(artifacts: any[]) {
    useConnectionStore.getState().connect("A");
    adapter.emit({ type: "connected", state: { sessionId: "A", artifacts, comments: [], requests: [], decisions: [] } });
    await vi.waitFor(() => expect(useConnectionStore.getState().hydrated).toBe(true));
  }

  it.each([false, true])("uses tier/age/id order despite shuffled snapshot order (reverse=%s)", async (reverse) => {
    const items = [
      mk("finding-old"),
      mk("plan", { type: "plan", content: { steps: [] }, createdAt: "2026-01-01T00:00:02.000Z" }),
      decision("decision-z"), decision("decision-a"),
    ];
    const snapshot = reverse ? [...items].reverse() : items;
    await hydrate(snapshot);
    const state = useArtifactStore.getState();
    expect(state.selectedArtifactId).toBe("decision-a");
    expect(state.artifacts.map((a) => a.id)).toEqual(snapshot.map((a) => a.id));
    expect(computePending(state.artifacts).drafts).toHaveLength(4);
    // Preserve addArtifact's first-arrival bookkeeping, then mark the pane's
    // canonical target read, just as any selection does. No new unread policy.
    expect(state.unreadIds).toEqual(snapshot.slice(1).map((a) => a.id).filter((id) => id !== "decision-a"));
    expect(localStorage.getItem("dp-selected-artifact")).toBeNull();
  });

  it.each(["saved nonpending", "explicit nonpending"])("preserves a valid %s choice over the canonical head", async (kind) => {
    const selected = mk("resolved", { status: "approved" });
    if (kind === "explicit nonpending") {
      useArtifactStore.getState().addArtifact(selected);
      useArtifactStore.getState().selectArtifact("resolved");
    } else localStorage.setItem("dp-selected-artifact", "resolved");
    await hydrate([selected, decision("decision-a")]);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("resolved");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("resolved");
    expect(computePending(useArtifactStore.getState().artifacts).drafts).toHaveLength(1);
  });

  it("resolves a saved superseded id to its live successor without replacing that choice", async () => {
    localStorage.setItem("dp-selected-artifact", "old");
    await hydrate([
      mk("old", { status: "superseded" }), decision("decision-a"),
      mk("successor", { parentId: "old", status: "approved", version: 2 }),
    ]);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("successor");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("old");
  });

  it("uses canonical fallback for an invalid saved id without overwriting it", async () => {
    localStorage.setItem("dp-selected-artifact", "another-session");
    await hydrate([mk("finding-old"), decision("decision-a")]);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("decision-a");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("another-session");
  });

  it("keeps the earliest visible demo fallback, and null for only-superseded or empty snapshots", async () => {
    await hydrate([
      mk("read-later", { type: "explainer", status: "approved", createdAt: "2026-01-01T00:00:02.000Z" }),
      mk("rejected-hero", { status: "rejected" }),
    ]);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("rejected-hero");
    useConnectionStore.setState({ hydrated: false });
    await hydrate([mk("dead", { status: "superseded" })]);
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
    useConnectionStore.setState({ hydrated: false });
    await hydrate([]);
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });

  it("keeps replay's exact historical selection and applies canonical selection only after live exit hydration", async () => {
    await hydrate([mk("live-finding")]);
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(mk("historic-old", { sessionId: "history", status: "superseded" }));
    useArtifactStore.getState().addArtifact(mk("historic-next", { sessionId: "history", parentId: "historic-old", status: "approved", version: 2 }));
    useArtifactStore.getState().selectArtifactExact("historic-old");
    useReplayStore.setState({ active: true, exiting: false, sessionId: "history", cursor: "2026-02-01T00:00:00.000Z" });
    useConnectionStore.setState({ hydrated: false });
    // Wait for the actual connected handler to report hydration; the active
    // replay branch must leave the historical frame/exact selection untouched.
    await hydrate([mk("live-finding"), decision("live-decision")]);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("historic-old");
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["historic-old", "historic-next"]);
    useReplayStore.getState().exitReplay();
    await replayRehydrateSettled();
    await vi.waitFor(() => expect(adapter.switched).toEqual(["A"]));
    expect(useReplayStore.getState()).toMatchObject({ active: true, exiting: true });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("historic-old");
    useConnectionStore.setState({ hydrated: false });
    await hydrate([mk("live-finding"), decision("live-decision")]);
    expect(useReplayStore.getState()).toMatchObject({ active: false, exiting: false });
    expect(useArtifactStore.getState().selectedArtifactId).toBe("live-decision");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("historic-old");
  });

  it("does not let a later higher-tier live/sibling arrival preempt an established pane", async () => {
    await hydrate([mk("finding")]);
    adapter.emit({ type: "artifact_created", artifact: decision("decision-a") });
    await vi.waitFor(() => expect(useArtifactStore.getState().artifacts).toHaveLength(2));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("finding");
    useArtifactStore.getState().addArtifact(decision("sibling", { sessionId: "B" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("finding");
  });
});
