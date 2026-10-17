/**
 * deepPairing PreToolUse preflight hook — plugin-bundled entry (I6).
 *
 * A faithful semantic port of setup-tasks.ts preflightHookScript so the
 * marketplace / `--plugin-dir` install ships the SAME WP5 rejected-approach
 * gate the `init` path wires into .claude/settings.local.json. esbuild inlines
 * evaluatePreflightHook (and the shared matcher it wraps) so this file is fully
 * self-contained; the plugin's hooks/hooks.json invokes it as
 * `node "${CLAUDE_PLUGIN_ROOT}/server/preflight.mjs"` with matcher
 * Write|Edit|MultiEdit|NotebookEdit (#470 slice 4: NotebookEdit for the
 * deeppairing-state class only).
 *
 * Contract, identical to the init-path script:
 *   - only Edit/Write/MultiEdit are considered; anything else exits 0;
 *   - a cheap ledger pre-check skips the matcher when nothing is seeded AND the
 *     path is not a guardrail path (P1 — the guardrail backstop has no ledger to
 *     be seeded, so the ledger check alone would hide it entirely). Q1 — that
 *     second test is now the AUTHORITATIVE matcher, not a hand-written "loose
 *     superset" regex that drifted out of superset-hood;
 *   - a match surfaces to the HUMAN as permissionDecision "ask" (recoverable
 *     pairing) rather than a hard deny — raw file content is noisier than the
 *     agent's prose, and an already-approved change must not be auto-blocked;
 *   - explicit DEEPPAIRING_PREFLIGHT_MODE=strict-stop instead denies a match
 *     and stops continuation with a visible reason (#544 compatibility mode);
 *   - FAIL OPEN on any error so a broken hook can never block the user's edits.
 */
import fs from "node:fs";
import path from "node:path";
// F11 — one writer for the whole preflight lane: recordHookFire appends the
// capped `fires` entry AND stamps the guardrail dedup record in a single
// read-modify-write, in the core, so the two hand-maintained hook copies can't
// drift on the write shape. (This entry's own recordFire is gone.)
import { resolveHookRoots } from "../git-worktree.js";
import { evaluatePreflightHook, preflightHookOutput, recordHookFire, resolvePreflightMode, toolInputTargetsDeeppairingState, toolInputTargetsGuardrail } from "./preflight-hook-core.js";

/** PP1 — cheap pre-check so the common case (no rejections, no team.json) skips
 *  the matcher entirely. Reading the small preferences.json is ms. */
function ledgersPresent(root: string): boolean {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(root, ".deeppairing", "preferences.json"), "utf-8"));
    if (Array.isArray(prefs?.rejectedApproaches) && prefs.rejectedApproaches.length > 0) return true;
  } catch {
    /* no preferences file yet */
  }
  try {
    if (fs.existsSync(path.join(root, ".deeppairing", "team.json"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (d) => {
  input += d;
});
process.stdin.on("end", () => {
  try {
    const ev = JSON.parse(input || "{}");
    const toolName = ev.tool_name || "";
    const toolInput = ev.tool_input || ev.input || {};
    // R1 (#279) — one documented precedence in every hook lane:
    // CLAUDE_PROJECT_DIR > DEEPPAIRING_PROJECT_ROOT > the event's cwd > ours.
    // #532 — canonicalised to the main checkout inside a git linked worktree,
    // so a worktree agent is gated by the SAME ledger (not an empty one).
    const roots = resolveHookRoots(ev.cwd);
    const projectRoot = roots.projectRoot;
    // #536 review — a worktree link that failed validation is NOT followed; say so.
    if (roots.rejected) process.stderr.write("[deepPairing] git worktree link not honoured: " + roots.rejected + "\n");
    // #470 slice 4 — NotebookEdit is matched too, for the deeppairing-state class only.
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit" && toolName !== "NotebookEdit") {
      process.exit(0);
    }
    // P1 — the fast path has TWO reasons to keep going: a seeded ledger (the
    // rejected-approach matcher) OR a guardrail path (the backstop). Q1 —
    // toolInputTargetsGuardrail IS matchGuardrailPath, the same function
    // evaluateGuardrailBackstop uses, so the early exit can no longer disagree
    // with the gate it guards. It is still I/O-free (two path calls + a handful
    // of regex tests; measured at ~0.003 ms on a miss), and the whole matcher
    // core is already inlined into this bundle by esbuild, so it costs nothing
    // extra here.
    if (
      !ledgersPresent(projectRoot) &&
      !toolInputTargetsGuardrail(projectRoot, toolInput) &&
      !toolInputTargetsDeeppairingState(projectRoot, toolInput)
    ) {
      process.exit(0); // nothing to match against — skip the matcher
    }
    const config = resolvePreflightMode(process.env.DEEPPAIRING_PREFLIGHT_MODE);
    const decision = evaluatePreflightHook({ toolName, toolInput, projectRoot, mode: config.mode });
    if (decision && decision.fire) {
      recordHookFire(projectRoot, decision, undefined, config.mode);
      process.stdout.write(JSON.stringify(preflightHookOutput(decision, config)));
    }
    // no match = exit 0 with no decision JSON (tool proceeds)
    process.exit(0);
  } catch (err) {
    // FAIL OPEN — a broken hook must never block the user's edits.
    try {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write("[deepPairing] preflight hook error: " + msg + "\n");
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
});
