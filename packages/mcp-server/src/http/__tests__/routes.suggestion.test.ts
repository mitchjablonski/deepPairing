import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileStore } from "../../store/file-store.js";
import { createRoutesTestContext, destroyRoutesTestContext, type RoutesApp } from "./routes.harness.js";

/**
 * #172 — the human's take-counter / insist route. Drives the real public app
 * + a real FileStore (fake, not mock).
 */
let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});
afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

const jsonHeaders = { "Content-Type": "application/json" } as const;
const suggestion = {
  originalText: "  throw new Err();",
  replacementText: "  return null;",
  lineStart: 19,
  lineEnd: 19,
  state: "pending" as const,
};

function seedCountered(id = "cmt_s") {
  store.addComment({
    id,
    artifactId: "art_1",
    content: "returning early reads cleaner",
    author: "human",
    target: { lineStart: 19, lineEnd: 19, filePath: "lib/upload.ts" },
    intent: "suggestion",
    suggestion,
  });
  store.updateCommentSuggestion(id, { state: "countered", counter: { reason: "drops the upload", replacementText: "attach cause" } });
}

describe("#172 POST /api/comments/:commentId/suggestion", () => {
  it("take_counter → state applied and the comment is re-queued for the agent", async () => {
    seedCountered();
    const res = await app.request("/api/comments/cmt_s/suggestion", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ action: "take_counter" }),
    });
    expect(res.status).toBe(200);
    const c = store.getComment("cmt_s")!;
    expect(c.suggestion?.state).toBe("applied");
    expect(c.suggestion?.counter?.replacementText).toBe("attach cause"); // counter preserved
    expect(store.getUnacknowledgedComments().map((x) => x.id)).toContain("cmt_s");
  });

  it("insist → state insisted (the human's version is authoritative verbatim)", async () => {
    seedCountered();
    const res = await app.request("/api/comments/cmt_s/suggestion", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ action: "insist" }),
    });
    expect(res.status).toBe(200);
    expect(store.getComment("cmt_s")!.suggestion?.state).toBe("insisted");
  });

  it("rejects an action on a suggestion that is NOT countered (409)", async () => {
    store.addComment({
      id: "cmt_p", artifactId: "art_1", content: "why", author: "human",
      target: { lineStart: 19, lineEnd: 19, filePath: "lib/upload.ts" }, intent: "suggestion", suggestion,
    });
    const res = await app.request("/api/comments/cmt_p/suggestion", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ action: "insist" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("suggestion_not_countered");
  });

  it("unknown comment → 404", async () => {
    const res = await app.request("/api/comments/nope/suggestion", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ action: "insist" }),
    });
    expect(res.status).toBe(404);
  });

  it("invalid action → 400 validation_error", async () => {
    seedCountered();
    const res = await app.request("/api/comments/cmt_s/suggestion", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ action: "nope" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
  });
});
