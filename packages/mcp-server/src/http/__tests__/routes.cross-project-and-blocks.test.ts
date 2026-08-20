// Q2 — the two round-12 HIGHs that live on the HTTP surface:
//   1. cross-project publishing is REACHABLE (a toggle the companion UI can
//      drive, not just an interactive `init` prompt the marketplace path never
//      runs), and a stance recorded AFTER enabling really lands in the global
//      ledger;
//   2. a preflight block is DURABLE (persisted server-side and served back), so
//      the moat firing survives a closed browser and a page reload.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getGlobalStore } from "../../store/global-store.js";
import {
  recordPreflightBlock,
  readPreflightBlocks,
  blockEntryFromEvent,
  MAX_BLOCKS,
} from "../../store/preflight-block-log.js";
import {
  createRoutesTestContext,
  destroyRoutesTestContext,
  type RoutesApp,
} from "./routes.harness.js";
import type { FileStore } from "../../store/file-store.js";

let tmpDir: string;
let store: FileStore;
let app: RoutesApp;

beforeEach(() => {
  ({ tmpDir, store, app } = createRoutesTestContext());
});

afterEach(() => {
  destroyRoutesTestContext({ tmpDir, store });
});

function blockEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "preflight_blocked",
    toolName: "present_code_change",
    source: "session",
    match: {
      proposal: "add a global mutable config singleton",
      description: "global mutable state for config",
      concept: "global mutable state for config",
      reason: "it makes every test order-dependent",
      via: "concept",
    },
    ...overrides,
  };
}

describe("Q2 — cross-project publishing is reachable from the companion UI", () => {
  it("defaults OFF and reports it on /api/state (the honest starting state)", async () => {
    const res = await app.request("/api/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.globalLedgerPublish).toBe(false);
  });

  it("POST /api/preferences {globalLedgerPublish:true} round-trips through /api/state AND preferences.json", async () => {
    const res = await app.request("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ globalLedgerPublish: true }),
    });
    expect(res.status).toBe(200);

    const state = await (await app.request("/api/state")).json();
    expect(state.globalLedgerPublish).toBe(true);

    // Persisted, not just in-memory — a daemon restart must not silently
    // un-publish a project the human opted in.
    const prefs = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing", "preferences.json"), "utf-8"),
    );
    expect(prefs.globalLedgerPublish).toBe(true);
  });

  it("turns back OFF (a toggle that can only be switched on is not a toggle)", async () => {
    await app.request("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ globalLedgerPublish: true }),
    });
    await app.request("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ globalLedgerPublish: false }),
    });
    const state = await (await app.request("/api/state")).json();
    expect(state.globalLedgerPublish).toBe(false);
  });

  it("THE POINT: a rejection recorded AFTER enabling lands in the global ledger; one recorded BEFORE does not", async () => {
    // Before — publishing off (the default).
    store.recordRejectedApproach({
      description: "server-side sessions in a cookie",
      concept: "server-side session store",
      reason: "we are stateless by design",
    });
    expect(getGlobalStore().query({ limit: 50 })).toEqual([]);

    // Enable through the same route the UI uses.
    await app.request("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ globalLedgerPublish: true }),
    });

    // After — the stance reaches the cross-project ledger.
    store.recordRejectedApproach({
      description: "add a global mutable config singleton",
      concept: "global mutable state for config",
      reason: "it makes every test order-dependent",
    });
    const entries = getGlobalStore().query({ limit: 50 });
    expect(entries.map((e) => e.concept)).toEqual(["global mutable state for config"]);
    expect(entries[0]?.instances[0]?.verdict).toBe("rejected");
    expect(entries[0]?.instances[0]?.reason).toBe("it makes every test order-dependent");
  });

  it("leaves autonomy + detail untouched when only the publish flag is sent", async () => {
    const before = await (await app.request("/api/state")).json();
    await app.request("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ globalLedgerPublish: true }),
    });
    const after = await (await app.request("/api/state")).json();
    expect(after.autonomyLevel).toBe(before.autonomyLevel);
    expect(after.detailDensity).toBe(before.detailDensity);
  });

  it("rejects a non-boolean with a field-level 400 (nothing written)", async () => {
    const res = await app.request("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ globalLedgerPublish: "yes please" }),
    });
    expect(res.status).toBe(400);
    const state = await (await app.request("/api/state")).json();
    expect(state.globalLedgerPublish).toBe(false);
  });
});

