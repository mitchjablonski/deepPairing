import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linkServedRequest } from "../tool-helpers.js";
import { FileStore } from "../../store/file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

/**
 * G1 (#198b, review Fix 2) — linkServedRequest must be HONEST: it confirms a
 * link only when markRequestServed actually found the request; an unknown/
 * foreign id yields a "not found" note (not a false "Linked" claim). Real
 * FileStore, no mocks.
 */

let fx: GlobalStoreFixture;
let tmpDir: string;
beforeEach(() => {
  fx = withGlobalStore("dp-link-served-");
  tmpDir = fx.dir;
});
afterEach(() => {
  fx.dispose();
});

describe("#198b linkServedRequest honesty", () => {
  it("confirms the link when the request exists, and marks it served", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const req = store.addRequest({ text: "the auth middleware", intent: "explain" });
    const note = await linkServedRequest(store, { servedRequestId: req.id }, "art_x");
    expect(note).toBe(` Linked to request ${req.id}.`);
    expect(store.getPendingRequests()).toHaveLength(0);
    expect(store.getRequests()[0]!.servedByArtifactId).toBe("art_x");
  });

  it("does NOT claim a link for an unknown request id — returns an honest 'not found' note", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    const note = await linkServedRequest(store, { servedRequestId: "req_ghost" }, "art_x");
    expect(note).toMatch(/not found — not linked/);
    // Nothing was served.
    expect(store.getRequests()).toHaveLength(0);
  });

  it("no-ops silently (empty note) when no servedRequestId is supplied", async () => {
    const store = fx.track(new FileStore(tmpDir, "s1"));
    expect(await linkServedRequest(store, {}, "art_x")).toBe("");
    expect(await linkServedRequest(store, { servedRequestId: "" }, "art_x")).toBe("");
  });
});
