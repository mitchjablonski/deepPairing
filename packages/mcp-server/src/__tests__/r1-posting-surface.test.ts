/**
 * R1 (#279) — the posting-surface fixes that don't live in the authorization
 * gate itself. The gate's own branches are pinned next door in
 * github/__tests__/review-authorization.test.ts.
 *
 * Covered here:
 *   fix 4  — `audience` survives the coercion boundary, and absent means postable
 *   fix 5  — the outbound body carries no session id (the payload builder's own
 *            scrub, tested through buildGitHubReviewPayload)
 *   fix 6  — the posted-review record: written, reloaded, matched by PR
 *   fix 6b — the un-arm exit on revise_artifact, and its boundary
 *   fix 8  — the external changeset runs the preflight ADVISORY, not skipped
 *   fix 9  — an 85 KB changeset lands; everything else keeps the 64 KiB cap
 *   riders — the CLI + hook project-root env chain
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coerceResearchContent, isPostableFinding } from "@deeppairing/shared";
import { FileStore } from "../store/file-store.js";
import { readPostedReviews, samePrTarget, type PostedReviewRecord } from "../store/posted-reviews.js";
import { isArtifactCreateRoute, ARTIFACT_CREATE_MAX_BODY_BYTES } from "../http/guards.js";
import { buildGitHubReviewPayload } from "../export/format-markdown.js";
import { createDaemon } from "../daemon/create-daemon.js";
import { handleReviseArtifact } from "../mcp/tools/revise-artifact.js";
import { handlePresentChangeset } from "../mcp/tools/present-changeset.js";
import { projectHashOf } from "../project-root.js";
import { withGlobalStore, type GlobalStoreFixture } from "./global-store-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..");

let fx: GlobalStoreFixture;
beforeEach(() => { fx = withGlobalStore("dp-r1-"); });
afterEach(() => { fx.dispose(); });

// --- fix 4: the audience field survives every boundary ----------------------

describe("R1 fix 4 — `audience` survives coercion (a dropped field is the leak reopening)", () => {
  it("keeps audience: 'internal' through coerceResearchContent", () => {
    const out = coerceResearchContent({
      summary: "s",
      findings: [{ category: "c", detail: "d", significance: "high", audience: "internal" }],
    });
    expect(out.findings[0]!.audience).toBe("internal");
    expect(isPostableFinding(out.findings[0]!)).toBe(false);
  });

  it("a finding with NO audience coerces unchanged and is postable (back-compat)", () => {
    const out = coerceResearchContent({
      summary: "s",
      findings: [{ category: "c", detail: "d", significance: "high" }],
    });
    expect(out.findings[0]).not.toHaveProperty("audience");
    expect(isPostableFinding(out.findings[0]!)).toBe(true);
  });

  it("a junk audience value degrades to postable, never to a third meaning", () => {
    const out = coerceResearchContent({
      summary: "s",
      findings: [{ category: "c", detail: "d", significance: "high", audience: "shout-it" }],
    });
    expect(out.findings[0]).not.toHaveProperty("audience");
    expect(isPostableFinding(out.findings[0]!)).toBe(true);
  });

  it("it round-trips through a real store (write → reload → still internal)", () => {
    const store = fx.track(new FileStore(fx.dir, "s_audience"));
    store.createArtifact({
      id: "art_1", type: "research", title: "Ledger sweep",
      content: {
        summary: "s",
        findings: [{ category: "Stance", detail: "you rejected this", significance: "high", audience: "internal" }],
      },
    });
    store.forceFlush?.();
    const reloaded = fx.track(new FileStore(fx.dir, "s_audience")).getArtifacts()[0]!;
    expect(coerceResearchContent(reloaded.content).findings[0]!.audience).toBe("internal");
  });
});

// --- fix 5: the outbound body names no session ------------------------------

describe("R1 fix 5 — buildGitHubReviewPayload publishes no session id", () => {
  const state = (sessionId: string) => ({
    sessionId,
    artifacts: [{
      id: "art_1", sessionId, type: "research", version: 1, parentId: null, title: "Notes", status: "approved",
      content: {
        summary: "s",
        findings: [{
          category: "c", title: "A real finding", detail: "d", significance: "high",
          evidence: [{ filePath: "src/a.ts", lineStart: 1, lineEnd: 2, snippet: "x", explanation: "y" }],
        }],
      },
      agentReasoning: null, createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-20T10:00:00.000Z",
    }],
    comments: [], decisions: [], planReviews: [],
  }) as never;

  it("no session_, no folder name, in the body of any event", () => {
    for (const event of ["COMMENT", "REQUEST_CHANGES", "APPROVE"] as const) {
      const payload = buildGitHubReviewPayload(state("session_acme-internal-tools_9f2c1a"), { event });
      expect(payload.body).not.toContain("session_");
      expect(payload.body).not.toContain("acme-internal-tools");
      expect(payload.body).not.toContain("9f2c1a");
    }
  });

  it("a session that DOES have a real title still uses it (the scrub is targeted)", () => {
    const withDecision = {
      ...(state("session_x_1") as unknown as Record<string, unknown>),
      decisions: [{ decisionId: "d1", title: "Rate limiting approach", context: "c", options: [], resolved: true }],
    } as never;
    const payload = buildGitHubReviewPayload(withDecision, { event: "COMMENT" });
    expect(payload.body).toContain("Rate limiting approach");
  });
});

// --- fix 6: the posted-review record ---------------------------------------

describe("R1 fix 6 — a landed review is recorded, reloaded, and matched", () => {
  const record = (over: Partial<PostedReviewRecord> = {}): PostedReviewRecord => ({
    pr: "42", prNumber: 42, event: "COMMENT", reviewId: 7,
    url: "https://github.com/acme/widgets/pull/42#pullrequestreview-7",
    postedAt: "2026-08-21T09:00:00.000Z", commentCount: 3, ...over,
  });

  it("recordPostedReview persists immediately and rides getFullState", () => {
    const store = fx.track(new FileStore(fx.dir, "s_posted"));
    expect((store.getFullState() as { postedReviews?: unknown[] }).postedReviews).toBeUndefined();

    store.recordPostedReview(record());

    // On disk before the tool returns — no debounced flush in between, because a
    // crash there would re-arm a duplicate post.
    expect(readPostedReviews(fx.dir, "s_posted")).toHaveLength(1);
    expect((store.getFullState() as { postedReviews?: unknown[] }).postedReviews).toHaveLength(1);
    // And a fresh store over the same dir (a daemon restart) sees it.
    expect((fx.track(new FileStore(fx.dir, "s_posted")).getFullState() as { postedReviews?: unknown[] }).postedReviews)
      .toHaveLength(1);
  });

  it("a session that never posted keeps a byte-identical full state", () => {
    const store = fx.track(new FileStore(fx.dir, "s_clean"));
    expect(Object.keys(store.getFullState())).not.toContain("postedReviews");
  });

  it("samePrTarget matches by number across ref shapes, and never across repos", () => {
    const bare = record();
    expect(samePrTarget(bare, "42")).toBe(true);
    expect(samePrTarget(bare, "#42")).toBe(true);
    expect(samePrTarget(bare, "https://github.com/acme/widgets/pull/42")).toBe(true);
    expect(samePrTarget(bare, "43")).toBe(false);
    expect(samePrTarget(bare, "not-a-pr")).toBe(false);

    const owned = record({ owner: "acme", repo: "widgets" });
    expect(samePrTarget(owned, "https://github.com/acme/widgets/pull/42")).toBe(true);
    // Same number, different repo — a genuinely different PR.
    expect(samePrTarget(owned, "https://github.com/other/thing/pull/42")).toBe(false);
  });
});

// --- fix 6b: the un-arm exit ------------------------------------------------

describe("R1 fix 6b — un-arming an APPROVED findings artifact", () => {
  function ctxFor(store: FileStore) {
    return {
      store, server: null, broadcast: () => {}, port: 0,
      helpers: { getPassiveFeedback: async () => "" },
      state: {},
    } as never;
  }

  function seed(sessionId: string, opts: { external: boolean }) {
    const store = fx.track(new FileStore(fx.dir, sessionId));
    store.createArtifact({
      id: "art_f", type: "research", title: "Review",
      content: { summary: "s", findings: [{ category: "c", detail: "d", significance: "high" }] },
    });
    store.createArtifact({
      id: "art_cs", type: "changeset", title: "PR #7",
      content: { files: [], ...(opts.external ? { reviewIntent: "external" } : {}) },
    });
    store.updateArtifactStatus("art_f", "approved", "ui_approve_button");
    return store;
  }

  it("ALLOWS retract on an approved findings artifact in an external-review session", async () => {
    const store = seed("s_unarm_ext", { external: true });
    const res = await handleReviseArtifact(ctxFor(store), {
      artifactId: "art_f", mode: "retract", reason: "on reflection, don't send this one",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("Un-armed");
    expect(store.getArtifacts().find((a) => a.id === "art_f")!.status).toBe("retracted");
  });

  it("REFUSES the same retract in a LOCAL session — approved still means approved", async () => {
    const store = seed("s_unarm_local", { external: false });
    const res = await handleReviseArtifact(ctxFor(store), {
      artifactId: "art_f", mode: "retract", reason: "changed my mind",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("too late to retract");
    expect(store.getArtifacts().find((a) => a.id === "art_f")!.status).toBe("approved");
  });

  it("REFUSES obsolete on an approved artifact even in an external session (retract only)", async () => {
    const store = seed("s_unarm_obs", { external: true });
    const res = await handleReviseArtifact(ctxFor(store), {
      artifactId: "art_f", mode: "obsolete", reason: "moved on",
    });
    expect(res.isError).toBe(true);
  });

  it("REFUSES retract on an approved CHANGESET — that verdict is the APPROVE authorization", async () => {
    const store = seed("s_unarm_cs", { external: true });
    store.updateArtifactStatus("art_cs", "approved", "ui_approve_button");
    const res = await handleReviseArtifact(ctxFor(store), {
      artifactId: "art_cs", mode: "retract", reason: "nope",
    });
    expect(res.isError).toBe(true);
    expect(store.getArtifacts().find((a) => a.id === "art_cs")!.status).toBe("approved");
  });

  it("REFUSES retract on a REJECTED artifact — the exit is one door, not a general reopen", async () => {
    const store = seed("s_unarm_rej", { external: true });
    store.createArtifact({ id: "art_r", type: "research", title: "R", content: { summary: "s", findings: [] } });
    store.updateArtifactStatus("art_r", "rejected", "ui_reject_button");
    const res = await handleReviseArtifact(ctxFor(store), {
      artifactId: "art_r", mode: "retract", reason: "x",
    });
    expect(res.isError).toBe(true);
  });
});

// --- fix 8: the external changeset is weighed, not exempted ------------------

describe("R1 fix 8 — an external changeset runs the preflight ADVISORY", () => {
  function ctx(store: FileStore, calls: unknown[][]) {
    return {
      store, server: null, broadcast: () => {}, port: 0,
      helpers: {
        preflightRejectedApproaches: async (...args: unknown[]) => {
          calls.push(args);
          const advisory = (args[4] as { advisory?: boolean } | undefined)?.advisory;
          // A fake matcher that always "fires": in advisory mode it must come
          // back OK-with-advice; otherwise it blocks.
          return advisory
            ? { ok: true, trace: { consideredCount: 1, nearMisses: [] }, advisory: "REJECTED_APPROACH_BLOCKED: you rejected \"token bucket\"" }
            : { ok: false, trace: { consideredCount: 1, nearMisses: [] }, response: { content: [{ type: "text", text: "blocked" }], isError: true } };
        },
        beginPresentIdempotency: async () => ({ commit: () => {}, abort: () => {} }),
        autoNameSession: async () => {},
        getPassiveFeedback: async () => "",
      },
      state: {},
    } as never;
  }

  const files = [{ path: "src/limiter.ts", changeType: "modified" as const, hunks: [] }];

  it("EXTERNAL: the matcher runs, the tool succeeds, and the advisory is handed back", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_ext"));
    const calls: unknown[][] = [];
    const res = await handlePresentChangeset(ctx(store, calls), {
      title: "PR #7 — token bucket", files, reviewIntent: "external",
      source: { kind: "github-pr", number: 7 },
    });
    // It RAN (round 13's finding was that it didn't) …
    expect(calls).toHaveLength(1);
    expect((calls[0]![4] as { advisory?: boolean }).advisory).toBe(true);
    // … it did not refuse …
    expect(res.isError).toBeFalsy();
    // … and it told the agent what to do with the match.
    expect(res.content[0]!.text).toContain("advisory");
    expect(res.content[0]!.text).toContain("token bucket");
    expect(res.content[0]!.text).toContain('audience: "internal"');
  });

  it("LOCAL: the same match still BLOCKS — the human's gate on their own work is untouched", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_local"));
    const calls: unknown[][] = [];
    const res = await handlePresentChangeset(ctx(store, calls), { title: "token bucket", files });
    expect(calls).toHaveLength(1);
    expect((calls[0]![4] as { advisory?: boolean } | undefined)?.advisory).toBe(false);
    expect(res.isError).toBe(true);
  });

  it("the source provenance is carried on the artifact for the UI/export to render", async () => {
    const store = fx.track(new FileStore(fx.dir, "s_prov"));
    await handlePresentChangeset(ctx(store, []), {
      title: "PR #7", files, reviewIntent: "external",
      source: { kind: "github-pr", number: 7, url: "https://github.com/acme/widgets/pull/7", author: "priya" },
    });
    const content = store.getArtifacts()[0]!.content as { source?: { kind?: string; number?: number; author?: string } };
    expect(content.source).toMatchObject({ kind: "github-pr", number: 7, author: "priya" });
  });
});

// --- fix 9: the payload ceiling --------------------------------------------

describe("R1 fix 9 — a real PR's diff fits, and nothing else got a bigger allowance", () => {
  it("isArtifactCreateRoute matches the create route ONLY", () => {
    expect(isArtifactCreateRoute("POST", "/api/internal/sessions/s1/artifacts")).toBe(true);
    expect(isArtifactCreateRoute("GET", "/api/internal/sessions/s1/artifacts")).toBe(false);
    for (const p of [
      "/api/internal/sessions/s1/artifacts/a1/status",
      "/api/internal/sessions/s1/artifacts/status-changes/acknowledge",
      "/api/internal/sessions/s1/comments",
      "/api/evict",
      "/api/demo/run",
    ]) {
      expect(isArtifactCreateRoute("POST", p), p).toBe(false);
    }
  });

  it("an 85 KB changeset LANDS (round 13's 10-file PR that could not be presented)", async () => {
    const fixture = withGlobalStore("dp-r1-cap-");
    try {
      const daemon = createDaemon({
        projectRoot: fixture.dir, authToken: "test-token", log: () => {},
        exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
      });
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        "X-Project-Hash": projectHashOf(fixture.dir),
      };
      await daemon.app.request("/api/internal/sessions/big/register", { method: "POST", headers, body: "{}" });

      const hunkLines = Array.from({ length: 600 }, (_, i) => ({ kind: "add", content: `const line${i} = compute(${i});` }));
      const body = JSON.stringify({
        id: "art_big", type: "changeset", title: "PR #77 — ten files",
        content: {
          files: Array.from({ length: 10 }, (_, f) => ({ path: `src/mod${f}.ts`, changeType: "modified", hunks: [{ header: "@@", lines: hunkLines }] })),
          reviewIntent: "external",
        },
      });
      expect(body.length).toBeGreaterThan(85 * 1024);
      expect(body.length).toBeLessThan(ARTIFACT_CREATE_MAX_BODY_BYTES);

      const res = await daemon.app.request("/api/internal/sessions/big/artifacts", { method: "POST", headers, body });
      expect(res.status).toBe(200);
      expect(daemon.sessions.get("big")!.getArtifacts()).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it("the 64 KiB cap still holds on a NON-create route", async () => {
    const fixture = withGlobalStore("dp-r1-cap2-");
    try {
      const daemon = createDaemon({
        projectRoot: fixture.dir, authToken: "test-token", log: () => {},
        exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
      });
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        "X-Project-Hash": projectHashOf(fixture.dir),
      };
      await daemon.app.request("/api/internal/sessions/big2/register", { method: "POST", headers, body: "{}" });
      const res = await daemon.app.request("/api/internal/sessions/big2/comments", {
        method: "POST", headers,
        body: JSON.stringify({ id: "c1", artifactId: "a1", author: "human", content: "x".repeat(70 * 1024) }),
      });
      expect(res.status).toBe(413);
    } finally {
      fixture.dispose();
    }
  });

  it("even the create route is bounded — past 512 KiB it 413s with an honest message", async () => {
    const fixture = withGlobalStore("dp-r1-cap3-");
    try {
      const daemon = createDaemon({
        projectRoot: fixture.dir, authToken: "test-token", log: () => {},
        exitProcess: () => {}, releaseListenSocket: () => {}, env: {},
      });
      const headers = {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
        "X-Project-Hash": projectHashOf(fixture.dir),
      };
      await daemon.app.request("/api/internal/sessions/huge/register", { method: "POST", headers, body: "{}" });
      const res = await daemon.app.request("/api/internal/sessions/huge/artifacts", {
        method: "POST", headers,
        body: JSON.stringify({ id: "a", type: "changeset", title: "t", content: { blob: "x".repeat(ARTIFACT_CREATE_MAX_BODY_BYTES) } }),
      });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toContain("split it by area");
    } finally {
      fixture.dispose();
    }
  });
});

// --- riders: one project-root contract, honoured everywhere ------------------

describe("R1 riders — the documented project-root env chain", () => {
  it("cli/init.ts resolves its root through resolveProjectRoot, not a bare cwd", () => {
    const init = fs.readFileSync(path.join(srcDir, "cli", "init.ts"), "utf-8");
    expect(init).toContain("const cwd = resolveProjectRoot().projectRoot;");
    // The exact pre-R1 line that ignored both env vars.
    expect(init).not.toContain("const cwd = process.cwd();");
  });

  it("both stop-hook twins honour CLAUDE_PROJECT_DIR then DEEPPAIRING_PROJECT_ROOT", () => {
    const bundleEntry = fs.readFileSync(path.join(srcDir, "cli", "stop-hook-entry.ts"), "utf-8");
    const initGenerated = fs.readFileSync(path.join(srcDir, "cli", "setup-tasks.ts"), "utf-8");
    const CHAIN = "process.env.CLAUDE_PROJECT_DIR || process.env.DEEPPAIRING_PROJECT_ROOT || process.cwd()";
    expect(bundleEntry).toContain(CHAIN);
    // The init-generated script is a hand-maintained twin; it must not drift.
    expect(initGenerated).toContain(CHAIN);
    expect(initGenerated).not.toContain("process.env.CLAUDE_PROJECT_DIR || process.cwd()");
  });

  it("both preflight twins carry the same chain ahead of the event cwd", () => {
    const entry = fs.readFileSync(path.join(srcDir, "cli", "preflight-hook-entry.ts"), "utf-8");
    const generated = fs.readFileSync(path.join(srcDir, "cli", "setup-tasks.ts"), "utf-8");
    const CHAIN = "process.env.CLAUDE_PROJECT_DIR || process.env.DEEPPAIRING_PROJECT_ROOT || ev.cwd || process.cwd()";
    expect(entry).toContain(CHAIN);
    expect(generated).toContain(CHAIN);
  });
});
