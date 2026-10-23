/**
 * #569 pilot task A (#553/#572) — the lead-side worker-stop reader and its
 * per-session delivered-ids store. Fakes, not mocks: entries come from the
 * REAL hook-gate writer (`recordHookGateBlock`) into a real tmp project, and
 * the delivered ids live in a real session dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  workerStopsFor,
  readDeliveredWorkerStops,
  markWorkerStopsDelivered,
  formatWorkerStops,
  MAX_SEEN_WORKER_STOPS,
} from "../worker-stop-notices.js";
import {
  hookGateEntryFromFire,
  recordHookGateBlock,
  readPreflightBlocks,
  MAX_BLOCKS,
  type HookGateFireLike,
  type PreflightBlockEntry,
} from "../preflight-block-log.js";
import { FileStore } from "../file-store.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

const CANARY = "FAKE-CANARY-569A";
/** Claude session ids (the hook's `session_id`) → dp session ids. */
const SESSIONS: Record<string, string> = { "claude-aaa": "s_a", "claude-bbb": "s_b" };
const resolve = (cs: string) => SESSIONS[cs];

function fire(n: number, o: { session?: string; agentId?: string | null; decision?: "ask" | "deny" } = {}): HookGateFireLike {
  return {
    id: `fire${n}`,
    at: new Date(Date.UTC(2026, 9, 22, 12, 0, n)).toISOString(),
    hook: "preflight",
    gate: {
      decision: o.decision ?? "deny",
      source: "session",
      concept: `global mutable singleton ${CANARY}`,
      tool: "Write",
      target: `notes-${n}.txt`,
      session: o.session ?? "claude-aaa",
      ...(o.agentId === null ? {} : { agentId: o.agentId ?? `agent-${n}`, agentType: "general-purpose" }),
    },
  };
}

function entry(n: number, o: Parameters<typeof fire>[1] = {}): PreflightBlockEntry {
  return hookGateEntryFromFire(fire(n, o), resolve)!;
}

describe("workerStopsFor (pure)", () => {
  it("keeps only this session's hook-lane worker entries, oldest first", () => {
    const entries = [
      entry(4), // s_a worker
      entry(3, { session: "claude-bbb" }), // s_b worker
      entry(2, { agentId: null }), // s_a lead's own edit
      entry(1, { decision: "ask" }), // s_a worker, ask
    ]; // the log is newest first
    const stops = workerStopsFor(entries, "s_a", []);
    expect(stops.map((s) => s.id)).toEqual(["blk_fire1", "blk_fire4"]);
    expect(stops[0]).toEqual({
      id: "blk_fire1",
      agentType: "general-purpose",
      targetPath: "notes-1.txt",
      concept: `global mutable singleton ${CANARY}`,
      decision: "ask",
      at: "2026-10-22T12:00:01.000Z",
    });
    expect(stops[1]!.decision).toBe("deny");
    expect(workerStopsFor(entries, "s_b", []).map((s) => s.id)).toEqual(["blk_fire3"]);
  });

  it("never matches an unresolved \"hook\" entry to any session", () => {
    const unresolved = entry(5, { session: "claude-unknown" });
    expect(unresolved.sessionId).toBe("hook");
    expect(workerStopsFor([unresolved], "s_a", [])).toEqual([]);
    expect(workerStopsFor([unresolved], "s_b", [])).toEqual([]);
    expect(workerStopsFor([unresolved], "hook", [])).toEqual([]);
    expect(workerStopsFor([unresolved], "", [])).toEqual([]);
  });

  it("ignores present_* gate entries (no hook lane) even with a matching session", () => {
    const presentGate = { ...entry(6), lane: undefined, agentId: "agent-6" } as PreflightBlockEntry;
    expect(workerStopsFor([presentGate], "s_a", [])).toEqual([]);
  });

  it("excludes seen ids", () => {
    const entries = [entry(2), entry(1)];
    expect(workerStopsFor(entries, "s_a", ["blk_fire1"]).map((s) => s.id)).toEqual(["blk_fire2"]);
    expect(workerStopsFor(entries, "s_a", new Set(["blk_fire1", "blk_fire2"]))).toEqual([]);
  });
});

