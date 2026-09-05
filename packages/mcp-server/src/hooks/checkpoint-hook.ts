/**
 * #342 — THE PostToolUse checkpoint hook.
 *
 * V2 — fires after every Write/Edit/MultiEdit and nags the agent into calling
 * present_code_change BEFORE the next edit. The threshold is 1 (deliberately
 * strict): the protocol says "before each Write/Edit", so the FIRST Write
 * without a preceding code_change is already a violation.
 *
 * #335 — coverage is a one-shot, file-scoped AND session-scoped RECEIPT rather
 * than a global "something was presented in the last minute" timestamp, so
 * presenting file A can no longer suppress the reminder for an unrelated edit
 * to file B. `file-store.ts` mints one receipt per presented file; this hook
 * atomically claims it (rename-then-read), so two concurrent hooks cannot both
 * consume one receipt and a newer presentation cannot be unlinked here.
 *
 * #342 — this used to be untyped JS text inside setup-tasks.ts's
 * CHECKPOINT_HOOK_SCRIPT, which retyped the lock/state machine and re-derived
 * the session id with an expression that mirrored `deriveSessionId` by hand.
 * Both are now imports, so the receipt READER and the receipt WRITER call the
 * same function.
 *
 * Non-blocking throughout: every path exits 0. A stdout message + exit 2 showed
 * Claude only an empty-stderr "blocking error" with no reason.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { deriveSessionId } from "../session-id.js";
import { appendHookFire, hookErrorMessage, hookStatePath, resolveHookProjectRoot } from "./hook-state.js";

const HOOK_NAME = "checkpoint";
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit"];
/** Legacy receipts without a store-owned expiry keep their original lifetime. */
const RECEIPT_TTL_MS = 60 * 1000;

// V2.1 — skip-list for files that are unambiguously NOT worth a per-edit
// checkpoint. Scope is deliberately narrow: only generated/vendored paths and
// auto-generated lockfiles. Config / policy files (.gitignore, package.json,
// .npmrc, .prettierrc) DO get nagged — those represent real decisions a paired
// human should react to.
const SKIP_BASENAMES = new Set([
  // Lockfiles only — manifest files (package.json, Cargo.toml, etc.) are
  // policy and should still nag.
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
]);
const SKIP_PATH_PREFIXES = [
  // Generated / vendored output — not human-authored source.
  "dist/",
  "build/",
  "node_modules/",
  ".deeppairing/",
  ".next/",
  ".turbo/",
  ".cache/",
  "coverage/",
  ".nyc_output/",
  // IDE-local config — workspace settings, not project decisions.
  ".vscode/",
  ".idea/",
];

export function isTrivialFile(filePath: string): boolean {
  if (!filePath || filePath === "(unknown)") return false;
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.split("/").pop() || "";
  if (SKIP_BASENAMES.has(base)) return true;
  // Match prefixes either at the start of the path or after the project root.
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (norm.includes("/" + prefix) || norm.startsWith(prefix)) return true;
  }
  return false;
}

const NAG =
  "deepPairing: {TOOL} on {FILE} with no present_code_change for it. Present EVERY " +
  "code change BEFORE the Write/Edit — including small follow-on edits, new files " +
  "(tests, configs), and each file of a multi-file change, not just the 'main' one. " +
  "A write straight to disk never reaches the human's review surface; they can't see " +
  "or comment on it. If you skipped this for prior edits this session, backfill them " +
  "now with present_code_change. (Per-Edit Checkpoint rule. Lockfiles and generated " +
  "paths are auto-skipped.)\n";

type CheckpointEvent = {
  cwd?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
  tool_input?: { file_path?: unknown; filePath?: unknown };
  input?: { file_path?: unknown };
};

/**
 * #335 — claim the receipt for `absolutePath` in `sessionId`, consuming it.
 *
 * Rename-then-read is the atomic test-and-set: whichever hook wins the rename
 * owns the receipt, and the loser sees ENOENT. The claim file is always
 * removed, so a rejected receipt (expired, future-dated, corrupt, mismatched)
 * is consumed rather than left to authorize a later edit.
 */
function claimReceipt(dpDir: string, sessionId: string, absolutePath: string, now: number): boolean {
  const key = crypto.createHash("sha256").update(absolutePath).digest("hex");
  const markerPath = path.join(dpDir, "sessions", sessionId, "code-checkpoints", key + ".json");
  const claimPath = markerPath + ".claim." + process.pid + "." + crypto.randomBytes(8).toString("hex");
  fs.renameSync(markerPath, claimPath);
  try {
    const m: unknown = JSON.parse(fs.readFileSync(claimPath, "utf8"));
    if (!m || typeof m !== "object") return false;
    const r = m as { version?: unknown; sessionId?: unknown; filePath?: unknown; artifactId?: unknown; at?: unknown; expiresAt?: unknown };
    const at = typeof r.at === "string" ? Date.parse(r.at) : NaN;
    // #359 (0867f45d): the store owns expiry, including longer changeset arcs.
    const expiresAt = r.expiresAt === undefined ? at + RECEIPT_TTL_MS
      : typeof r.expiresAt === "string" ? Date.parse(r.expiresAt) : NaN;
    return (
      r.version === 1 &&
      r.sessionId === sessionId &&
      r.filePath === absolutePath &&
      typeof r.artifactId === "string" &&
      r.artifactId.length > 0 &&
      Number.isFinite(at) &&
      Number.isFinite(expiresAt) &&
      expiresAt >= at &&
      now >= at && // a future-dated receipt is a clock fault, not coverage
      now <= expiresAt
    );
  } finally {
    try {
      fs.unlinkSync(claimPath);
    } catch {
      /* best-effort */
    }
  }
}

