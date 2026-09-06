/**
 * #344 (Fable's #375 review, M1) — `--session-id` must name a session that
 * already exists, and a wrong id must cost nothing.
 *
 * The guard the per-session posting scope now rests on was `if
 * (!sessionId?.trim())`, so the id was free text. `new FileStore(cwd, id)`
 * CREATES the session directory, so a typo manufactured a session — and a
 * fresh, unguarded journal — on its way to failing, and the companion UI then
 * listed the litter. Fable executed exactly that against a real CLI subprocess:
 * `ls .deeppairing/sessions/` showed `real  typo-session` after a run that had
 * just refused to post.
 *
 * The pure selector is unit-tested branch by branch; the wiring is tested
 * through the REAL CLI (under tsx, no build) with a fake `gh` first on PATH, so
 * "a typo reaches neither the filesystem nor GitHub" is measured. Nothing here
 * makes selecting another existing session anything but the operator's own
 * explicit choice — it is a membership check, not deduplication.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectPostingSession, readSessionDirectories } from "../session-selection.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../init.ts");
const tsxBin = path.resolve(here, "../../../node_modules/.bin/tsx");

describe("selectPostingSession — the pure membership check", () => {
  const readable = ["s_real", "s_other"];
  const directories = ["s_real", "s_other", "s_empty"];

  it("accepts an id that names a readable session, and trims it", () => {
    expect(selectPostingSession({ requested: "s_real", readable, directories })).toEqual({ ok: true, sessionId: "s_real" });
    expect(selectPostingSession({ requested: "  s_real  ", readable, directories })).toEqual({ ok: true, sessionId: "s_real" });
  });

  it("accepts a DIFFERENT existing session — explicit choice, not deduplication", () => {
    expect(selectPostingSession({ requested: "s_other", readable, directories })).toEqual({ ok: true, sessionId: "s_other" });
  });

  it("keeps the no-flag refusal wording verbatim", () => {
    for (const requested of [undefined, "", "   "]) {
      const selection = selectPostingSession({ requested, readable, directories });
      expect(selection.ok).toBe(false);
      expect(selection.ok === false && selection.message).toBe(
        "Posting requires --session-id ID. Use the exact session reviewed in the companion UI; the CLI never guesses a session for an external write.");
    }
  });

  it("refuses a near-miss id and names the sessions that do exist", () => {
    const selection = selectPostingSession({ requested: "s_rea", readable, directories });
    expect(selection.ok).toBe(false);
    const message = selection.ok === false ? selection.message : "";
    expect(message).toContain('No session "s_rea" in this project');
    expect(message).toContain("Nothing was created");
    expect(message).toContain("s_real, s_other");
  });

  it("distinguishes a session directory with no readable artifacts from a typo", () => {
    const selection = selectPostingSession({ requested: "s_empty", readable, directories });
    expect(selection.ok).toBe(false);
    expect(selection.ok === false && selection.message).toContain("has no readable artifacts");
  });

  it("says so plainly when the project has no reviewable sessions at all", () => {
    const selection = selectPostingSession({ requested: "s_any", readable: [], directories: [] });
    expect(selection.ok).toBe(false);
    expect(selection.ok === false && selection.message).toContain("no sessions with reviewable artifacts yet");
  });

  it("summarises rather than dumping a long session list", () => {
    const many = Array.from({ length: 14 }, (_, i) => `s_${i}`);
    const selection = selectPostingSession({ requested: "s_nope", readable: many, directories: many });
    const message = selection.ok === false ? selection.message : "";
    expect(message).toContain("s_0, s_1, s_2, s_3, s_4, s_5, s_6, s_7, s_8, s_9, and 4 more");
    expect(message).not.toContain("s_13");
  });
});

describe("readSessionDirectories — read-only, and never joins the requested id", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "dp-session-dirs-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("lists directories only, and creates nothing when there are none", () => {
    expect(readSessionDirectories(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, ".deeppairing"))).toBe(false);

    const sessions = path.join(root, ".deeppairing", "sessions");
    fs.mkdirSync(path.join(sessions, "s_one"), { recursive: true });
    fs.writeFileSync(path.join(sessions, "not-a-session.json"), "{}");
    expect(readSessionDirectories(root)).toEqual(["s_one"]);
  });
});

describe("#344 M1 — the real CLI refuses a typo without creating a session or calling gh", () => {
  let tmp: string;
  let projectRoot: string;
  let ghLog: string;

  const sessionsDir = () => path.join(projectRoot, ".deeppairing", "sessions");

  /** A session the companion UI would list: one artifact on disk. */
  function seedSession(id: string) {
    const dir = path.join(sessionsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify([{
      id: "a1", type: "research", version: 1, status: "presented", title: "A finding",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
      content: { summary: "s", findings: [] },
    }]));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-post-session-"));
    projectRoot = path.join(tmp, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    ghLog = path.join(tmp, "gh-invocations.log");
    // A real executable, first on PATH: if the CLI reaches GitHub at all, this
    // records it. It never answers usefully — nothing here should get that far.
    fs.writeFileSync(path.join(binDir, "gh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ghLog)}\nexit 1\n`);
    fs.chmodSync(path.join(binDir, "gh"), 0o755);
    seedSession("s_real");
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
    const result = spawnSync(tsxBin, [cliEntry, ...args], {
      encoding: "utf-8", cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`,
        HOME: path.join(tmp, "home"),
        DEEPPAIRING_PROJECT_ROOT: projectRoot,
      },
    });
    if (result.error) throw result.error;
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  }

  function ghInvocations(): string[] {
    return fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf-8").split("\n").filter(Boolean) : [];
  }

  it("a typo neither creates a session directory nor reaches gh", () => {
    const result = runCli(["post-pr-review", "42", "--session-id", "typo-session"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No session "typo-session" in this project');
    expect(result.stderr).toContain("s_real");
    // The regression Fable executed: `ls` used to show `real  typo-session`.
    expect(fs.readdirSync(sessionsDir())).toEqual(["s_real"]);
    expect(ghInvocations()).toEqual([]);
  });

  it("the no-flag refusal still fires, unchanged", () => {
    const result = runCli(["post-pr-review", "42"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Posting requires --session-id ID");
    expect(fs.readdirSync(sessionsDir())).toEqual(["s_real"]);
    expect(ghInvocations()).toEqual([]);
  });

  it("a path-traversal id is refused as a name, never resolved as a path", () => {
    const result = runCli(["post-pr-review", "42", "--session-id", "../../etc"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No session "../../etc" in this project');
    expect(fs.readdirSync(sessionsDir())).toEqual(["s_real"]);
    expect(ghInvocations()).toEqual([]);
  });

  it("a real session id passes the membership check and fails later, on authorization", () => {
    const result = runCli(["post-pr-review", "42", "--session-id", "s_real"]);
    expect(result.status).toBe(1);
    // Past the guard: this is the authorization gate refusing, not the id check.
    expect(result.stderr).not.toContain("No session");
    expect(result.stderr).not.toContain("Posting requires --session-id");
    expect(fs.readdirSync(sessionsDir())).toEqual(["s_real"]);
    // The gate refuses before any remote preparation, so still no gh.
    expect(ghInvocations()).toEqual([]);
  });

  it("the no-PR example the CLI prints names --session-id (it is required now)", () => {
    const result = runCli(["post-pr-review"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--session-id <id>");
  });
}, 60_000);