describe("delivered-ids store", () => {
  let fx: GlobalStoreFixture;
  let dir: string;
  beforeEach(() => {
    fx = withGlobalStore("dp-wsn-");
    dir = path.join(fx.dir, ".deeppairing", "sessions", "s_a");
  });
  afterEach(() => fx.dispose());

  it("starts empty, writes nothing for an empty list, and round-trips ids", () => {
    expect(readDeliveredWorkerStops(dir)).toEqual([]);
    markWorkerStopsDelivered(dir, []);
    expect(fs.existsSync(path.join(dir, "worker-stops-delivered.json"))).toBe(false);
    markWorkerStopsDelivered(dir, ["blk_a", "blk_b"]);
    markWorkerStopsDelivered(dir, ["blk_b", "blk_c"]);
    expect(readDeliveredWorkerStops(dir)).toEqual(["blk_a", "blk_b", "blk_c"]);
    // Atomic write: no temp file is left beside it.
    expect(fs.readdirSync(dir)).toEqual(["worker-stops-delivered.json"]);
  });

  it("caps at MAX_SEEN_WORKER_STOPS, keeping the newest, and the cap covers the log's", () => {
    expect(MAX_SEEN_WORKER_STOPS).toBeGreaterThanOrEqual(MAX_BLOCKS);
    const ids = Array.from({ length: MAX_SEEN_WORKER_STOPS + 25 }, (_, i) => `blk_${i}`);
    markWorkerStopsDelivered(dir, ids.slice(0, 60));
    markWorkerStopsDelivered(dir, ids.slice(60));
    const seen = readDeliveredWorkerStops(dir);
    expect(seen).toHaveLength(MAX_SEEN_WORKER_STOPS);
    expect(seen[0]).toBe("blk_25");
    expect(seen[seen.length - 1]).toBe(ids[ids.length - 1]);
  });

  it("degrades a corrupt or wrong-shaped file to empty (a repeat, never a crash)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "worker-stops-delivered.json"), "{not json");
    expect(readDeliveredWorkerStops(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, "worker-stops-delivered.json"), JSON.stringify({ version: 2, ids: ["x"] }));
    expect(readDeliveredWorkerStops(dir)).toEqual([]);
  });
});

describe("FileStore worker-stop lane", () => {
  let fx: GlobalStoreFixture;
  beforeEach(() => {
    fx = withGlobalStore("dp-wsn-fs-");
  });
  afterEach(() => fx.dispose());

  it("delivers a session's stops once, and the seen set survives a restart", () => {
    const root = fx.dir;
    expect(recordHookGateBlock(root, fire(1), resolve)).not.toBeNull();
    expect(recordHookGateBlock(root, fire(2, { session: "claude-bbb" }), resolve)).not.toBeNull();
    expect(readPreflightBlocks(root)).toHaveLength(2);

    const a = fx.track(new FileStore(root, "s_a"));
    expect(a.getUndeliveredWorkerStops().map((s) => s.id)).toEqual(["blk_fire1"]);
    a.markWorkerStopsDelivered(["blk_fire1"]);
    expect(a.getUndeliveredWorkerStops()).toEqual([]);

    // Restart: a fresh store for the same session still has it as delivered.
    const a2 = fx.track(new FileStore(root, "s_a"));
    expect(a2.getUndeliveredWorkerStops()).toEqual([]);
    // A new stop after the restart is delivered.
    recordHookGateBlock(root, fire(3), resolve);
    expect(a2.getUndeliveredWorkerStops().map((s) => s.id)).toEqual(["blk_fire3"]);

    // Session B is untouched by A's deliveries.
    const b = fx.track(new FileStore(root, "s_b"));
    expect(b.getUndeliveredWorkerStops().map((s) => s.id)).toEqual(["blk_fire2"]);
  });

  it("returns nothing for a demo session and never writes its delivered file", () => {
    const root = fx.dir;
    recordHookGateBlock(root, fire(1), () => "demo_123");
    const demo = fx.track(new FileStore(root, "demo_123"));
    expect(demo.getUndeliveredWorkerStops()).toEqual([]);
    demo.markWorkerStopsDelivered(["blk_fire1"]);
    expect(fs.existsSync(path.join(root, ".deeppairing", "sessions", "demo_123", "worker-stops-delivered.json"))).toBe(false);
  });
});

describe("formatWorkerStops", () => {
  it("is empty for no stops and names agent, path, stance and decision", () => {
    expect(formatWorkerStops([])).toBe("");
    const one = formatWorkerStops(workerStopsFor([entry(1)], "s_a", []));
    expect(one).toBe(
      "⛔ Worker stopped (1): a `general-purpose` subagent was stopped or held for your approval at `notes-1.txt` " +
        `by stance \`global mutable singleton ${CANARY}\` (\`deny\`). That edit did **not** happen through the worker. ` +
        "Don't advance work that depends on it; re-plan, or ask the human. Don't retry the same edit.",
    );
    const two = formatWorkerStops(workerStopsFor([entry(2, { decision: "ask" }), entry(1)], "s_a", []));
    expect(two.startsWith("⛔ Worker stopped (2):\n- a `general-purpose` subagent")).toBe(true);
    expect(two).toContain("(`ask`)");
    expect(two).toContain("(`deny`)");
  });
});
