import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConnectionAdapter } from "../../lib/connection-adapter";

/**
 * #430 PR 1e (docs/design/attention-hierarchy.md §2.8, §8 PR 1e) — the OS
 * "your turn" alert's 5s burst throttle was type-blind: a DECISION that arrived
 * right after a finding got no alert at all, so the one item that blocks the
 * agent was the one you didn't hear about. Decisions are exempt; the throttle
 * still collapses bursts of other drafts. Real store + a fake adapter + a fake
 * Notification that counts what the OS would show.
 */
class FakeAdapter implements ConnectionAdapter {
  messageHandler: ((data: any) => void) | null = null;
  connect() {}
  disconnect() {}
  onMessage(h: (data: any) => void) { this.messageHandler = h; }
  onConnect() {}
  onDisconnect() {}
  refreshUrl() {}
  switchSession() {}
  onFatalMismatch() {}
  onConnectionRefused() {}
  retryAfterRefusal() {}
  emit(data: any) { this.messageHandler?.(data); }
}
let adapter: FakeAdapter;
vi.mock("../../lib/connection-adapter", () => ({ createAdapter: () => adapter }));

const shown: { title: string; body?: string }[] = [];
class FakeNotification {
  static permission = "granted";
  static requestPermission() { return Promise.resolve("granted"); }
  constructor(title: string, opts?: { body?: string }) { shown.push({ title, body: opts?.body }); }
}

let seq = 0;
const draft = (type: string, title: string) => ({
  type: "artifact_created",
  artifact: {
    id: `a${++seq}`, sessionId: "s1", type, version: 1, parentId: null, title, status: "draft",
    content: {}, agentReasoning: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
});
/** The store handles each message after a dynamic import — give it a tick. */
const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeEach(async () => {
  adapter = new FakeAdapter();
  shown.length = 0;
  vi.resetModules();
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(document, "hasFocus").mockReturnValue(false); // the tab is in the background
  const { useConnectionStore } = await import("../connection");
  const { useArtifactStore } = await import("../artifact");
  useArtifactStore.getState().reset();
  useConnectionStore.getState().connect();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("#430 PR 1e — a decision always gets its OS alert", () => {
  it("finding then decision within 5s → TWO alerts (the decision is not swallowed)", async () => {
    adapter.emit(draft("research", "Refresh isn't coalesced"));
    await flush();
    adapter.emit(draft("decision", "Which store backs the session cache?"));
    await flush();
    expect(shown.map((n) => n.body)).toEqual([
      "Findings ready for review: Refresh isn't coalesced",
      "Decision needed: Which store backs the session cache?",
    ]);
  });

  it("finding then finding within 5s → ONE alert (the burst throttle still applies)", async () => {
    adapter.emit(draft("research", "First finding"));
    await flush();
    adapter.emit(draft("research", "Second finding"));
    await flush();
    expect(shown.map((n) => n.body)).toEqual(["Findings ready for review: First finding"]);
  });

  it("a decision does not reset the throttle for the drafts around it", async () => {
    adapter.emit(draft("research", "First finding"));
    await flush();
    adapter.emit(draft("decision", "A decision"));
    await flush();
    adapter.emit(draft("plan", "A plan"));
    await flush();
    // The plan is still inside the finding's 5s burst → collapsed.
    expect(shown.map((n) => n.body)).toEqual([
      "Findings ready for review: First finding",
      "Decision needed: A decision",
    ]);
  });

  it("the same decision announced twice (artifact_created + decision_request) still alerts once", async () => {
    const created = draft("decision", "Once only");
    adapter.emit(created);
    await flush();
    adapter.emit({ type: "decision_request", artifactId: created.artifact.id, context: "Once only" });
    await flush();
    expect(shown).toHaveLength(1);
  });
});
