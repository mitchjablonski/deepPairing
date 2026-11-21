/**
 * #686 P2c — the Stop hook's skeleton drift nudge (warn-only). Runs the REAL
 * generated stop script (esbuild output, Node built-ins only) against a temp
 * project seeded with an approved skeleton plan, and reads stderr plus
 * hooks-state.json. One nudge per approved version; blocking drafts first;
 * drift before the debrief nag; never file content.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STOP_HOOK_SCRIPT } from "../../cli/hook-scripts.generated.js";
import { buildSkeletonSnapshot } from "../../mcp/skeleton-snapshot.js";

const SRC = `export function smooth(raw: number[]): number[] {
  // SKEL[1] drop duplicates
  throw new Error("SKEL_TODO");
  // /SKEL[1]
}
`;
const FILLED = SRC.replace('throw new Error("SKEL_TODO");', "return [...new Set(raw)];");
const STEPS = [{ description: "dedupe", reasoning: "r", skelId: "1", files: ["a.ts"] }];
const NOW = Date.now();
const recent = (msAgo = 60_000) => new Date(NOW - msAgo).toISOString();

let root: string;
let script: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dp-stopdrift-")));
  script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dp-stopdrift-bin-")), "stop.mjs");
  fs.writeFileSync(script, STOP_HOOK_SCRIPT);
  fs.writeFileSync(path.join(root, "a.ts"), SRC);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(script), { recursive: true, force: true });
});

type Art = Record<string, unknown>;
function approvedPlan(extra: Art = {}): Art {
  const visuals = buildSkeletonSnapshot({ steps: STEPS, root, recordExterior: true }).visuals;
  return {
    id: "plan1",
    type: "plan",
    status: "approved",
    version: 1,
    title: "Smoothing skeleton",
    createdAt: recent(120_000),
    updatedAt: recent(),
    statusHistory: [{ status: "draft", at: recent(120_000) }, { status: "approved", at: recent(90_000) }],
    content: { steps: STEPS, estimatedChanges: 1, visuals },
    ...extra,
  };
}
function seed(artifacts: Art[]): void {
  const dir = path.join(root, ".deeppairing", "sessions", "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(artifacts));
}
function stop(input = ""): { stderr: string; status: number | null; reason: string; state: Record<string, unknown> } {
  const res = spawnSync("node", [script], { input, encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_PROJECT_ROOT: "" } });
  const state = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "hooks-state.json"), "utf-8"));
  return { stderr: res.stderr, status: res.status, reason: String(state.fires.at(-1)?.reason ?? ""), state };
}
const write = (text: string) => fs.writeFileSync(path.join(root, "a.ts"), text);

describe("Stop hook — skeleton exterior drift nudge (#686 P2c)", () => {
  it("drift → one nudge with file and line; a second Stop does not repeat it", () => {
    const plan = approvedPlan();
    seed([plan]);
    write(FILLED.replace("raw: number[])", "raw: readonly number[])"));
    const first = stop();
    expect(first.status).toBe(0);
    expect(first.stderr).toBe(
      "deepPairing: skeleton exterior drift since approval: a.ts line 1 — changes outside the fences are skeleton changes; propose them and revise_artifact the plan\n",
    );
    expect(first.reason).toMatch(/^skeleton drift plan1@v1@/);
    expect(first.state.skeletonDriftNudged).toHaveLength(1);
    const second = stop();
    expect(second.stderr).toBe("");
    expect(second.reason).toBe("pass: no blocking drafts");
  });

  it("a new approval (or version) re-arms the nudge", () => {
    const plan = approvedPlan();
    seed([plan]);
    write(`// header\n${SRC}`);
    expect(stop().stderr).toContain("skeleton exterior drift");
    expect(stop().stderr).toBe("");
    const history = [...(plan.statusHistory as Art[]), { status: "approved", at: recent(10_000) }];
    seed([{ ...plan, statusHistory: history }]);
    expect(stop().stderr).toContain("skeleton exterior drift");
    seed([{ ...plan, statusHistory: history, version: 2 }]);
    expect(stop().stderr).toContain("skeleton exterior drift");
  });

  it("no drift (a fill inside the fence) → quiet, and nothing is recorded", () => {
    seed([approvedPlan()]);
    write(FILLED);
    const res = stop();
    expect(res.stderr).toBe("");
    expect(res.state.skeletonDriftNudged).toBeUndefined();
  });

  it("a blocking draft takes precedence: one message per Stop", () => {
    seed([approvedPlan(), { id: "sp1", type: "spec", status: "draft", createdAt: recent() }]);
    write(`// header\n${SRC}`);
    const res = stop();
    expect(res.stderr).toBe("deepPairing: pending artifacts need review — call check_feedback\n");
    expect(res.state.skeletonDriftNudged).toBeUndefined();
  });

  it("drift comes before the debrief nag, which returns on the next Stop", () => {
    seed([approvedPlan(), code("c1"), code("c2")]);
    write(`// header\n${SRC}`);
    expect(stop().stderr).toContain("skeleton exterior drift");
    expect(stop().stderr).toContain("no present_debrief yet");
  });

  it("a version restored after a rejected reshape is still checked", () => {
    const v1 = approvedPlan({ status: "superseded", statusHistory: [{ status: "draft", at: recent(9e4) }, { status: "approved", at: recent(8e4) }, { status: "superseded", at: recent(7e4) }] });
    seed([v1, { id: "plan2", type: "plan", status: "rejected", parentId: "plan1", createdAt: recent(), content: { steps: STEPS } }]);
    write(`// header\n${SRC}`);
    expect(stop().stderr).toContain("skeleton exterior drift since approval: a.ts line 1");
  });

  it("a withheld file is reported changed with no line numbers and never any content", () => {
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    write(`const k = "${token}";\n${SRC}`);
    const plan = approvedPlan();
    expect(JSON.stringify(plan)).not.toContain(token);
    seed([plan]);
    write(`const k = "${token}";\nconst leaked = "SECRET-SHAPED-LINE";\n${FILLED}`);
    const res = stop();
    expect(res.stderr).toContain("a.ts (changed — withheld from the approved snapshot, so no line numbers)");
    expect(res.stderr).not.toContain(token);
    expect(res.stderr).not.toContain("SECRET-SHAPED-LINE");
    expect(JSON.stringify(res.state)).not.toContain(token);
  });

  const code = (id: string) => ({ id, type: "code_change", status: "approved", createdAt: recent() });
  const DEBRIEF_NAG = "deepPairing: code was presented but no present_debrief yet — end the run with one so your pair gets the walk-through\n";

  it("null entries and a non-array statusHistory never silence the debrief nag", () => {
    seed([null as unknown as Art, approvedPlan({ statusHistory: {} }), 42 as unknown as Art, code("c1"), code("c2")]);
    write(`// header\n${SRC}`);
    const res = stop();
    expect(res.status).toBe(0);
    expect(res.reason).not.toMatch(/^error/);
    // statusHistory {} → no approvedAt; updatedAt is recent, so it is still checked.
    expect(res.stderr).toContain("skeleton exterior drift");
    const again = stop();
    expect(again.stderr).toBe(DEBRIEF_NAG);
    // A superseded plan whose statusHistory is malformed is simply not a baseline.
    seed([null as unknown as Art, approvedPlan({ status: "superseded", statusHistory: "x" }), code("c1"), code("c2")]);
    expect(stop().stderr).toBe(DEBRIEF_NAG);
  });

  it("several approved plans: every un-nudged one is checked, one nudge lists the drifting ones", () => {
    fs.writeFileSync(path.join(root, "b.ts"), SRC.replace(/SKEL\[1\]/g, "SKEL[2]"));
    const planA = approvedPlan({ id: "planA", title: "Plan A", updatedAt: recent(50_000) });
    const stepsB = [{ description: "b", reasoning: "r", skelId: "2", files: ["b.ts"] }];
    const planB = approvedPlan({
      id: "planB",
      title: "Plan B",
      updatedAt: recent(1_000),
      content: { steps: stepsB, visuals: buildSkeletonSnapshot({ steps: stepsB, root, recordExterior: true }).visuals },
    });
    seed([planA, planB]);
    write(`// header\n${SRC}`); // A drifts; B (newer) does not
    const res = stop();
    expect(res.stderr).toContain("skeleton exterior drift since approval: a.ts line 1");
    expect(res.stderr).not.toContain("b.ts");
    expect(res.state.skeletonDriftNudged).toEqual([expect.stringMatching(/^planA@v1@/)]);
    // Both drift: one line naming both plans; A is not repeated.
    fs.writeFileSync(path.join(root, "b.ts"), `// header\n${SRC.replace(/SKEL\[1\]/g, "SKEL[2]")}`);
    const both = stop();
    expect(both.stderr).toContain("skeleton exterior drift since approval: b.ts line 1");
    seed([{ ...planA, version: 2 }, { ...planB, version: 2 }]);
    const two = stop();
    expect(two.stderr).toContain('"Plan A": a.ts line 1 | "Plan B": b.ts line 1');
    expect((two.state.skeletonDriftNudged as string[]).filter((k) => k.includes("@v2@"))).toHaveLength(2);
  });

  it("a corrupt hooks-state.json gets one salvage copy per Stop, not two", () => {
    seed([approvedPlan()]);
    write(`// header\n${SRC}`);
    fs.writeFileSync(path.join(root, ".deeppairing", "hooks-state.json"), "{not json");
    const res = stop();
    expect(res.stderr).toContain("skeleton exterior drift");
    const backups = fs.readdirSync(path.join(root, ".deeppairing")).filter((f) => f.startsWith("hooks-state.json.corrupt-"));
    expect(backups).toHaveLength(1);
  });

  it("a stale approval (no activity for over 8 h) is not nudged", () => {
    const old = recent(9 * 60 * 60 * 1000);
    seed([approvedPlan({ updatedAt: old, statusHistory: [{ status: "approved", at: old }] })]);
    write(`// header\n${SRC}`);
    expect(stop().stderr).toBe("");
  });

  it("a session_id naming a missing session is quiet, exit 0", () => {
    seed([approvedPlan()]);
    write(`// header\n${SRC}`);
    const res = stop(JSON.stringify({ session_id: "no-such-session" }));
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("a non-array skeletonDriftNudged is treated as empty and repaired", () => {
    seed([approvedPlan()]);
    write(`// header\n${SRC}`);
    fs.writeFileSync(path.join(root, ".deeppairing", "hooks-state.json"), JSON.stringify({ version: 1, skeletonDriftNudged: { x: 1 } }));
    const res = stop();
    expect(res.stderr).toContain("skeleton exterior drift");
    expect(Array.isArray(res.state.skeletonDriftNudged)).toBe(true);
    expect(stop().stderr).toBe("");
  });

  it("a path-traversal visual id never reads outside the project and stays quiet", () => {
    const outside = path.join(path.dirname(root), "dp-outside-secret.ts");
    fs.writeFileSync(outside, "OUTSIDE-CONTENT\n");
    try {
      const rel = `../${path.basename(outside)}`;
      const visual = { id: `skelcode:${rel}`, kind: "annotated_code", code: "x\n// SKEL[1] a\n// /SKEL[1]", skeleton: { fences: [], takenAt: recent() } };
      const evil = { id: "skelcode:../../etc/passwd", kind: "annotated_code", code: "root", skeleton: { fences: [], takenAt: recent() } };
      seed([approvedPlan({ content: { steps: STEPS, visuals: [visual, evil] } })]);
      const res = stop();
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      expect(JSON.stringify(res.state)).not.toContain("OUTSIDE-CONTENT");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("a deleted declared file is named", () => {
    seed([approvedPlan()]);
    fs.rmSync(path.join(root, "a.ts"));
    expect(stop().stderr).toContain("skeleton exterior drift since approval: a.ts (deleted)");
  });
});
