import { describe, it, expect, vi, afterEach } from "vitest";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import type { IStore } from "../../store/store-interface.js";

/**
 * H1-4 — check_feedback starts a 10s progress-heartbeat setInterval, then
 * `await store.waitForFeedback(30000)`, then clearInterval — pre-fix with NO
 * try/finally. DaemonClient.waitForFeedback re-throws on network-down/5xx, so
 * if the daemon dies mid-poll the await throws, clearInterval is skipped, and
 * the interval fires server.notification(...) on a dead progressToken every 10s
 * FOREVER. This test drives that exact path with a real fake store whose
 * waitForFeedback rejects, and asserts the interval is cleared (no further
 * notifications) even though the handler rejects.
 */

/** Real fake: a store that has a pending draft (so check_feedback enters the
 *  long-poll branch) and whose waitForFeedback rejects like a dead daemon. */
function makeThrowingStore(): IStore {
  const draft = { id: "a1", type: "spec", status: "draft", title: "Spec", createdAt: new Date().toISOString() };
  return {
    getUnacknowledgedComments: async () => [],
    getResolvedDecisions: async () => [],
    getArtifacts: async () => [draft],
    async waitForFeedback() {
      throw new Error("[deepPairing] request failed (503) — daemon down");
    },
  } as unknown as IStore;
}

function makeCtx(store: IStore): { ctx: ToolContext; notifications: unknown[] } {
  const notifications: unknown[] = [];
  const server = { notification: (n: unknown) => { notifications.push(n); } };
  const ctx = {
    server,
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok-1",
  } as unknown as ToolContext;
  return { ctx, notifications };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("H1-4 — check_feedback heartbeat interval is cleared on a throwing waitForFeedback", () => {
  it("clears the interval even when the poll throws — no notifications fire on the dead token afterward", async () => {
    vi.useFakeTimers();
    const store = makeThrowingStore();
    const { ctx, notifications } = makeCtx(store);

    // The handler must reject (the throw propagates — the caller decides), but
    // the finally must have cleared the 10s heartbeat interval first.
    await expect(handleCheckFeedback(ctx, {})).rejects.toThrow(/503|daemon down/);

    // Pre-fix, the interval survived the throw: advancing 60s would fire ~6
    // server.notification calls on the dead progressToken. Post-fix: zero.
    notifications.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifications).toHaveLength(0);
  });
});
