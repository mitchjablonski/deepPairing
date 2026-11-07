/**
 * #620 — a stance added through `/deeppairing:reject` (record_stance), end to
 * end through the production wiring: real MCP server → real DaemonClient →
 * real daemon composition (`/memory/rejected`) → real FileStore. Synthetic
 * replays: functional checks, not natural catches.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StanceWorld } from "./stance-exceptions.harness.js";

let world: StanceWorld;
afterEach(async () => { await world?.dispose(); });

const CONCEPT = "global mutable state";
const REASON = "hard to test and hides who owns config";
const codeArgs = {
  filePath: "src/config.ts",
  changeType: "modify",
  before: "let config = {};",
  after: "export function loadConfig() { return {}; }",
  reasoning: "Remove global mutable state from the config loader",
};

const prefsRows = (dir: string) =>
  (JSON.parse(fs.readFileSync(path.join(dir, ".deeppairing", "preferences.json"), "utf-8")).rejectedApproaches ?? []) as Array<Record<string, unknown>>;

describe("#620 record_stance through the daemon", () => {
  it("persists with provenance, refuses the re-proposal quoting the reason, and allow-once still admits it", async () => {
    world = new StanceWorld("dp-620-e2e-");
    const w = await world.wrapper();
    const added = await w.call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" });
    expect(added.isError).toBeFalsy();
    expect(prefsRows(world.dir)).toEqual([
      expect.objectContaining({ description: CONCEPT, concept: CONCEPT, reason: REASON, addedVia: "mcp", requestedBy: "user" }),
    ]);

    const blocked = await w.call("present_code_change", codeArgs);
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(blocked.text).toContain(`Prior rejection reason: "${REASON}"`);
    const block = await world.newestBlock();
    expect(block.eligible).toBe(true);

    // Existing recovery: the human allows that exact proposal once.
    await world.allowNewest();
    const admitted = await w.call("present_code_change", codeArgs);
    expect(admitted.isError).toBeFalsy();
    expect(admitted.text).toContain(`stance "${CONCEPT}"`);
    expect(world.store(w.sessionId).getArtifacts()).toHaveLength(1);
    // The stance itself is untouched by the allowance.
    expect(prefsRows(world.dir)).toHaveLength(1);
  });

  it("survives a daemon restart and still blocks, with provenance readable back", async () => {
    world = new StanceWorld("dp-620-restart-");
    const w1 = await world.wrapper();
    expect((await w1.call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" })).isError).toBeFalsy();
    await world.restart();
    const w2 = await world.wrapper();
    const listed = await w2.call("recall", { query: "mutable", mode: "project" });
    expect(listed.text).toContain(`"${CONCEPT}" — reason: "${REASON}"`);
    expect(listed.text).toContain("requested by: user (self-reported)");
    const blocked = await w2.call("present_code_change", codeArgs);
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain(`Prior rejection reason: "${REASON}"`);
  });

  it("#625 delta — the in-lock cap and the fill-only guard come back through the daemon as worded refusals", async () => {
    world = new StanceWorld("dp-620-cap-");
    const w = await world.wrapper();
    const prefsPath = path.join(world.dir, ".deeppairing", "preferences.json");
    fs.writeFileSync(prefsPath, JSON.stringify({ rejectedApproaches: Array.from({ length: 200 }, (_, i) => ({ description: `legacy stance number ${i}` })) }));
    const capped = await w.call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" });
    expect(capped.isError).toBe(true);
    expect(capped.text).toContain("already has 200 stances (from every source)");
    expect(prefsRows(world.dir)).toHaveLength(200);
  });

  it("#625 Sol P2 — two sessions adding the same stance at once through the daemon: one row, both replies quote it", async () => {
    world = new StanceWorld("dp-620-race-");
    const w1 = await world.wrapper("sx_one");
    const w2 = await world.wrapper("sx_two");
    const [a, b] = await Promise.all([
      w1.call("record_stance", { text: `${CONCEPT} -- ${REASON}`, requestedBy: "user" }),
      w2.call("record_stance", { text: `GLOBAL Mutable State -- a different reason`, requestedBy: "user" }),
    ]);
    const rows = prefsRows(world.dir);
    expect(rows).toHaveLength(1);
    const persisted = rows[0]!.reason as string;
    for (const r of [a, b]) {
      expect(r.isError).toBeFalsy();
      expect(r.text).toContain(`"${persisted}"`);
    }
    expect([a.text, b.text].filter((t) => t.startsWith("Stance recorded."))).toHaveLength(1);
    expect([a.text, b.text].filter((t) => t.startsWith("Nothing changed"))).toHaveLength(1);
  });

  it("the daemon's stance route rejects a forged provenance value instead of storing it", async () => {
    world = new StanceWorld("dp-620-forge-");
    const w = await world.wrapper();
    await expect(
      w.client.addStance({ concept: CONCEPT, reason: REASON, addedVia: "mcp", requestedBy: "agent" as never, maxRows: 200 }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(world.dir, ".deeppairing", "preferences.json")) ? prefsRows(world.dir) : []).toEqual([]);
  });
});