describe("Q2 — a preflight block is durable, not a 12-second toast", () => {
  it("GET /api/preflight-blocks is an empty list before anything fires", async () => {
    const res = await app.request("/api/preflight-blocks");
    expect(res.status).toBe(200);
    expect((await res.json()).blocks).toEqual([]);
  });

  it("THE POINT: a block recorded with NO client attached is visible on a later page load", async () => {
    // No WebSocket, no browser — exactly the situation round 12 found: the
    // agent works, the gate fires, and pre-Q2 the human saw nothing, ever.
    recordPreflightBlock(tmpDir, "session_alpha", blockEvent());

    // ...later, a tab opens and hydrates.
    const body = await (await app.request("/api/preflight-blocks")).json();
    expect(body.blocks).toHaveLength(1);
    const b = body.blocks[0];
    expect(b.concept).toBe("global mutable state for config");
    expect(b.reason).toBe("it makes every test order-dependent");
    expect(b.proposal).toBe("add a global mutable config singleton");
    expect(b.via).toBe("concept");
    expect(b.source).toBe("session");
    expect(b.sessionId).toBe("session_alpha");
    expect(typeof b.at).toBe("string");
    expect(typeof b.id).toBe("string");
  });

  it("keeps blocks across SESSIONS — the log is a project fact, and a closed session's block is the one you most need", async () => {
    recordPreflightBlock(tmpDir, "session_alpha", blockEvent());
    recordPreflightBlock(
      tmpDir,
      "session_beta",
      blockEvent({ match: { concept: "pay-per-request hosting", via: "surface" } }),
    );
    const body = await (await app.request("/api/preflight-blocks")).json();
    expect(body.blocks.map((b: { sessionId: string }) => b.sessionId).sort()).toEqual([
      "session_alpha",
      "session_beta",
    ]);
  });

  it("newest first", async () => {
    recordPreflightBlock(tmpDir, "s", blockEvent({ match: { concept: "first", via: "surface" } }));
    recordPreflightBlock(tmpDir, "s", blockEvent({ match: { concept: "second", via: "surface" } }));
    const body = await (await app.request("/api/preflight-blocks")).json();
    expect(body.blocks[0].concept).toBe("second");
  });

  it("DEMO SESSIONS ARE NEVER PERSISTED — a demo run leaves the project log byte-identical", () => {
    recordPreflightBlock(tmpDir, "demo_1700000000000", blockEvent());
    expect(readPreflightBlocks(tmpDir)).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, ".deeppairing", "preflight-blocks.json"))).toBe(false);
  });

  it("caps the log so it stays a 'did the moat fire' record, not an audit trail", () => {
    for (let i = 0; i < MAX_BLOCKS + 7; i++) {
      recordPreflightBlock(tmpDir, "s", blockEvent({ match: { concept: `c${i}`, via: "surface" } }));
    }
    const blocks = readPreflightBlocks(tmpDir);
    expect(blocks).toHaveLength(MAX_BLOCKS);
    expect(blocks[0]?.concept).toBe(`c${MAX_BLOCKS + 6}`);
  });

  it("ignores non-block events and unnameable blocks (the tap sees every broadcast)", () => {
    expect(blockEntryFromEvent("s", { type: "artifact_created" })).toBeNull();
    expect(blockEntryFromEvent("s", { type: "preflight_blocked", match: {} })).toBeNull();
    recordPreflightBlock(tmpDir, "s", { type: "comment_added" });
    expect(readPreflightBlocks(tmpDir)).toEqual([]);
  });

  it("falls back to `description` when no `concept` was named, and normalizes an unknown `via`", () => {
    const entry = blockEntryFromEvent("s", {
      type: "preflight_blocked",
      match: { description: "electron wrapper", via: "telepathy" },
    });
    expect(entry?.concept).toBe("electron wrapper");
    expect(entry?.via).toBe("surface");
  });

  it("degrades to an empty list on a corrupt log rather than breaking the page load", async () => {
    fs.mkdirSync(path.join(tmpDir, ".deeppairing"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".deeppairing", "preflight-blocks.json"), "{ not json", "utf-8");
    expect(readPreflightBlocks(tmpDir)).toEqual([]);
    const res = await app.request("/api/preflight-blocks");
    expect(res.status).toBe(200);
    expect((await res.json()).blocks).toEqual([]);
  });
});
