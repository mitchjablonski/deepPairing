import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemonRoutes, type SessionMeta } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";

/**
 * #172 (review F2 + F1-defense) — the AGENT-driven internal suggestion route
 * must Zod-validate its body (parity with every sibling internal route) and
 * re-run the transition guard so a raw call can't counter-after-insist. Fake,
 * not mock: real FileStore + a real Hono app via app.request().
 */
let tmpDir: string;
let sessions: Map<string, FileStore>;
let app: ReturnType<typeof createDaemonRoutes>;
const TOKEN = "test-secret-token";

const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const suggestion = {
  originalText: "  throw new Err();",
  replacementText: "  return null;",
  lineStart: 19, lineEnd: 19, state: "pending" as const,
};

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-sugg-guard-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  sessions = new Map();
  app = createDaemonRoutes(sessions, new Map<string, SessionMeta>(), (id) => {
    const s = new FileStore(tmpDir, id);
    sessions.set(id, s);
    return s;
  }, () => {}, undefined, tmpDir, TOKEN);
  await app.request("/api/internal/sessions/real/register", { method: "POST", headers: authHeaders, body: "{}" });
  // Seed a suggestion comment directly on the store.
  sessions.get("real")!.addComment({
    id: "cmt_s", artifactId: "art_1", content: "why", author: "human",
    target: { lineStart: 19, lineEnd: 19, filePath: "lib/upload.ts" }, intent: "suggestion", suggestion,
  });
});
afterEach(() => {
  setGlobalStoreForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const suggestionUrl = "/api/internal/sessions/real/comments/cmt_s/suggestion";

describe("#172 internal suggestion route — F2 validation + F1 defense", () => {
  it("F2 — a hostile shape (bad state, non-string reason, NaN version) → 400, nothing persists", async () => {
    const res = await app.request(suggestionUrl, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ state: "obliterated", counter: { reason: 42 }, appliedInVersion: "NaNv" }),
    });
    expect(res.status).toBe(400);
    // The stored suggestion is untouched.
    expect(sessions.get("real")!.getComment("cmt_s")!.suggestion?.state).toBe("pending");
  });

  it("F2 — a non-integer version → 400", async () => {
    const res = await app.request(suggestionUrl, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ state: "applied", appliedInVersion: 2.5 }),
    });
    expect(res.status).toBe(400);
  });

  it("F2 — `insisted` state is NOT settable via the internal route (human-only) → 400", async () => {
    const res = await app.request(suggestionUrl, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ state: "insisted" }),
    });
    expect(res.status).toBe(400);
    expect(sessions.get("real")!.getComment("cmt_s")!.suggestion?.state).toBe("pending");
  });

  it("F2 — `resetAcknowledged` is rejected (strict; agent path never sends it) → 400", async () => {
    const res = await app.request(suggestionUrl, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ state: "countered", counter: { reason: "no" }, resetAcknowledged: true }),
    });
    expect(res.status).toBe(400);
  });

  it("F1-defense — countering an INSISTED suggestion via a raw call → 409, state preserved", async () => {
    // Drive it to insisted directly on the store (as the human route would).
    const store = sessions.get("real")!;
    store.updateCommentSuggestion("cmt_s", { state: "countered", counter: { reason: "no" } });
    store.updateCommentSuggestion("cmt_s", { state: "insisted" });
    const res = await app.request(suggestionUrl, {
      method: "POST", headers: authHeaders, body: JSON.stringify({ state: "countered", counter: { reason: "actually no" } }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("suggestion_insisted_authoritative");
    expect(store.getComment("cmt_s")!.suggestion?.state).toBe("insisted");
  });

  it("a well-formed counter → 200 and persists", async () => {
    const res = await app.request(suggestionUrl, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({ state: "countered", counter: { reason: "null drops the upload", replacementText: "attach cause" } }),
    });
    expect(res.status).toBe(200);
    const s = sessions.get("real")!.getComment("cmt_s")!.suggestion;
    expect(s?.state).toBe("countered");
    expect(s?.counter?.replacementText).toBe("attach cause");
  });
});
