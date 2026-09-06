/**
 * #344 (Fable's #375 review, HIGH-1; Astra's #383 review) — the review-post
 * recovery verbs must be RUNNABLE on the marketplace install path.
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
 * PATH that records each invocation. The five offline verbs must record ZERO
 * invocations; `reconcile` — the one verb that reads GitHub — is driven against
 * that same fake, and every command it issues is asserted to be a GET. No ports
 * are bound, no daemon is spawned, and no real GitHub call is made.
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
import { reviewPostMarker } from "../github/durable-review-post.js";

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
let ghDir: string;

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
  // A fake `gh` that records every invocation and serves whatever evidence the
  // test lays down beside it. Fakes not mocks: a real executable a real child
  // process really finds first on PATH, answering the real argv the code builds.
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  ghLog = path.join(tmp, "gh-invocations.log");
  ghDir = path.join(tmp, "gh-data");
  fs.mkdirSync(ghDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "gh"), [
    "#!/bin/sh",
    `echo "$@" >> ${JSON.stringify(ghLog)}`,
    `code=$(cat ${JSON.stringify(path.join(ghDir, "exit-code"))} 2>/dev/null || echo 0)`,
    'if [ "$code" != "0" ]; then echo "gh: HTTP 404 Not Found" >&2; exit "$code"; fi',
    'case "$*" in',
    `  *comments*) cat ${JSON.stringify(path.join(ghDir, "comments.json"))} ;;`,
    `  *) cat ${JSON.stringify(path.join(ghDir, "review.json"))} ;;`,
    "esac",
    "",
  ].join("\n"));
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
function seed(state: "reserved" | "sending" | "unknown", using: ReviewPostIdentity = identity): { id: string; digest: string } {
  const journal = new ReviewPostJournal(projectRoot, sid);
  const lease = journal.reserve(using);
  if (state !== "reserved") journal.markSending(lease, using);
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

  it("carries no way to submit a review — the containment is structural, not a promise", () => {
    const source = fs.readFileSync(entry, "utf-8");
    // The remote read comes from github/read-review.ts, so github/post-review.ts
    // never enters this bundle's module graph. These are the literals only that
    // graph could supply.
    expect(source).not.toContain("postPreparedPrReview");
    expect(source).not.toContain("buildGitHubReviewPayload");
    expect(source).not.toContain("preparePrReviewTarget");
    // No HTTP-method string other than GET survives anywhere in the file, so
    // there is no POST for a bug or a crafted argument to reach.
    expect(source).not.toMatch(/["'`](POST|PUT|PATCH|DELETE)["'`]/);
    // And exactly one outbound command is constructed: the reconciliation GET.
    const ghCalls = source.match(/run\("gh", \[[^\]]*\]/g) ?? [];
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toContain('"-X", "GET"');
    // ...and no daemon/hook machinery either: this is not the CLI in disguise.
    expect(source).not.toContain("ensureStopHook");
    expect(source).not.toContain("spawnDaemon");
    expect(source).not.toContain("createDaemon");
  });

  it("prints help whose example invocation is the file that is running", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(`node "${entry}"`);
    // Honest about the two classes of verb it ships.
    expect(help.stdout).toContain("Offline — these never open a network connection:");
    expect(help.stdout).toContain("Read-only GitHub");
    expect(help.stdout).toContain("reconcile");
    expect(help.stdout).toContain("Nothing here can submit a review.");
    // It must NOT send the operator to a CLI they do not have.
    expect(help.stdout).not.toContain("source checkout or npm install");
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

  it("a project with no sessions says so instead of answering with an empty list", () => {
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare, { recursive: true });
    const listed = spawnSync(process.execPath, [entry, "s_nothing"], {
      encoding: "utf-8", cwd: distRoot,
      env: { PATH: `${path.join(tmp, "bin")}:${process.env.PATH ?? ""}`, HOME: path.join(tmp, "home"), DEEPPAIRING_PROJECT_ROOT: bare },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(listed.status).toBe(1);
    expect(listed.stderr).toContain("no sessions at all");
    expect(listed.stdout).toBe("");
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
    const cases: Array<[string[], string]> = [
      // A traversal id is now rejected as a NAME (it matches no directory
      // entry) before the journal ever sees it; the journal's own id
      // validation stays as the second line of defence behind it.
      [["../escape"], 'No session "../escape" in this project'],
      [["s_operator", "wipe"], "review-posts failed"],
      [["s_operator", "cancel-reserved"], "review-posts failed"],
      [["s_operator", "list", "extra"], "review-posts failed"],
    ];
    for (const [args, expected] of cases) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain(expected);
      expect(result.stdout, args.join(" ")).toBe("");
    }
    expect(fs.readdirSync(sessionsDir)).toEqual(before);
    expect(ghInvocations()).toEqual([]);
  });

  it("an unknown session id is refused loudly, not answered with an empty list", () => {
    // The banner names the project; it does not tell you the SESSION was wrong.
    // `[]` + exit 0 for a typo reads exactly like "this session posted nothing",
    // which is the silence the banner exists to prevent one level up.
    const sessionsDir = path.join(projectRoot, ".deeppairing", "sessions");
    const listed = run(["s_typo"]);
    expect(listed.status).toBe(1);
    expect(listed.stdout).toBe("");
    expect(listed.stderr).toContain('No session "s_typo" in this project');
    expect(listed.stderr).toContain(sid);
    expect(fs.readdirSync(sessionsDir)).toEqual([sid]);
    expect(ghInvocations()).toEqual([]);
  });

  it("still recovers a session whose ARTIFACTS are corrupt — the check is the directory, not readability", () => {
    // The posting door gates on FileStore.listSessions (readable artifacts).
    // This tool must not: a session with a wedged journal and unreadable
    // artifacts is precisely the one an operator needs to reach.
    const { id } = seed("sending");
    fs.writeFileSync(path.join(projectRoot, ".deeppairing", "sessions", sid, "artifacts.json"), "{not json");
    const listed = run([sid]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)[0]).toMatchObject({ id, state: "sending" });
    const cancelled = run([sid, "cancel-reserved", id]);
    expect(cancelled.status).toBe(1); // sending, so still fenced — but reachable
    expect(run([sid, "inspect"]).status).toBe(0);
  });

  it("a session directory with no journal at all still answers, with an empty list", () => {
    const fresh = "s_fresh";
    fs.mkdirSync(path.join(projectRoot, ".deeppairing", "sessions", fresh), { recursive: true });
    const listed = run([fresh]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([]);
  });
});

/**
 * `reconcile` — the one verb that reads GitHub, driven end to end from the
 * plugin-only copy against the fake `gh`. Astra's #383 review: shipping the
 * offline verbs alone would have left an operator who FOUND the review on the
 * PR with only two moves, accept duplicate risk or install the source tree.
 * So the drain has to work here, and it has to stay read-only.
 */
