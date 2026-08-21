/**
 * deepPairing PreToolUse preflight hook — plugin-bundled entry (I6).
 *
 * A faithful semantic port of setup-tasks.ts preflightHookScript so the
 * marketplace / `--plugin-dir` install ships the SAME WP5 rejected-approach
 * gate the `init` path wires into .claude/settings.local.json. esbuild inlines
 * evaluatePreflightHook (and the shared matcher it wraps) so this file is fully
 * self-contained; the plugin's hooks/hooks.json invokes it as
 * `node "${CLAUDE_PLUGIN_ROOT}/server/preflight.mjs"` with matcher
 * Write|Edit|MultiEdit.
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
 *   - FAIL OPEN on any error so a broken hook can never block the user's edits.
 */
import fs from "node:fs";
import path from "node:path";
// F11 — one writer for the whole preflight lane: recordHookFire appends the
// capped `fires` entry AND stamps the guardrail dedup record in a single
// read-modify-write, in the core, so the two hand-maintained hook copies can't
// drift on the write shape. (This entry's own recordFire is gone.)
import { evaluatePreflightHook, recordHookFire, toolInputTargetsGuardrail } from "./preflight-hook-core.js";

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
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.env.DEEPPAIRING_PROJECT_ROOT || ev.cwd || process.cwd();
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") {
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
    if (!ledgersPresent(projectRoot) && !toolInputTargetsGuardrail(projectRoot, toolInput)) {
      process.exit(0); // nothing to match against — skip the matcher
    }
    const decision = evaluatePreflightHook({ toolName, toolInput, projectRoot });
    if (decision && decision.fire) {
      recordHookFire(projectRoot, decision);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason:
              decision.reason || "This change matches a previously-rejected approach.",
          },
        }),
      );
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
