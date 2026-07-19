/**
 * #169 — decision rejection arms the gate, WITHOUT over-blocking (F1/F2/F3).
 *
 * Two distinct gestures, two semantics:
 *  - WHOLE-CARD hard reject (status:"rejected" + reason): the human rejects the
 *    FRAMING ("wrong question"). Records ONE entry keyed on the QUESTION — so a
 *    re-proposal of the same framing blocks, but an unrelated edit mentioning an
 *    option's noun (a Redis job queue) sails through. Honors the human-named
 *    concept (F3).
 *  - "↻ None of these fit" send-back (a decision_revision_requested comment):
 *    rejects each LISTED option, keyed on the option CONCEPT ONLY — so
 *    re-proposing an option surfaces, while a fresh option set for the SAME
 *    question is admitted (the gesture asked for more options).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpRoutes } from "../routes.js";
import { FileStore } from "../../store/file-store.js";
import { setGlobalStoreForTests } from "../../store/global-store.js";
import { projectHashOf } from "../../project-root.js";
import { runPreflight } from "../../mcp/preflight-validator.js";
import type { DecisionOption } from "@deeppairing/shared";

// __tests__ → http → src → mcp-server → packages → repo root
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const preflightBundle = path.join(repoRoot, "claude-plugin", "server", "preflight.mjs");
const bundleBuilt = fs.existsSync(preflightBundle);

let tmpDir: string;
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: any[];

const CONTEXT = "Which cache backend should we use?";
function opt(over: Partial<DecisionOption>): DecisionOption {
  return {
    id: "o", title: "T", description: "d", pros: [], cons: [],
    effort: "low", risk: "low", recommendation: false, ...over,
  };
}
const OPTIONS: DecisionOption[] = [
  opt({ id: "o_redis", title: "Redis", description: "network cache server", concept: { name: "redis for caching" }, recommendation: true }),
  opt({ id: "o_mc", title: "Memcached", description: "simple distributed cache", concept: { name: "memcached for caching" } }),
  opt({ id: "o_lru", title: "In-process LRU", description: "in-process eviction map", concept: { name: "in-process lru cache" } }),
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-dec-reject-"));
  setGlobalStoreForTests(path.join(tmpDir, "philosophy.json"));
  store = new FileStore(tmpDir, "test_session");
  broadcasts = [];
  const bare = createHttpRoutes(store, tmpDir, (e) => broadcasts.push(e));
  const projectHash = projectHashOf(tmpDir);
  const orig = bare.request.bind(bare);
  (bare as any).request = (url: any, init?: any) => {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("X-Project-Hash")) headers.set("X-Project-Hash", projectHash);
    return orig(url, { ...(init || {}), headers });
  };
  app = bare;
});

afterEach(() => {
  store.forceFlush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setGlobalStoreForTests(null);
});

async function createDecisionArtifact(): Promise<string> {
  const art = await store.createArtifact({
    id: "art_dec1",
    type: "decision",
    title: CONTEXT,
    content: { context: CONTEXT, options: OPTIONS, decisionId: "dec1" },
  } as any);
  return art.id;
}

function reject(artifactId: string, feedback: string, concept?: string) {
  return app.request(`/api/artifacts/${artifactId}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "rejected", feedback, ...(concept ? { concept } : {}) }),
  });
}

function sendBack(artifactId: string, content: string) {
  return app.request(`/api/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artifactId,
      content,
      target: { artifactId, sectionId: "decision_revision_requested" },
      intent: "question",
    }),
  });
}

const runHook = (stdin: string) =>
  execFileSync("node", [preflightBundle], {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
  });

const preflight = (proposalStrings: string[], proposalConcepts: string[] = []) =>
  runPreflight({
    toolName: "present_options",
    proposalStrings,
    proposalConcepts,
    rejectedApproaches: store.getSessionMemory().rejectedApproaches,
    teamPreferences: [],
  });

describe("#169 whole-card reject → ONE framing entry (F1/F3)", () => {
  it("records exactly ONE entry, keyed on the question (NOT one per option)", async () => {
    const id = await createDecisionArtifact();
    const res = await reject(id, "wrong question — we don't need a cache at all here");
    expect(res.status).toBe(200);

    const rejected = store.getSessionMemory().rejectedApproaches;
    expect(rejected).toHaveLength(1);
    expect(rejected[0].description).toBe(CONTEXT);
    expect(rejected[0].concept).toBe(CONTEXT); // no human concept → falls back to the question
    expect(rejected[0].reason).toContain("wrong question");
    // Explicitly NOT the per-option keys that over-block.
    expect(rejected.map((r) => r.description)).not.toContain(`${CONTEXT}: Redis`);
  });

  it("F3 — honors the human-named concept as the ledger key", async () => {
    const id = await createDecisionArtifact();
    await reject(id, "premature — measure first", "premature caching");
    const rejected = store.getSessionMemory().rejectedApproaches;
    expect(rejected).toHaveLength(1);
    expect(rejected[0].concept).toBe("premature caching");
    expect(rejected[0].description).toBe(CONTEXT);
  });

  it("broadcasts exactly ONE ledger_write", async () => {
    const id = await createDecisionArtifact();
    await reject(id, "wrong question");
    const writes = broadcasts.filter((b) => b.type === "ledger_write" && b.kind === "rejected");
    expect(writes).toHaveLength(1);
    expect(writes[0].concept).toBe(CONTEXT);
  });

  it("(F1 repro, b) present_options for a DIFFERENT question is admitted", async () => {
    const id = await createDecisionArtifact();
    await reject(id, "wrong question — we don't need a cache at all here");
    // A pub/sub decision whose recommended option is Redis Streams — pre-fix the
    // per-option "…: Redis" noun blocked this; the framing key does not.
    const r = preflight(
      ["Which pub/sub broker should we use?", "Redis Streams", "durable log-based pub/sub", "NATS"],
      ["redis streams for pubsub", "nats messaging"],
    );
    expect(r.blocked).toBe(false);
  });

  it("still blocks a re-proposal that IS the rejected framing", async () => {
    const id = await createDecisionArtifact();
    await reject(id, "wrong question — we don't need a cache at all here");
    const r = preflight([CONTEXT, "Redis", "network cache server"], ["redis for caching"]);
    expect(r.blocked).toBe(true);
  });

  it("a PICKED/approved decision records nothing here", async () => {
    const id = await createDecisionArtifact();
    const res = await app.request(`/api/artifacts/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(200);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
  });

  it.skipIf(!bundleBuilt)("(F1 repro, a) a Redis job-queue Edit is ADMITTED by the bundled hook", async () => {
    const id = await createDecisionArtifact();
    await reject(id, "wrong question — we don't need a cache at all here");
    const out = runHook(JSON.stringify({
      tool_name: "Edit",
      tool_input: {
        file_path: "/src/jobs.ts",
        new_string: 'import Redis from "ioredis";\nexport const jobQueue = new Redis(process.env.REDIS_URL); // background job queue',
      },
    }));
    expect(out.trim()).toBe(""); // admitted — not a caching decision
  });

  it.skipIf(!bundleBuilt)("(F1 guard, c) an Edit re-implementing the NAMED rejected concept is paused (ask)", async () => {
    // The genuine-reframe-still-blocks guard. A raw question makes a poor
    // concept key (function words like "which"/"should" survive tokenization and
    // over-constrain the all-tokens-must-match concept lane), so the strong,
    // Edit-catching block comes from the human NAMING the pattern — which the
    // hard-reject UI captures. Here they name "cache backend"; a later edit that
    // implements it is paused.
    const id = await createDecisionArtifact();
    await reject(id, "we don't need this at all here", "cache backend");
    const out = runHook(JSON.stringify({
      tool_name: "Edit",
      tool_input: {
        file_path: "/src/cache.ts",
        new_string: "// implement the cache backend here using an in-memory map",
      },
    }));
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
  });
});

describe("#169 'None of these fit' send-back → per-option concept entries (F2)", () => {
  it("records each LISTED option, keyed on its concept (reason = send-back text)", async () => {
    const id = await createDecisionArtifact();
    const res = await sendBack(id, "all three are network caches — what about no cache, or a CDN?");
    expect(res.status).toBe(200);
    const concepts = store.getSessionMemory().rejectedApproaches.map((r) => r.concept).sort();
    expect(concepts).toEqual(["in-process lru cache", "memcached for caching", "redis for caching"]);
    const redis = store.getSessionMemory().rejectedApproaches.find((r) => r.concept === "redis for caching");
    expect(redis?.reason).toContain("network caches");
    // Deliberately NOT context-prefixed (that would block the retry — see below).
    expect(store.getSessionMemory().rejectedApproaches.map((r) => r.description)).not.toContain(`${CONTEXT}: Redis`);
  });

  it("admits a follow-up present_options for the SAME question with NEW options", async () => {
    const id = await createDecisionArtifact();
    await sendBack(id, "none of these fit — try an edge/CDN angle");
    const r = preflight(
      [CONTEXT, "Cloudflare Workers KV", "edge key-value store", "Fastly compute cache"],
      ["edge kv store", "cdn edge cache"],
    );
    expect(r.blocked).toBe(false);
  });

  it("surfaces a re-proposal of one of the rejected options", async () => {
    const id = await createDecisionArtifact();
    await sendBack(id, "none of these fit");
    const r = preflight([CONTEXT, "Redis", "network cache server"], ["redis for caching"]);
    expect(r.blocked).toBe(true);
  });

  it("does nothing for a plain (non-send-back) comment", async () => {
    const id = await createDecisionArtifact();
    const res = await app.request(`/api/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: id, content: "nice options", target: { artifactId: id }, intent: "comment" }),
    });
    expect(res.status).toBe(200);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
  });
});
