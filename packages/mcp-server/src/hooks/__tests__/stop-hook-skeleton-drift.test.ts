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
function stop(): { stderr: string; status: number | null; reason: string; state: Record<string, unknown> } {
  const res = spawnSync("node", [script], { input: "", encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, DEEPPAIRING_PROJECT_ROOT: "" } });
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
    const code = (id: string) => ({ id, type: "code_change", status: "approved", createdAt: recent() });
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

  it("a deleted declared file is named", () => {
    seed([approvedPlan()]);
    fs.rmSync(path.join(root, "a.ts"));
    expect(stop().stderr).toContain("skeleton exterior drift since approval: a.ts (deleted)");
  });
});
