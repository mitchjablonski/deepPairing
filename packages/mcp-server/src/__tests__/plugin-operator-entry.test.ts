/**
 * #344 (Fable's #375 review, HIGH-1) — the offline review-post recovery verbs
 * must be RUNNABLE on the marketplace install path.
 *
 * Their only caller was `deeppairing review-posts`, i.e. `dist/cli/init.js`,
 * which `scripts/bundle-plugin.mjs` does not emit — so a plugin-installed
 * daemon could write journal states that nothing shipped could clear. Grepping
 * the bundle for method names would not have caught it and would not catch a
 * regression: the names are present (the daemon links the journal), and a
 * tree-shaken name proves nothing about an entry point. So this test EXECUTES
 * the committed bundle.
 *
 * The copy is the point. `claude-plugin/server/` is copied to a temp directory
 * outside this repo, with no `node_modules` anywhere above it and no source
 * checkout beside it, then run under plain `node` — the layout a marketplace
 * user actually has. A workspace-only import would fail here and only here.
 *
 * Every run gets a scratch HOME, a scratch project, and a fake `gh` first on
 * PATH that records each invocation, so "this entry never contacts GitHub" is
 * measured rather than asserted. No ports are bound and no daemon is spawned.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReviewPostJournal, reviewPostDigest, type ReviewPostIdentity,
} from "../store/review-post-journal.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → mcp-server/ → packages/ → repo root
const repoRoot = path.resolve(here, "../../../..");
const bundleDir = path.join(repoRoot, "claude-plugin", "server");

const sid = "s_operator";
const target = "https://github.com/acme/widget/pull/12";
const identity: ReviewPostIdentity = {
  target, event: "COMMENT", payloadDigest: "a".repeat(64), authorizationDigest: "b".repeat(64),
};

/** The plugin-only copy — created once; the entry never writes inside it. */
let distRoot: string;
let entry: string;
/** Per-test scratch: project acted on, scratch HOME, fake-gh dir + its log. */
let tmp: string;
let projectRoot: string;
let ghLog: string;

beforeAll(() => {
  distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dp-plugin-only-"));
  // Copy ONLY claude-plugin/server, the way the marketplace ships it — no
  // packages/, no node_modules, no pnpm-workspace.yaml above it.
  fs.cpSync(bundleDir, path.join(distRoot, "server"), { recursive: true });
  entry = path.join(distRoot, "server", "review-posts.mjs");
});
afterAll(() => { fs.rmSync(distRoot, { recursive: true, force: true }); });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-operator-run-"));
  projectRoot = path.join(tmp, "project");
  fs.mkdirSync(path.join(projectRoot, ".deeppairing", "sessions", sid), { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  // A fake `gh` that records every invocation. Fakes not mocks: it is a real
  // executable a real child process would really find first on PATH.
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  ghLog = path.join(tmp, "gh-invocations.log");
  fs.writeFileSync(path.join(binDir, "gh"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ghLog)}\nexit 0\n`);
  fs.chmodSync(path.join(binDir, "gh"), 0o755);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[], opts: { cwd?: string } = {}): { stdout: string; stderr: string; status: number } {
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`,
    HOME: path.join(tmp, "home"),
    // The entry resolves its project root the same way every other entry does;
    // pin it explicitly rather than trusting the runner's cwd inheritance.
    DEEPPAIRING_PROJECT_ROOT: projectRoot,
  };
  // spawnSync, not execFileSync: this entry writes to BOTH streams on success
  // (JSON to stdout, the project banner to stderr) and both are asserted.
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf-8", cwd: opts.cwd ?? distRoot, env, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/** Seed one operation in `state`, returning its id and current digest. */
function seed(state: "reserved" | "sending" | "unknown"): { id: string; digest: string } {
  const journal = new ReviewPostJournal(projectRoot, sid);
  const lease = journal.reserve(identity);
  if (state !== "reserved") journal.markSending(lease, identity);
  if (state === "unknown") journal.markUnknown(lease);
  const op = journal.list().find(o => o.id === lease.operationId)!;
  expect(op.state).toBe(state);
  return { id: op.id, digest: reviewPostDigest(op) };
}

function ghInvocations(): string[] {
  return fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf-8").split("\n").filter(Boolean) : [];
}

describe("#344 — the plugin bundle emits a runnable operator entry", () => {
  it("the committed bundle contains the entry (CI's staleness gate keeps it fresh)", () => {
    expect(fs.existsSync(path.join(bundleDir, "review-posts.mjs"))).toBe(true);
  });

  it("carries no review-POST path — the containment is structural, not a promise", () => {
    const source = fs.readFileSync(entry, "utf-8");
    // cli/review-posts-offline.ts imports the journal and nothing else, so the
    // posting module never enters this bundle's module graph. These are the
    // literals only that graph can supply.
    expect(source).not.toContain("postPreparedPrReview");
    expect(source).not.toContain("buildGitHubReviewPayload");
    expect(source).not.toContain("--method POST");
    // ...and no daemon/hook machinery either: this is not the CLI in disguise.
    expect(source).not.toContain("ensureStopHook");
    expect(source).not.toContain("spawnDaemon");
  });

  it("prints help whose example invocation is the file that is running", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(`node "${entry}"`);
    expect(help.stdout).toContain("never contacts GitHub");
    // Truthful about what it does NOT carry.
    expect(help.stdout).toContain("reconcile");
    expect(ghInvocations()).toEqual([]);
  });

  it("bare invocation is a usage error, not a silent success", () => {
    const bare = run([]);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("<session-id>");
    expect(bare.stdout).toBe("");
  });
});

