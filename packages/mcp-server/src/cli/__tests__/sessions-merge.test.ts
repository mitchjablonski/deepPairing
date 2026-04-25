/**
 * U0.6 — `deeppairing sessions merge <from> <into>` rescues data from
 * sessions split by the old non-deterministic sessionId scheme.
 *
 * Field bug context: a user's UI bound to session A and wrote 5 comments
 * there; the agent's wrapper recorded the artifact in session B and polled
 * B for feedback. The comments were orphaned. Merging A → B re-unites them.
 *
 * We exercise the merge through the CLI binary (built dist) so the test
 * mirrors the actual user flow. The test fixtures mimic the field bug:
 * source has comments referencing an artifactId that lives only in target.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → cli/ → src/ → mcp-server/
const cliEntry = path.resolve(here, "../../../dist/cli/init.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dp-sessions-merge-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(id: string, files: Record<string, any[]>) {
  const dir = path.join(tmpDir, ".deeppairing", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, arr] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(arr, null, 2));
  }
}

function runMerge(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  if (!fs.existsSync(cliEntry)) {
    // Tests run before build in some flows; skip rather than fail the suite.
    return { exitCode: -1, stdout: "(cli not built)", stderr: "" };
  }
  try {
    const stdout = execSync(`node ${cliEntry} sessions merge ${args.join(" ")} --yes`, {
      cwd: tmpDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

describe("sessions merge (U0.6)", () => {
  it("merges comments from the source into the target and rewires sessionId", () => {
    if (!fs.existsSync(cliEntry)) return; // pre-build skip
    writeSession("from", {
      "comments.json": [
        { id: "c1", sessionId: "from", target: { artifactId: "art_X" }, content: "needs work", author: "human" },
        { id: "c2", sessionId: "from", target: { artifactId: "art_X" }, content: "looks good", author: "human" },
      ],
    });
    writeSession("into", {
      "artifacts.json": [{ id: "art_X", sessionId: "into", type: "plan", status: "draft" }],
    });

    const r = runMerge(["from", "into"]);
    expect(r.exitCode).toBe(0);

    const merged = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/into/comments.json"), "utf-8"),
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((c: any) => c.id).sort()).toEqual(["c1", "c2"]);
    // sessionId rewritten so the comment now reports its new home.
    expect(merged.every((c: any) => c.sessionId === "into")).toBe(true);
  });

  it("dedupes by id (target wins on collision)", () => {
    if (!fs.existsSync(cliEntry)) return;
    writeSession("from", {
      "comments.json": [
        { id: "c1", sessionId: "from", target: { artifactId: "art_X" }, content: "from-version" },
      ],
    });
    writeSession("into", {
      "comments.json": [
        { id: "c1", sessionId: "into", target: { artifactId: "art_X" }, content: "into-version" },
      ],
    });

    runMerge(["from", "into"]);
    const merged = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/into/comments.json"), "utf-8"),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("into-version");
  });

  it("removes the source directory after a successful merge with --yes", () => {
    if (!fs.existsSync(cliEntry)) return;
    writeSession("from", { "comments.json": [{ id: "c1", sessionId: "from", target: { artifactId: "x" } }] });
    writeSession("into", { "comments.json": [] });

    runMerge(["from", "into"]);
    expect(fs.existsSync(path.join(tmpDir, ".deeppairing/sessions/from"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".deeppairing/sessions/into"))).toBe(true);
  });

  it("merges all known artifact types: artifacts, comments, decisions, plan-reviews, retrospectives", () => {
    if (!fs.existsSync(cliEntry)) return;
    writeSession("from", {
      "artifacts.json":      [{ id: "art1", sessionId: "from", type: "research", status: "draft" }],
      "comments.json":       [{ id: "c1",  sessionId: "from", target: { artifactId: "art1" } }],
      "decisions.json":      [{ decisionId: "d1", artifactId: "art1" }],
      "plan-reviews.json":   [{ artifactId: "art1", verdict: "approved" }],
      "retrospectives.json": [{ id: "r1", decisionId: "d1", verdict: "right" }],
    });
    writeSession("into", { "artifacts.json": [] });

    const r = runMerge(["from", "into"]);
    expect(r.exitCode).toBe(0);
    for (const f of ["artifacts.json", "comments.json", "decisions.json", "plan-reviews.json", "retrospectives.json"]) {
      const arr = JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".deeppairing/sessions/into", f), "utf-8"),
      );
      expect(arr.length, `${f} should have at least one record after merge`).toBeGreaterThan(0);
    }
  });

  it("refuses to merge a session into itself", () => {
    if (!fs.existsSync(cliEntry)) return;
    writeSession("same", { "comments.json": [] });
    const r = runMerge(["same", "same"]);
    expect(r.exitCode).not.toBe(0);
  });

  it("errors clearly when the source session doesn't exist", () => {
    if (!fs.existsSync(cliEntry)) return;
    writeSession("into", { "comments.json": [] });
    const r = runMerge(["nonexistent", "into"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not found/i);
  });
});