describe("#344 — GET-only reconciliation, executed from the plugin-only copy", () => {
  const sha = "a".repeat(40);
  /** The payload the review on GitHub must reproduce exactly to be accepted. */
  const payload = {
    body: "Reviewed", event: "COMMENT" as const, commit_id: sha,
    comments: [{ path: "src/a.ts", body: "Fix the race", line: 3, side: "RIGHT" as const }],
  };
  const reconcilable: ReviewPostIdentity = {
    target, event: "COMMENT", reviewedHeadSha: sha,
    payloadDigest: reviewPostDigest(payload), authorizationDigest: "b".repeat(64),
  };

  /** Lay down the evidence the fake `gh` will serve for operation `id`. */
  function serve(id: string, overrides: { review?: Record<string, unknown>; comments?: unknown[] } = {}) {
    const review = {
      id: 7, body: payload.body + reviewPostMarker(id), html_url: `${target}#pullrequestreview-7`,
      commit_id: sha, state: "COMMENTED", submitted_at: "2026-09-05T12:01:00Z", ...overrides.review,
    };
    const comments = overrides.comments ?? [{
      id: 9, pull_request_review_id: 7, path: "src/a.ts", body: "Fix the race",
      side: "RIGHT", original_line: 3, original_commit_id: sha,
    }];
    fs.writeFileSync(path.join(ghDir, "review.json"), JSON.stringify(review));
    fs.writeFileSync(path.join(ghDir, "comments.json"), JSON.stringify(comments));
  }

  const state = () => new ReviewPostJournal(projectRoot, sid).list()[0]!;

  it("records a verified matching review, and every gh command is a GET", () => {
    const { id } = seed("unknown", reconcilable);
    serve(id);
    const reconciled = run([sid, "reconcile", id, "7"]);
    expect(reconciled.status).toBe(0);
    expect(reconciled.stdout).toContain(`Recorded verified review ${target}#pullrequestreview-7`);
    expect(reconciled.stdout).toContain("No review was posted by recovery");

    const op = state();
    expect(op.state).toBe("succeeded");
    expect(op.result).toMatchObject({ id: 7, htmlUrl: `${target}#pullrequestreview-7`, commitId: sha });

    // The review read plus its (single) comment page — every one a GET.
    const calls = ghInvocations();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call).toContain("-X GET");
      expect(call).not.toMatch(/\bPOST\b|--method|--input|-f |--field/);
      expect(call.startsWith("api repos/acme/widget/pulls/12/reviews/7")).toBe(true);
    }
  });

  it("leaves the operation blocked when the evidence is missing", () => {
    const { id } = seed("unknown", reconcilable);
    serve(id);
    fs.writeFileSync(path.join(ghDir, "exit-code"), "1");
    const refused = run([sid, "reconcile", id, "7"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("operation remains unresolved");
    expect(state().state).toBe("unknown");
    for (const call of ghInvocations()) expect(call).toContain("-X GET");
  });

  it("leaves the operation blocked when the evidence is malformed", () => {
    const { id } = seed("unknown", reconcilable);
    serve(id);
    fs.writeFileSync(path.join(ghDir, "review.json"), '{"id": 7, "body": ');
    const refused = run([sid, "reconcile", id, "7"]);
    expect(refused.status).toBe(1);
    expect(state().state).toBe("unknown");
  });

  it.each([
    ["a review carrying another operation's marker", { review: { body: `Reviewed${reviewPostMarker("cc2a05cd-d7da-4a1f-b7fb-1fabdd53dc73")}` } }],
    ["a review whose body was edited after posting", { review: { body: "Edited" } }],
    ["a review bound to a different commit", { review: { commit_id: "d".repeat(40) } }],
    ["a review on another repository", { review: { html_url: "https://github.com/wrong/repo/pull/12#pullrequestreview-7" } }],
    ["a verdict that is not the one reserved", { review: { state: "APPROVED" } }],
    ["inline comments that do not match the submission", { comments: [] }],
    ["an inline comment belonging to a different review", { comments: [{ id: 9, pull_request_review_id: 8, path: "src/a.ts", body: "Fix the race", side: "RIGHT", original_line: 3, original_commit_id: "a".repeat(40) }] }],
  ])("refuses mismatched evidence — %s — and keeps the operation blocked", (_label, overrides) => {
    const { id } = seed("unknown", reconcilable);
    serve(id, overrides as { review?: Record<string, unknown>; comments?: unknown[] });
    const refused = run([sid, "reconcile", id, "7"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("review-posts failed");
    expect(state().state).toBe("unknown");
    // Refusing is not sending: nothing but GETs went out.
    for (const call of ghInvocations()) expect(call).toContain("-X GET");
  });

  it("refuses to reconcile an operation that never reached a possible send", () => {
    const { id } = seed("reserved", reconcilable);
    serve(id);
    const refused = run([sid, "reconcile", id, "7"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("No matching possibly sent operation to reconcile");
    expect(state().state).toBe("reserved");
    // Refused before any network read.
    expect(ghInvocations()).toEqual([]);
  });

  it("refuses a malformed remote review id without contacting GitHub", () => {
    const { id } = seed("unknown", reconcilable);
    serve(id);
    for (const bad of ["0", "-1", "7.5", "07", "abc", "99999999999999999999"]) {
      const refused = run([sid, "reconcile", id, bad]);
      expect(refused.status, bad).toBe(1);
      expect(state().state).toBe("unknown");
    }
    expect(ghInvocations()).toEqual([]);
  });
}, 30_000);

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