describe("#344 — read-only operator paths, executed from the plugin-only copy", () => {
  it("lists real journal operations as JSON on stdout, naming the project on stderr", () => {
    const { id } = seed("sending");
    const listed = run([sid]);
    expect(listed.status).toBe(0);
    const operations = JSON.parse(listed.stdout);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id, state: "sending", target, event: "COMMENT" });
    // stdout stays parseable; the project banner goes to stderr, because a
    // recovery run in the wrong directory otherwise reads as an empty journal.
    expect(listed.stderr).toContain(projectRoot);
    expect(ghInvocations()).toEqual([]);
  });

  it("works when simply run from inside the project, with no deepPairing env set", () => {
    // The invocation the docs hand an operator: cd to your project, run the
    // absolute path the plugin install gave you. No DEEPPAIRING_PROJECT_ROOT,
    // no cwd inside the copied bundle, nothing from this repo on the path.
    const { id } = seed("sending");
    const result = spawnSync(process.execPath, [entry, sid], {
      encoding: "utf-8", cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`, HOME: path.join(tmp, "home") },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)[0]).toMatchObject({ id, state: "sending" });
    expect(result.stderr).toContain("(cwd)");
    expect(ghInvocations()).toEqual([]);
  });

  it("leaks no fencing token, and the run mutates nothing", () => {
    seed("sending");
    const journalFile = path.join(projectRoot, ".deeppairing", "sessions", sid, "review-post-operations.json");
    const before = fs.readFileSync(journalFile);
    const listed = run([sid]);
    const raw = JSON.parse(fs.readFileSync(journalFile, "utf-8"));
    expect(listed.stdout).not.toContain(raw.operations[0].tokenDigest);
    expect(fs.readFileSync(journalFile)).toEqual(before);
  });

  it("an empty project lists nothing rather than creating anything", () => {
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare, { recursive: true });
    const listed = spawnSync(process.execPath, [entry, "s_nothing"], {
      encoding: "utf-8", cwd: distRoot,
      env: { PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`, HOME: path.join(tmp, "home"), DEEPPAIRING_PROJECT_ROOT: bare },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    expect(fs.existsSync(path.join(bare, ".deeppairing"))).toBe(false);
  });

  it("inspect answers with redacted metadata even when history cannot be read", () => {
    seed("sending");
    const journalFile = path.join(projectRoot, ".deeppairing", "sessions", sid, "review-post-operations.json");
    fs.writeFileSync(journalFile, '{"private-token":"do-not-print-this"');
    const before = fs.readFileSync(journalFile);

    const listed = run([sid]);
    expect(listed.status).toBe(0);
    const blocked = JSON.parse(listed.stdout);
    expect(blocked.blocked).toBe(true);
    expect(blocked.inspection.journal.path).toBe(journalFile);
    expect(listed.stdout).not.toContain("do-not-print-this");

    const inspected = run([sid, "inspect"]);
    expect(inspected.status).toBe(0);
    const inspection = JSON.parse(inspected.stdout);
    expect(inspection.journal).toMatchObject({ exists: true, regularFile: true, valid: false });
    expect(inspected.stdout).not.toContain("do-not-print-this");

    // Preserve-and-refuse: the corrupt bytes are still exactly what they were.
    expect(fs.readFileSync(journalFile)).toEqual(before);
    expect(ghInvocations()).toEqual([]);
  });

  it("refuses a malformed session id and an unknown verb without touching disk", () => {
    const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
    const before = fs.readdirSync(sessionsDir);
    for (const args of [["../escape"], ["s_operator", "wipe"], ["s_operator", "cancel-reserved"], ["s_operator", "list", "extra"]]) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("review-posts failed");
    }
    expect(fs.readdirSync(sessionsDir)).toEqual(before);
    expect(ghInvocations()).toEqual([]);
  });

  it("a missing session reads as empty and creates no session directory", () => {
    const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
    const listed = run(["s_typo"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    expect(fs.readdirSync(sessionsDir)).toEqual([sid]);
  });
});

