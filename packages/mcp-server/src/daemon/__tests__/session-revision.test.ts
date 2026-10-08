/**
 * #460 — the per-session CHANGE signal on /api/active-sessions. A tab bound to
 * session A never receives a sibling's session-scoped broadcasts; the 10s
 * session poll is how it learns a sibling changed. #458 used the artifact
 * count, which misses a pure status change (a decision resolved elsewhere) and
 * a new question (a comment). `revision` moves on both, and NOT on heartbeats.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDaemon, type Daemon } from "../create-daemon.js";
import { projectHashOf } from "../../project-root.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

let fx: GlobalStoreFixture;
let daemon: Daemon;
let hash = "";
const SID = "s_bill";

beforeEach(() => {
  fx = withGlobalStore("dp-session-revision-");
  hash = projectHashOf(fx.dir);
  daemon = createDaemon({
    projectRoot: fx.dir, authToken: "test-token", log: () => {}, exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
  });
});
afterEach(() => {
  daemon.dispose();
  fx.dispose();
});

const H = () => ({ Authorization: "Bearer test-token", "Content-Type": "application/json", "X-Project-Hash": hash });
const internal = (route: string, body: unknown) =>
  daemon.app.request(`/api/internal/sessions/${SID}/${route}`, { method: "POST", headers: H(), body: JSON.stringify(body) });
const publicPost = (route: string, body: unknown) =>
  daemon.app.request(route, { method: "POST", headers: { ...H(), "X-Session-Id": SID }, body: JSON.stringify(body) });
const revision = async (): Promise<number> => {
  const res = await daemon.app.request("/api/active-sessions", { headers: H() });
  const list = (await res.json()).sessions as Array<{ sessionId: string; revision?: number; artifactCount: number }>;
  return list.find((s) => s.sessionId === SID)!.revision!;
};

describe("#460 — /api/active-sessions revision", () => {
  it("moves on a pure status change and on a new question (the count doesn't), not on a heartbeat", async () => {
    expect((await internal("register", { title: "Billing" })).status).toBe(200);
    expect((await internal("artifacts", { id: "a1", type: "research", title: "Finding", content: { summary: "s", findings: [] } })).status).toBe(200);
    const r0 = await revision();
    expect(typeof r0).toBe("number");

    // A heartbeat-only internal call (agent activity) — no state change.
    const read = await daemon.app.request(`/api/internal/sessions/${SID}/artifacts`, { headers: H() });
    expect(read.status).toBe(200);
    expect(await revision()).toBe(r0);

    // Approved in another tab: artifactCount unchanged, revision moves.
    expect((await publicPost("/api/artifacts/a1/status", { status: "approved" })).status).toBe(200);
    const r1 = await revision();
    expect(r1).toBeGreaterThan(r0);

    // A question (a comment): artifactCount unchanged, revision moves.
    expect((await publicPost("/api/comments", { artifactId: "a1", content: "Why 12%?", intent: "question" })).status).toBe(200);
    expect(await revision()).toBeGreaterThan(r1);
  });
});
