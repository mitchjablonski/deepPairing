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
 *     path can't be a guardrail path (P1 — the guardrail backstop has no ledger
 *     to be seeded, so it needs its own zero-I/O prefilter here);
 *   - a match surfaces to the HUMAN as permissionDecision "ask" (recoverable
 *     pairing) rather than a hard deny — raw file content is noisier than the
 *     agent's prose, and an already-approved change must not be auto-blocked;
 *   - FAIL OPEN on any error so a broken hook can never block the user's edits.
 */
import fs from "node:fs";
import path from "node:path";
import { evaluatePreflightHook, looksLikeGuardrailPath } from "./preflight-hook-core.js";

function recordFire(root: string, reason: string): void {
  try {
    const sp = path.join(root, ".deeppairing", "hooks-state.json");
    let s: { version?: number; fires?: unknown[] } = { version: 1, fires: [] };
    if (fs.existsSync(sp)) {
      try {
        s = JSON.parse(fs.readFileSync(sp, "utf-8"));
      } catch {
        /* fresh file */
      }
    }
    const fires = Array.isArray(s.fires) ? s.fires : [];
    fires.push({ at: new Date().toISOString(), hook: "preflight", reason });
    s.fires = fires.slice(-50);
    s.version = 1;
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify(s));
  } catch {
    /* recording must never fail the hook itself */
  }
}

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
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
    if (toolName !== "Edit" && toolName !== "Write" && toolName !== "MultiEdit") {
      process.exit(0);
    }
    // P1 — the fast path now has TWO reasons to keep going: a seeded ledger
    // (the rejected-approach matcher) OR a path that could be a guardrail (the
    // backstop). looksLikeGuardrailPath is a single regex test against the
    // file path — no I/O — so a non-guardrail edit in a ledger-free project
    // still exits here, exactly as before.
    if (!ledgersPresent(projectRoot) && !looksLikeGuardrailPath(toolInput)) {
      process.exit(0); // nothing to match against — skip the matcher
    }
    const decision = evaluatePreflightHook({ toolName, toolInput, projectRoot });
    if (decision && decision.deny) {
      recordFire(projectRoot, decision.source || "blocked");
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