describe("#344 — the mutating drains actually drain, from the plugin-only copy", () => {
  it("cancel-reserved fences a reserved operation", () => {
    const { id } = seed("reserved");
    const cancelled = run([sid, "cancel-reserved", id]);
    expect(cancelled.status).toBe(0);
    expect(cancelled.stdout).toContain(`Cancelled reserved operation ${id}`);
    expect(new ReviewPostJournal(projectRoot, sid).list()[0]!.state).toBe("failed");
    expect(ghInvocations()).toEqual([]);
  });

  it("cancel-reserved refuses an operation that reached sending", () => {
    const { id } = seed("sending");
    const refused = run([sid, "cancel-reserved", id]);
    expect(refused.status).toBe(1);
    expect(new ReviewPostJournal(projectRoot, sid).list()[0]!.state).toBe("sending");
  });

  it("acknowledge-unknown records the operator's acceptance of duplicate risk", () => {
    const { id, digest } = seed("unknown");
    const acknowledged = run([sid, "acknowledge-unknown", id, digest, "--all-writers-stopped", "--accept-duplicate-risk"]);
    expect(acknowledged.status).toBe(0);
    expect(acknowledged.stdout).toContain("does NOT prove the review was absent");
    const op = new ReviewPostJournal(projectRoot, sid).list()[0]!;
    expect(op.state).toBe("abandoned");
    expect(op.operatorAcknowledgement).toMatchObject({ priorState: "unknown", operationDigest: digest });
    expect(ghInvocations()).toEqual([]);
  });

  it("acknowledge-unknown without BOTH assertions changes nothing", () => {
    const { id, digest } = seed("unknown");
    for (const args of [
      [sid, "acknowledge-unknown", id, digest],
      [sid, "acknowledge-unknown", id, digest, "--all-writers-stopped"],
      [sid, "acknowledge-unknown", id, "c".repeat(64), "--all-writers-stopped", "--accept-duplicate-risk"],
    ]) {
      expect(run(args).status, args.join(" ")).toBe(1);
      expect(new ReviewPostJournal(projectRoot, sid).list()[0]!.state).toBe("unknown");
    }
  });

  it("release-claim removes only the claim the operator inspected", () => {
    seed("reserved");
    const claimPath = path.join(projectRoot, ".deeppairing", "sessions", sid, ".review-post.lock");
    fs.writeFileSync(claimPath, "abandoned-claim");
    const digest = JSON.parse(run([sid, "inspect"]).stdout).claim.digest;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // A claim that changed since inspection is NOT removed.
    fs.writeFileSync(claimPath, "someone-elses-claim");
    expect(run([sid, "release-claim", digest, "--all-writers-stopped"]).status).toBe(1);
    expect(fs.existsSync(claimPath)).toBe(true);

    fs.writeFileSync(claimPath, "abandoned-claim");
    const released = run([sid, "release-claim", digest, "--all-writers-stopped"]);
    expect(released.status).toBe(0);
    expect(fs.existsSync(claimPath)).toBe(false);
    // The assertion flag is not optional.
    expect(run([sid, "release-claim", digest]).status).toBe(1);
    expect(ghInvocations()).toEqual([]);
  });
}, 30_000);
