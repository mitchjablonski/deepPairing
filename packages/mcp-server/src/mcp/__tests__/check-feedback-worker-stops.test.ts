/**
 * #569 pilot task A (#553/#572) — the lead's check_feedback tells it that a
 * worker subagent was gate-stopped (deny) or held (ask).
 *
 * REQ-1 report · REQ-2 delivered once, own session only (an unresolved "hook"
 * entry goes to no one) · REQ-3 byte-identical when nothing is new · REQ-4
 * never authorising.
 *
 * Fakes, not mocks: a real FileStore per session over a real tmp project, and
 * the gate log written by the REAL hook-gate writer the daemon's watcher uses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleCheckFeedback } from "../tools/check-feedback.js";
import type { ToolContext } from "../tools/types.js";
import { FileStore } from "../../store/file-store.js";
import { recordHookGateBlock, type HookGateFireLike } from "../../store/preflight-block-log.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";
import {
  expectHealthyCheckFeedbackPayload,
  normalizedHealthyStructSha,
  GOLDEN_HEALTHY_STRUCT_SHA256,
} from "./check-feedback-test-helpers.js";

const CANARY = "FAKE-CANARY-569A";
const SESSIONS: Record<string, string> = { "claude-aaa": "s_a", "claude-bbb": "s_b" };
const resolve = (cs: string) => SESSIONS[cs];

let fx: GlobalStoreFixture;
let root: string;

beforeEach(() => {
  fx = withGlobalStore("dp-cf-ws-");
  root = fx.dir;
});

afterEach(() => {
  fx.dispose();
});

function makeCtx(store: FileStore): ToolContext {
  return {
    server: { notification: () => {} },
    store,
    broadcast: () => {},
    port: 4000,
    helpers: {} as ToolContext["helpers"],
    state: {
      checkFeedbackPollCount: 0,
      reportedRejectedVerdicts: new Set<string>(),
      reportedPlanVerdicts: new Set<string>(),
    },
    progressToken: "tok-ws",
  } as unknown as ToolContext;
}

function fire(n: number, o: { session?: string; agentId?: string | null; decision?: "ask" | "deny" } = {}): HookGateFireLike {
  return {
    id: `fire${n}`,
    at: new Date(Date.UTC(2026, 9, 22, 12, 0, n)).toISOString(),
    hook: "preflight",
    gate: {
      decision: o.decision ?? "deny",
      source: "session",
      concept: `global mutable singleton ${CANARY}`,
      reason: `keep state explicit ${CANARY}`,
      tool: "Write",
      target: `notes-${n}.txt`,
      session: o.session ?? "claude-aaa",
      ...(o.agentId === null ? {} : { agentId: o.agentId ?? `agent-${n}`, agentType: "general-purpose" }),
    },
  };
}

function seed(...fires: HookGateFireLike[]) {
  for (const f of fires) expect(recordHookGateBlock(root, f, resolve)).not.toBeNull();
}

async function poll(store: FileStore, args: Record<string, unknown> = {}) {
  const res = await handleCheckFeedback(makeCtx(store), args);
  return { text: res.content[0]!.text, sc: res.structuredContent as Record<string, unknown> };
}

type Stop = { id: string; agentType?: string; targetPath?: string; concept: string; decision: string; at: string };

describe("check_feedback worker stops (#569 pilot task A)", () => {
  it("REQ-1 — reports deny and ask stops in prose and structuredContent.workerStops", async () => {
    const store = fx.track(new FileStore(root, "s_a"));
    seed(fire(1), fire(2, { decision: "ask" }));
    const { text, sc } = await poll(store);

    expect(text).toContain("⛔ Worker stopped (2):");
    expect(text).toContain("a `general-purpose` subagent was stopped or held for your approval at `notes-1.txt`");
    expect(text).toContain(`by stance \`global mutable singleton ${CANARY}\` (\`deny\`)`);
    expect(text).toContain("at `notes-2.txt`");
    expect(text).toContain("(`ask`)");
    expect(text).toContain("did **not** happen through the workers");
    expect(text).toContain("Don't retry the same edits.");

    expect(sc.workerStops as Stop[]).toEqual([
      { id: "blk_fire1", agentType: "general-purpose", targetPath: "notes-1.txt", concept: `global mutable singleton ${CANARY}`, decision: "deny", at: "2026-10-22T12:00:01.000Z" },
      { id: "blk_fire2", agentType: "general-purpose", targetPath: "notes-2.txt", concept: `global mutable singleton ${CANARY}`, decision: "ask", at: "2026-10-22T12:00:02.000Z" },
    ]);
  });

  it("REQ-4 — a stop-only poll never says proceed; the suggested action is to re-plan or ask", async () => {
    const store = fx.track(new FileStore(root, "s_a"));
    seed(fire(1));
    const res = await handleCheckFeedback(makeCtx(store), {});
    const text = res.content[0]!.text;
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.status).toBe("feedback");
    expect(text).not.toMatch(/proceed/i);
    expect(JSON.stringify(sc)).not.toMatch(/proceed/i);
    expect(text).toContain(
      "Suggested action: A worker was stopped. Re-plan the dependent work or ask the human before continuing.",
    );
    // Busy poll (M3): suggestedAction rides the prose preamble, not sc.
    expect(sc).not.toHaveProperty("suggestedAction");

    // Once delivered, the next poll is back to the healthy proceed payload.
    const next = await handleCheckFeedback(makeCtx(store), {});
    expect((next.structuredContent as Record<string, unknown>).status).toBe("proceed");
  });

  it("REQ-2 — delivered once: the next poll is silent, and a restart doesn't repeat it", async () => {
    const store = fx.track(new FileStore(root, "s_a"));
    seed(fire(1));
    const first = await poll(store);
    expect(first.text).toContain("⛔ Worker stopped (1):");
    expect((first.sc.workerStops as Stop[]).map((s) => s.id)).toEqual(["blk_fire1"]);

    const second = await poll(store);
    expect(second.text).not.toContain("Worker stopped");
    expect(second.sc).not.toHaveProperty("workerStops");

    const restarted = fx.track(new FileStore(root, "s_a"));
    const third = await poll(restarted);
    expect(third.text).not.toContain("Worker stopped");
    expect(third.sc).not.toHaveProperty("workerStops");

    // A new stop after the restart is delivered, alone.
    seed(fire(2));
    const fourth = await poll(restarted);
    expect((fourth.sc.workerStops as Stop[]).map((s) => s.id)).toEqual(["blk_fire2"]);
  });

  it("REQ-2 — A/B isolation: each lead hears only its own session's workers", async () => {
    const a = fx.track(new FileStore(root, "s_a"));
    const b = fx.track(new FileStore(root, "s_b"));
    seed(fire(1), fire(2, { session: "claude-bbb" }));

    const pa = await poll(a);
    expect((pa.sc.workerStops as Stop[]).map((s) => s.id)).toEqual(["blk_fire1"]);
    expect(pa.text).toContain("notes-1.txt");
    expect(pa.text).not.toContain("notes-2.txt");

    const pb = await poll(b);
    expect((pb.sc.workerStops as Stop[]).map((s) => s.id)).toEqual(["blk_fire2"]);
    expect(pb.text).not.toContain("notes-1.txt");

    // A's delivery didn't consume B's, and vice versa.
    expect(a.getUndeliveredWorkerStops()).toEqual([]);
    expect(b.getUndeliveredWorkerStops()).toEqual([]);
  });

  it("REQ-2 — an unresolved \"hook\" entry goes to no one", async () => {
    const a = fx.track(new FileStore(root, "s_a"));
    const b = fx.track(new FileStore(root, "s_b"));
    seed(fire(1, { session: "claude-nobody" }));
    for (const s of [a, b]) {
      const { text, sc } = await poll(s);
      expect(text).not.toContain("Worker stopped");
      expect(sc).not.toHaveProperty("workerStops");
    }
  });

  it("REQ-2 — a filtered subagent poll never takes the lead's notice", async () => {
    const store = fx.track(new FileStore(root, "s_a"));
    seed(fire(1));
    const filtered = await poll(store, { presentedBy: "worker-1" });
    expect(filtered.text).not.toContain("Worker stopped");
    expect(filtered.sc).not.toHaveProperty("workerStops");
    const lead = await poll(store);
    expect((lead.sc.workerStops as Stop[]).map((s) => s.id)).toEqual(["blk_fire1"]);
  });

  it("REQ-3 — nothing new is byte-identical to an empty log (text and structuredContent)", async () => {
    const store = fx.track(new FileStore(root, "s_a"));
    const empty = await handleCheckFeedback(makeCtx(store), {});
    expectHealthyCheckFeedbackPayload(empty.structuredContent as Record<string, unknown>);
    expect(normalizedHealthyStructSha(empty.structuredContent as Record<string, unknown>)).toBe(GOLDEN_HEALTHY_STRUCT_SHA256);

    // Entries that are not this session's new worker stops: another session's
    // worker, an unresolved "hook" firing, and the lead's own (no agentId).
    seed(fire(1, { session: "claude-bbb" }), fire(2, { session: "claude-nobody" }), fire(3, { agentId: null }));
    const notMine = await handleCheckFeedback(makeCtx(store), {});
    expect(notMine).toEqual(empty);
    expect(JSON.stringify(notMine)).toBe(JSON.stringify(empty));

    // And this session's stop, once delivered, is "nothing new" too.
    seed(fire(4));
    const delivered = await handleCheckFeedback(makeCtx(store), {});
    expect(delivered).not.toEqual(empty);
    const after = await handleCheckFeedback(makeCtx(store), {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(empty));

    // No delivered-ids file is written for a session that never had a stop.
    const b = fx.track(new FileStore(root, "s_b_quiet"));
    await handleCheckFeedback(makeCtx(b), {});
    expect(fs.existsSync(path.join(root, ".deeppairing", "sessions", "s_b_quiet", "worker-stops-delivered.json"))).toBe(false);
  });

  it("REQ-4 — never authorising: the stance, the log and the session state are unchanged", async () => {
    const prefsFile = path.join(root, ".deeppairing", "preferences.json");
    fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
    fs.writeFileSync(prefsFile, JSON.stringify({
      rejectedApproaches: [{ description: `global mutable singleton ${CANARY}`, reason: "keep state explicit" }],
    }));
    const store = fx.track(new FileStore(root, "s_a"));
    seed(fire(1));
    const logFile = path.join(root, ".deeppairing", "preflight-blocks.json");
    const logBefore = fs.readFileSync(logFile, "utf8");
    const prefsBefore = fs.readFileSync(prefsFile, "utf8");
    const memBefore = JSON.stringify(await store.getSessionMemory());

    const { text, sc } = await poll(store);
    expect(text).toContain("⛔ Worker stopped (1):");
    // The notice carries no grant/allowance/receipt fields.
    expect(JSON.stringify(sc.workerStops)).not.toMatch(/allow|grant|receipt|eligible/i);

    // Nothing the gate reads changed: the stance file and the gate log (no
    // seenAt, no allowance) are byte-identical, and the stance is still held.
    expect(fs.readFileSync(logFile, "utf8")).toBe(logBefore);
    expect(fs.readFileSync(prefsFile, "utf8")).toBe(prefsBefore);
    expect(JSON.stringify(await store.getSessionMemory())).toBe(memBefore);
  });
});