/** Runs the hook against one PostToolUse payload and exits. Never throws. */
export function runCheckpointHook(stdin: string, now: number = Date.now()): never {
  // Resolved from the environment first so the catch below can still record a
  // fire when the payload itself is unparseable; re-resolved with the event's
  // own cwd once we have one.
  let statePath = hookStatePath(resolveHookProjectRoot());
  let resolvedCandidateIds: string[] = [];
  function exit(code: number, reason: string): never {
    appendHookFire(statePath, { at: new Date().toISOString(), hook: HOOK_NAME, exitCode: code, reason, resolvedCandidateIds });
    process.exit(code);
  }

  try {
    // Deliberately unguarded: a payload that parses to `null` must reach the
    // catch below and record `error: Cannot read properties of null …`, which
    // is #333's regression contract and strictly more diagnostic than
    // reporting a normal `skip: tool=(unknown)` for a broken event.
    const ev: CheckpointEvent = stdin ? (JSON.parse(stdin) as CheckpointEvent) : {};
    const projectRoot = path.resolve(resolveHookProjectRoot(ev.cwd));
    statePath = hookStatePath(projectRoot);

    const tool = (typeof ev.tool_name === "string" && ev.tool_name) || (typeof ev.toolName === "string" && ev.toolName) || "";
    if (!EDIT_TOOLS.includes(tool)) exit(0, "skip: tool=" + (tool || "(unknown)"));

    const rawFilePath =
      (ev.tool_input && (ev.tool_input.file_path ?? ev.tool_input.filePath)) ?? (ev.input && ev.input.file_path);
    const filePath = typeof rawFilePath === "string" && rawFilePath ? rawFilePath : "(unknown)";

    // V2.1 — trivial files (lockfiles, generated paths) auto-pass.
    if (isTrivialFile(filePath)) exit(0, "skip: trivial file " + filePath);

    const dpDir = path.join(projectRoot, ".deeppairing");
    if (!fs.existsSync(path.join(dpDir, "sessions"))) exit(0, "skip: no sessions dir");

    // #359 (0867f45d) compatibility: event identity is first, inherited session
    // lineage second. Resolve only these candidates, never scan other sessions.
    // Keep #342's canonical derivation import instead of reviving a JS twin.
    const eventHasIdentity = Object.prototype.hasOwnProperty.call(ev, "session_id");
    const malformedEventIdentity = eventHasIdentity && ev.session_id !== "" && typeof ev.session_id !== "string";
    const rawCandidates = [ev.session_id, process.env.CLAUDE_CODE_SESSION_ID];
    const anyNonemptyIdentity = rawCandidates.some(value => typeof value === "string" && value.length > 0);
    for (const raw of rawCandidates) {
      if (typeof raw !== "string" || !raw) continue;
      const derived = deriveSessionId(projectRoot, raw);
      // An identity sanitized to empty must not claim the legacy fallback.
      if (derived.mode !== "split") continue;
      if (!resolvedCandidateIds.includes(derived.sessionId)) resolvedCandidateIds.push(derived.sessionId);
    }
    if (resolvedCandidateIds.length === 0 && !anyNonemptyIdentity && !malformedEventIdentity) {
      resolvedCandidateIds = [deriveSessionId(projectRoot, "").sessionId];
    }

    let covered = false;
    if (filePath !== "(unknown)" && filePath.trim()) {
      for (const sessionId of resolvedCandidateIds) {
        try {
          covered = claimReceipt(dpDir, sessionId, path.resolve(projectRoot, filePath), now);
        } catch {
          /* missing/corrupt receipt: try the next known lineage candidate */
        }
        if (covered) break; // Consume only the first valid receipt.
      }
    }

    if (!covered) {
      process.stderr.write(NAG.replace("{TOOL}", tool).replace("{FILE}", filePath));
      exit(0, "nag: " + tool + " on " + filePath);
    }
    exit(0, "pass: fresh checkpoint covers " + filePath);
  } catch (err) {
    // Never block the agent on a hook bug. Exit 0 on any unexpected error.
    exit(0, "error: " + hookErrorMessage(err));
  }
}
