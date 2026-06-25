import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordBroadcastMetric } from "../metrics-tap.js";
import { readMetrics } from "../metrics-store.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-tap-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("recordBroadcastMetric (the daemon's broadcast tap)", () => {
  it("counts an ORIGINAL artifact by type + each visual by kind", () => {
    recordBroadcastMetric(tmp, {
      type: "artifact_created",
      artifact: { type: "plan", parentId: null, content: { visuals: [{ kind: "diagram" }, { kind: "file_map" }] } },
    });
    const m = readMetrics(tmp);
    expect(m.counts.artifacts.total).toBe(1);
    expect(m.counts.artifacts.byType.plan).toBe(1);
    expect(m.counts.visuals.total).toBe(2);
    expect(m.counts.visuals.byKind.diagram).toBe(1);
    expect(m.counts.visuals.byKind.file_map).toBe(1);
  });

  it("F2 — does NOT count a REVISION (artifact_created carrying a parentId)", () => {
    recordBroadcastMetric(tmp, {
      type: "artifact_created",
      artifact: { type: "plan", parentId: "art_old", content: { visuals: [{ kind: "diagram" }] } },
    });
    const m = readMetrics(tmp);
    expect(m.counts.artifacts.total).toBe(0);
    expect(m.counts.visuals.total).toBe(0);
  });

  it("counts HUMAN comments only", () => {
    recordBroadcastMetric(tmp, { type: "comment_added", comment: { author: "human" } });
    recordBroadcastMetric(tmp, { type: "comment_added", comment: { author: "agent" } });
    expect(readMetrics(tmp).counts.comments).toBe(1);
  });

  it("counts question_asked from a feedback_received question", () => {
    recordBroadcastMetric(tmp, { type: "feedback_received", intent: "question" });
    recordBroadcastMetric(tmp, { type: "feedback_received", intent: "comment" });
    expect(readMetrics(tmp).counts.questions.asked).toBe(1);
  });

  it("does NOT count preflight_blocked or question_answered here — they're MCP-side broadcasts, recorded daemon-side instead", () => {
    recordBroadcastMetric(tmp, { type: "preflight_blocked", source: "session" });
    recordBroadcastMetric(tmp, { type: "question_answered" });
    const m = readMetrics(tmp);
    expect(m.counts.preflightBlocks.total).toBe(0); // not double-counted / not demo-inflated
    expect(m.counts.questions.answered).toBe(0);
  });
});
