// #521 — the daemon re-checks, at commit, that the CURRENT autonomy level still
// permits a confidence auto-approval; a human approve (no reason) is unaffected.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import { withHash } from "./routes.harness.js";
import { createHttpRoutes } from "../routes.js";

let fx: GlobalStoreFixture;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;

beforeEach(() => {
  fx = withGlobalStore("dp-auto-approve-");
  store = fx.track(new FileStore(fx.dir, "test_session"));
  app = withHash(createHttpRoutes(store, fx.dir, () => {}), fx.dir);
  store.createArtifact({ id: "art_1", type: "research", title: "t", content: { confidence: "high" } });
});
afterEach(() => fx.dispose());

const post = (body: Record<string, unknown>) =>
  app.request("/api/artifacts/art_1/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const statusNow = async () => (await store.getArtifacts()).find((a) => a.id === "art_1")?.status;

describe("#521 — auto-approve commit re-check", () => {
  it("refuses an auto approval after the level dropped to supervised (409, no state change)", async () => {
    store.setAutonomyLevel("balanced");
    // The level is lowered between the request being dispatched and the commit.
    store.setAutonomyLevel("supervised");
    const res = await post({ status: "approved", reason: "auto_confidence" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("auto_approve_not_permitted");
    expect(await statusNow()).toBe("draft");
  });

  it.each(["balanced", "autonomous"] as const)("accepts an auto approval at %s", async (level) => {
    store.setAutonomyLevel(level);
    const res = await post({ status: "approved", reason: "auto_confidence" });
    expect(res.status).toBe(200);
    expect(await statusNow()).toBe("approved");
  });

  it("refuses an auto approval when the artifact is no longer high-confidence", async () => {
    store.setAutonomyLevel("balanced");
    store.createArtifact({ id: "art_2", type: "research", title: "t2", content: { confidence: "low" } });
    const res = await app.request("/api/artifacts/art_2/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", reason: "auto_confidence" }),
    });
    expect(res.status).toBe(409);
  });

  it.each(["supervised", "balanced", "autonomous"] as const)("a human approve (no reason) still lands at %s", async (level) => {
    store.setAutonomyLevel(level);
    const res = await post({ status: "approved" });
    expect(res.status).toBe(200);
    expect(await statusNow()).toBe("approved");
  });
});
