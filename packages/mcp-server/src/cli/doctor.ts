import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { MAX_PORT_ATTEMPTS, probeDaemonIdentity, evictDaemon, daemonAuthHeaders, describeDaemonVersionHealth } from "../daemon/lifecycle.js";
import { SERVER_VERSION } from "../version.js";
import { preferredPortFor, BASE_PORT, PORT_SPAN } from "../project-root.js";
import { getGlobalStore } from "../store/global-store.js";
import { buildLedgerHealthReport, shQuote } from "../store/ledger-health.js";
import { cliInvocation } from "../cli-invocation.js";
import { errorMessage } from "@deeppairing/shared";
import { checkClock } from "./clock-check.js";
import { ensureGitignoreEntry, ensureStopHook, ensureCheckpointHook, ensurePreflightHook, ensureStanceAllowAskHook, HOOK_MARKERS, detectCrossScopeDpEntries, cleanDpEntriesFromScope, isPluginManaged, diagnoseLocalHooks, diagnoseStanceAllowAskHook, removeStanceAllowAskHook } from "./setup-tasks.js";
import { inspectLocks, clearDeadLockFile } from "../store/file-lock.js";

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}
function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}
function yellow(text: string): string {
  return `\x1b[33m${text}\x1b[0m`;
}
function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}
function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

/**
 * `deeppairing doctor [--fix] [--yes]` — one-shot diagnostic that can also
 * heal the most common failure modes. Prints daemon PID/port, daemon.json
 * state, /api/state response, and a log tail. With --fix, collects a list
 * of healing actions and (after confirmation, unless --yes) applies them.
 */
export async function doctor(cwd: string, opts: { fix?: boolean; yes?: boolean; protectSharedScopes?: boolean; pluginManaged?: boolean } = {}) {
  console.log(bold("\n  deepPairing doctor\n"));

  const dpDir = path.join(cwd, ".deeppairing");
  const infoFile = path.join(dpDir, "daemon.json");
  const logFile = path.join(dpDir, "daemon.log");

  /** Healing actions the user can opt into via --fix. Collected during
   *  diagnosis; applied at the end with confirmation. */
  // AA3 — fix descriptors gain `requiresExplicitConfirmation`. Some
  // doctor fixes have cross-project blast radius (e.g. signaling another
  // project's daemon to evict the port); --yes mode SKIPS them so an
  // unattended run can't trigger friendly fire. The user has to re-run
  // interactively to apply such fixes.
  const fixes: Array<{
    label: string;
    apply: () => { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
    requiresExplicitConfirmation?: boolean;
  }> = [];

  // 1. daemon.json
  let info: { pid?: number; port?: number; startedAt?: string } | null = null;
  if (fs.existsSync(infoFile)) {
    try {
      info = JSON.parse(fs.readFileSync(infoFile, "utf-8"));
      console.log(`  ${green("✓")} .deeppairing/daemon.json present`);
      console.log(`    ${dim("pid:")}       ${info?.pid ?? "?"}`);
      console.log(`    ${dim("port:")}      ${info?.port ?? "?"}`);
      console.log(`    ${dim("startedAt:")} ${info?.startedAt ?? "?"}`);
    } catch (err) {
      console.log(`  ${red("✗")} .deeppairing/daemon.json is malformed: ${err}`);
      fixes.push({
        label: "Delete malformed .deeppairing/daemon.json",
        apply: () => {
          try { fs.unlinkSync(infoFile); return { ok: true, message: "Deleted" }; }
          catch (e) { return { ok: false, message: errorMessage(e) }; }
        },
      });
    }
  } else {
    console.log(`  ${yellow("!")} .deeppairing/daemon.json missing`);
  }

  // 2. PID liveness
  if (info?.pid) {
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch {}
    console.log(`  ${alive ? green("✓") : red("✗")} PID ${info.pid} is ${alive ? "alive" : "not running"}`);
    if (!alive) {
      fixes.push({
        label: `Remove stale daemon.json (PID ${info.pid} is dead)`,
        apply: () => {
          try { fs.unlinkSync(infoFile); return { ok: true, message: "Removed" }; }
          catch (e) { return { ok: false, message: errorMessage(e) }; }
        },
      });
    }
  }

  // 3. Probe /api/state on the reported port. If daemon.json is missing,
  //    sweep the candidate range to find a daemon that belongs to us.
  let port = info?.port;
  if (!port) {
    // Sweep from THIS project's deterministic preferred port with the SAME
    // wrap-around the daemon uses when binding (daemon/index.ts:
    // BASE_PORT + ((preferred - BASE_PORT + attempt) % PORT_SPAN)). The old
    // `DEFAULT_PORT + attempt` only probed 3847-3856; and a linear
    // `preferred + attempt` (review catch) walked OFF the reserved range for
    // projects hashing into the last ~10 slots, missing a daemon that had
    // wrapped to 3847+.
    const preferred = preferredPortFor(cwd);
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const candidate = BASE_PORT + ((preferred - BASE_PORT + attempt) % PORT_SPAN);
      const identity = await probeDaemonIdentity(candidate);
      if (identity && identity.projectRoot === cwd) {
        port = candidate;
        console.log(`  ${green("✓")} Swept ports; found this project's daemon on :${candidate}`);
        break;
      }
    }
    if (!port) port = preferred; // fall through and report the failed probe
  }

  // Z5b / AA3 — project-mismatch remediation. When the wrapper hits
  // Y3''s 403 ("Daemon project mismatch"), the user sees the error in
  // MCP stderr and runs doctor expecting a fix.
  //
  // AA3 hardens this against the cross-project foot-cannon Z5b's
  // SIGTERM created. New apply path:
  //   1. Re-probe the daemon to confirm pid + projectRoot are unchanged
  //      from diagnosis time. PID may have been reused by an unrelated
  //      OS process; abort the kill if anything drifted.
  //   2. Try cooperative shutdown via /api/evict — daemon flushes
  //      metrics, broadcasts daemon_evicting to the OTHER project's UI
  //      (no silent disconnect), and exits cleanly.
  //   3. SIGTERM only as a fallback when evict fails. Branch on Windows
  //      where Node ignores the signal name and SIGTERM is silently
  //      SIGKILL — surface the platform delta in the user-facing copy
  //      instead of misleading "gentler than SIGKILL".
  //   4. Mark requiresExplicitConfirmation so --yes mode skips it.
  //      Cross-project actions never fire unattended.
  try {
    const squatter = await probeDaemonIdentity(port);
    if (squatter && squatter.projectRoot && squatter.projectRoot !== cwd) {
      console.log(
        `  ${red("✗")} Daemon on :${port} serves a different project: ` +
        `${squatter.projectRoot} (PID ${squatter.pid})`,
      );
      console.log(
        `    ${dim("This is the Y3' project_mismatch case — your wrapper would 403 on register.")}`,
      );
      const expectedPid = squatter.pid;
      const expectedProject = squatter.projectRoot;
      fixes.push({
        label: `Ask daemon (PID ${expectedPid}, project ${expectedProject}) to release port ${port}`,
        requiresExplicitConfirmation: true,
        apply: async () => {
          // AA3 — re-probe to confirm nothing drifted between diagnosis
          // and apply. If the daemon died (and the OS recycled the pid)
          // or another daemon claimed the port, abort.
          const reprobe = await probeDaemonIdentity(port);
          if (!reprobe) {
            return { ok: true, message: `Port ${port} is now free; nothing to do.` };
          }
          if (reprobe.pid !== expectedPid || reprobe.projectRoot !== expectedProject) {
            return {
              ok: false,
              message:
                `Daemon on :${port} changed since diagnosis ` +
                `(was PID ${expectedPid} for ${expectedProject}, now PID ${reprobe.pid} for ${reprobe.projectRoot}). ` +
                `Refusing to act on stale info; re-run doctor.`,
            };
          }
          // Cooperative shutdown first.
          const result = await evictDaemon(port, expectedPid);
          if (result === "evicted") {
            return {
              ok: true,
              message: `Daemon for ${expectedProject} evicted cleanly. Restart Claude Code in this project to bind.`,
            };
          }
          if (result === "pid_mismatch" || result === "no_daemon") {
            return {
              ok: true,
              message: `Port ${port} is no longer held by PID ${expectedPid}; nothing to do.`,
            };
          }
          // Cooperative path failed — fall back to a signal. Cross-platform
          // note: on Windows Node ignores the signal name and process.kill
          // is unconditional termination (no graceful cleanup runs). Tell
          // the user.
          // M3 (#221) — loud pre-signal forensics: name the exact target (pid,
          // port, projectRoot) and reason BEFORE any signal, so a "daemon died"
          // incident is diagnosable from the log alone. This is a user-confirmed
          // cross-project eviction (requiresExplicitConfirmation), and the pid +
          // projectRoot were re-confirmed at the top of apply().
          console.log(
            `  ${dim("[deepPairing] doctor: signalling foreign daemon PID")} ${expectedPid} ${dim("on :")}${port} ${dim("(project")} ${expectedProject}${dim(") — cooperative evict refused; user-confirmed fallback.")}`,
          );
          if (process.platform === "win32") {
            try {
              process.kill(expectedPid);
              return {
                ok: true,
                message: `Force-killed PID ${expectedPid} (Windows has no SIGTERM equivalent — daemon couldn't flush). Restart Claude Code.`,
              };
            } catch (err) {
              return {
                ok: false,
                message:
                  `Could not signal PID ${expectedPid}: ${errorMessage(err)}. ` +
                  `Try Task Manager / taskkill /PID ${expectedPid}.`,
              };
            }
          }
          try {
            process.kill(expectedPid, "SIGTERM");
            return {
              ok: true,
              message:
                `Cooperative evict refused; sent SIGTERM to PID ${expectedPid}. ` +
                `Restart Claude Code in this project to spawn a fresh daemon.`,
            };
          } catch (err) {
            return {
              ok: false,
              message:
                `Could not signal PID ${expectedPid}: ${errorMessage(err)}. ` +
                `The other project's daemon may have died already; try restarting Claude Code.`,
            };
          }
        },
      });
    }
  } catch {
    // probeDaemonIdentity already swallows network errors; nothing to do.
  }

  // #136 — stale-daemon detection. When the daemon on this port serves OUR
  // project but is running an OLDER version than the installed plugin, a plugin
  // update silently left the old process running — it keeps serving pre-fix
  // behavior until restarted. Report it, and (with --fix) offer to SIGTERM it
  // so the next Claude Code session spawns a fresh daemon on the new code.
  try {
    const mine = await probeDaemonIdentity(port);
    if (mine && mine.projectRoot === cwd) {
      const health = describeDaemonVersionHealth(mine.version, SERVER_VERSION);
      if (health.stale) {
        console.log(`  ${red("✗")} Stale daemon: ${health.message}`);
        const expectedPid = mine.pid;
        fixes.push({
          label: `Restart stale daemon (PID ${expectedPid}, running ${mine.version ? "v" + mine.version : "unversioned"} < plugin v${SERVER_VERSION})`,
          requiresExplicitConfirmation: opts.protectSharedScopes,
          apply: async () => {
            // Re-confirm identity so we never signal a recycled pid or a daemon
            // that changed under us between diagnosis and apply.
            const reprobe = await probeDaemonIdentity(port);
            if (!reprobe) {
              return { ok: true, message: `Port ${port} is now free; nothing to do.` };
            }
            if (reprobe.pid !== expectedPid || reprobe.projectRoot !== cwd) {
              return {
                ok: false,
                message: `Daemon on :${port} changed since diagnosis (now PID ${reprobe.pid} for ${reprobe.projectRoot}). Re-run doctor.`,
              };
            }
            // SIGTERM → graceful flush + port release (no data loss). On Windows
            // Node has no SIGTERM equivalent; process.kill is unconditional.
            // M3 (#221) — loud pre-signal forensics. Target is HTTP-reconfirmed
            // as OURS (pid + projectRoot === cwd) directly above.
            console.log(
              `  ${dim("[deepPairing] doctor: restarting stale daemon PID")} ${expectedPid} ${dim("on :")}${port} ${dim("(this project")} ${cwd}${dim(") — running")} ${mine.version ? "v" + mine.version : "unversioned"} ${dim("< plugin v")}${SERVER_VERSION}${dim("; sending SIGTERM.")}`,
            );
            try {
              process.kill(expectedPid, process.platform === "win32" ? undefined : "SIGTERM");
              return {
                ok: true,
                message:
                  process.platform === "win32"
                    ? `Force-terminated PID ${expectedPid} (Windows has no SIGTERM). Restart Claude Code to spawn a fresh daemon on v${SERVER_VERSION}.`
                    : `Sent SIGTERM to PID ${expectedPid}; it flushes + exits. Restart Claude Code to spawn a fresh daemon on v${SERVER_VERSION}.`,
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { ok: false, message: `Could not signal PID ${expectedPid}: ${msg}` };
            }
          },
        });
      } else if (health.verdict === "newer") {
        console.log(`  ${dim("·")} ${health.message}`);
      }
    }
  } catch {
    // probe already swallows network errors; a version check is best-effort.
  }

  let probeOk = false;
  // III9 follow-up — a non-200 HTTP response still means the port is ALIVE.
  // Distinguishing that from a refused connection is what stops doctor from
  // recommending the destructive kill+rm on a working-but-auth-gated daemon.
  let probeReachable = false;
  let probeStatus: number | string = "no-response";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    // III9 follow-up — /api/state is gated by the AA4 X-Project-Hash
    // middleware (no longer a public route). Probe WITH the daemon auth
    // headers so a healthy secured daemon returns 200 instead of a 403 we'd
    // misread as "not responding".
    const res = await fetch(`http://localhost:${port}/api/state`, {
      signal: controller.signal,
      headers: daemonAuthHeaders(cwd),
    });
    clearTimeout(timer);
    probeReachable = true;
    probeStatus = res.status;
    probeOk = res.ok;
  } catch (err) {
    probeStatus = errorMessage(err);
  }
  console.log(`  ${probeOk ? green("✓") : probeReachable ? yellow("!") : red("✗")} GET http://localhost:${port}/api/state → ${probeStatus}`);

  // 4. Active sessions
  if (probeOk) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://localhost:${port}/api/active-sessions`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data: any = await res.json();
        const list: any[] = data.sessions ?? [];
        console.log(`  ${green("✓")} Active sessions: ${list.length}`);
        for (const s of list) {
          console.log(`    ${dim("-")} ${s.sessionId} ${dim(`(${s.artifactCount} artifacts, ${s.title})`)}`);
        }
      }
    } catch {}
  }

  // 5. Log tail
  // III9 — reconcile the verdict against fatal daemon deaths recorded in the
  // log. A leftover/older daemon answering /api/state can make the verdict
  // read "healthy" while every freshly-spawned daemon dies (the pre-III9
  // insecure-mode throw on a WSL /mnt/c v9fs mount is the canonical case).
  // Surface that instead of masking it behind a stale "healthy".
  let daemonFatalHint: string | null = null;
  if (fs.existsSync(logFile)) {
    try {
      const content = fs.readFileSync(logFile, "utf-8");
      const allLines = content.trim().split("\n");
      const lines = allLines.slice(-10);
      console.log(`\n  ${bold("Log tail")} ${dim("(last 10 lines of .deeppairing/daemon.log):")}`);
      for (const line of lines) console.log(`  ${dim(line)}`);

      const insecureModeDeaths = allLines.filter(
        (l) => l.includes("writeDaemonInfo failed") || l.includes("insecure mode"),
      ).length;
      if (insecureModeDeaths > 0) {
        daemonFatalHint =
          `${insecureModeDeaths} fatal daemon death${insecureModeDeaths === 1 ? "" : "s"} from an insecure-mode token write — ` +
          `this project's .deeppairing/ is on a filesystem that ignores chmod (WSL /mnt/c v9fs, NFS, or SMB). ` +
          `Upgrade to a deepPairing build with the token-relocation fix (III9), or move the repo onto a local Linux filesystem. ` +
          `Note: DEEPPAIRING_PROJECT_ROOT does NOT help under Claude Code — CLAUDE_PROJECT_DIR outranks it.`;
      }
    } catch (err) {
      console.log(`  ${red("✗")} Could not read daemon.log: ${err}`);
    }
  } else {
    console.log(`  ${yellow("!")} No daemon.log found`);
  }

  // 5b. #500 — system clock health (warning only; a host setting, no --fix).
  {
    const clock = await checkClock();
    if (clock.ok) {
      console.log(`  ${green("✓")} System clock is steady`);
    } else {
      const [head, ...rest] = clock.messageLines;
      console.log(`  ${yellow("!")} ${head}`);
      for (const l of rest) console.log(`    ${dim(l)}`);
    }
  }

  // 6. Project-setup checks (.gitignore + Stop hook). These catch the
  //    "plugin install half-configured this project" failure mode.
  const gitignorePath = path.join(cwd, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.includes(".deeppairing/") || content.includes(".deeppairing")) {
      console.log(`  ${green("✓")} .gitignore lists .deeppairing/`);
    } else {
      console.log(`  ${yellow("!")} .gitignore does NOT list .deeppairing/`);
      fixes.push({
        label: "Append .deeppairing/ to .gitignore",
        apply: () => {
          const r = ensureGitignoreEntry(cwd);
          return { ok: r.ok, message: r.message };
        },
      });
    }
  } else {
    console.log(`  ${dim("·")} No .gitignore in this directory (skipping that check)`);
  }

  // 6a. Hook reconciliation (#196). The three deepPairing hooks normally live
  // in .claude/settings.local.json — EXCEPT under the plugin, which declares
  // Stop + PreToolUse NATIVELY (hooks/hooks.json). Claude Code doesn't dedupe
  // across sources, so a project-local copy of a plugin-provided hook fires a
  // SECOND time on every event (the exact double-fire INSTALL.md points here to
  // clean). diagnoseLocalHooks encodes that per-mode truth; we turn each
  // verdict into a report line and — with --fix — a heal. Static imports keep
  // the shipped entry free of esbuild lazy initializers (the #437 boot class).
  const hookLocalPath = path.join(cwd, ".claude", "settings.local.json");
  const pluginManaged = opts.pluginManaged ?? isPluginManaged();
  const hookState: Record<string, string> = {};
  for (const d of diagnoseLocalHooks(cwd, pluginManaged)) hookState[d.hook] = d.state;

  // Stop hook.
  switch (hookState.Stop) {
    case "ok":
      console.log(`  ${green("✓")} Claude Code Stop hook ${pluginManaged ? "provided by the plugin" : "configured"}`);
      break;
    case "legacy":
      console.log(`  ${yellow("!")} Claude Code Stop hook uses the legacy flat shape (Claude Code warns "Invalid settings / hooks: Expected array")`);
      fixes.push({
        label: "Replace legacy Stop-hook entry with the correct nested shape",
        // ensureStopHook heals legacy entries before re-installing.
        apply: () => { const r = ensureStopHook(cwd); return { ok: r.ok, message: r.message }; },
      });
      break;
    case "redundant":
      console.log(`  ${yellow("!")} Stop hook is duplicated in settings.local.json — the plugin already provides it, so BOTH fire on every stop`);
      fixes.push({
        label: "Remove the redundant project-local Stop hook (the plugin provides it natively)",
        apply: () => { const r = cleanDpEntriesFromScope(hookLocalPath, "Stop", HOOK_MARKERS.Stop); return { ok: r.ok, message: r.message }; },
      });
      break;
    default: // "missing"
      console.log(`  ${yellow("!")} Claude Code Stop hook NOT configured (agent can stop while artifacts are unreviewed)`);
      fixes.push({
        label: "Add Stop hook to .claude/settings.local.json",
        apply: () => { const r = ensureStopHook(cwd); return { ok: r.ok, message: r.message }; },
      });
  }

  // PostToolUse checkpoint hook — no plugin equivalent, so it belongs in
  // settings.local.json in EVERY mode.
  if (hookState.PostToolUse === "ok") {
    console.log(`  ${green("✓")} Claude Code per-edit checkpoint hook configured`);
  } else {
    console.log(`  ${yellow("!")} Per-edit checkpoint hook NOT configured (agent can batch Write/Edit without present_code_change)`);
    fixes.push({
      label: "Add PostToolUse checkpoint hook to .claude/settings.local.json",
      apply: () => { const r = ensureCheckpointHook(cwd); return { ok: r.ok, message: r.message }; },
    });
  }

  // PreToolUse rejection-gate hook (#196 — doctor did NOT check this before,
  // so a missing gate went unreported and a plugin+init double-install was
  // never offered a fix even though the redundant row now fires on every edit).
  switch (hookState.PreToolUse) {
    case "ok":
      console.log(`  ${green("✓")} PreToolUse rejection-gate hook ${pluginManaged ? "provided by the plugin" : "configured"}`);
      break;
    case "redundant":
      console.log(`  ${yellow("!")} PreToolUse rejection-gate hook is duplicated in settings.local.json — the plugin already provides it, so BOTH fire on every Write/Edit`);
      fixes.push({
        label: "Remove the redundant project-local PreToolUse rejection-gate hook (the plugin provides it natively)",
        apply: () => { const r = cleanDpEntriesFromScope(hookLocalPath, "PreToolUse", HOOK_MARKERS.PreToolUse); return { ok: r.ok, message: r.message }; },
      });
      break;
    case "legacy":
      console.log(`  ${yellow("!")} PreToolUse rejection-gate hook is an older install that doesn't cover NotebookEdit (edits to deepPairing's own state through a notebook won't ask)`);
      fixes.push({
        label: "Update the PreToolUse rejection-gate hook in .claude/settings.local.json",
        apply: () => { const r = ensurePreflightHook(cwd); return { ok: r.ok, message: r.message }; },
      });
      break;
    default: // "missing"
      console.log(`  ${yellow("!")} PreToolUse rejection-gate hook NOT configured (rejected concepts won't be blocked before the edit lands)`);
      fixes.push({
        label: "Add PreToolUse rejection-gate hook to .claude/settings.local.json",
        apply: () => { const r = ensurePreflightHook(cwd); return { ok: r.ok, message: r.message }; },
      });
  }

  // #470 / #503 review — the narrow Bash `stance allow` ask row.
  {
    switch (diagnoseStanceAllowAskHook(cwd, pluginManaged)) {
      case "ok":
        console.log(`  ${green("✓")} Bash \`stance allow\` ask hook ${pluginManaged ? "provided by the plugin" : "configured"}`);
        break;
      case "redundant":
        console.log(`  ${yellow("!")} Bash \`stance allow\` ask hook is duplicated in settings.local.json — the plugin already provides it`);
        fixes.push({
          label: "Remove the redundant project-local Bash ask hook (the plugin provides it natively)",
          apply: () => { const r = removeStanceAllowAskHook(cwd); return { ok: r.ok, message: r.message }; },
        });
        break;
      default:
        console.log(`  ${yellow("!")} Bash \`stance allow\` ask hook NOT configured (the agent's shell could run \`stance allow\` without a prompt)`);
        fixes.push({
          label: "Add the Bash `stance allow` ask hook to .claude/settings.local.json",
          apply: () => { const r = ensureStanceAllowAskHook(cwd); return { ok: r.ok, message: r.message }; },
        });
    }
  }

  // X2 — cross-scope hook detection. Even with the canonical entry in
  // .local, deepPairing rows may linger in user-level (~/.claude/settings.json)
  // or project-shared (.claude/settings.json) — leftover from earlier
  // installs. Claude Code merges them in and runs both → "Ran 2 stop hooks."
  // We only auto-clean when --fix is passed, since these scopes might
  // contain other intentional hooks. (Helpers imported with diagnoseLocalHooks
  // above.)
  const crossScopeStop = detectCrossScopeDpEntries(cwd, "Stop", HOOK_MARKERS.Stop)
    .filter((s) => s.scope !== "project-local" && s.count > 0);
  const crossScopeCheckpoint = detectCrossScopeDpEntries(cwd, "PostToolUse", HOOK_MARKERS.PostToolUse)
    .filter((s) => s.scope !== "project-local" && s.count > 0);
  if (crossScopeStop.length > 0) {
    const total = crossScopeStop.reduce((a, s) => a + s.count, 0);
    console.log(`  ${yellow("!")} ${total} cross-scope deepPairing Stop entr${total === 1 ? "y" : "ies"} detected outside .local (potential duplicate firings):`);
    for (const s of crossScopeStop) {
      console.log(`    ${dim("·")} ${s.scope}: ${s.path} (${s.count})`);
    }
    fixes.push({
      label: `Remove ${total} cross-scope deepPairing Stop entr${total === 1 ? "y" : "ies"} (preserves non-DP hooks in those files)`,
      requiresExplicitConfirmation: opts.protectSharedScopes,
      apply: () => {
        let removed = 0;
        for (const s of crossScopeStop) {
          const r = cleanDpEntriesFromScope(s.path, "Stop", HOOK_MARKERS.Stop);
          if (!r.ok) return { ok: false, message: r.message };
          removed += r.removed;
        }
        return { ok: true, message: `Removed ${removed} cross-scope Stop entries` };
      },
    });
  }
  if (crossScopeCheckpoint.length > 0) {
    const total = crossScopeCheckpoint.reduce((a, s) => a + s.count, 0);
    console.log(`  ${yellow("!")} ${total} cross-scope deepPairing checkpoint entr${total === 1 ? "y" : "ies"} detected outside .local:`);
    for (const s of crossScopeCheckpoint) {
      console.log(`    ${dim("·")} ${s.scope}: ${s.path} (${s.count})`);
    }
    fixes.push({
      label: `Remove ${total} cross-scope deepPairing checkpoint entr${total === 1 ? "y" : "ies"}`,
      requiresExplicitConfirmation: opts.protectSharedScopes,
      apply: () => {
        let removed = 0;
        for (const s of crossScopeCheckpoint) {
          const r = cleanDpEntriesFromScope(s.path, "PostToolUse", HOOK_MARKERS.PostToolUse);
          if (!r.ok) return { ok: false, message: r.message };
          removed += r.removed;
        }
        return { ok: true, message: `Removed ${removed} cross-scope checkpoint entries` };
      },
    });
  }

  // 6b. Philosophy ledger health (H2-1). The cross-project philosophy ledger is
  // the single most precious file deepPairing owns — months of accumulated taste
  // with no other copy. v0.1.6 FREEZES writes when it can't read the file (so a
  // reset can't destroy history), but that freeze was invisible: recordInstance
  // returns void and every call site swallows. Surface it here — and REPORT ONLY.
  // Per the hard safety rule, doctor NEVER deletes/truncates/overwrites the
  // ledger (a bad repair could eat the only copy of months of taste); it prints
  // the file's real shape and the exact non-destructive `mv` command for the
  // user to run themselves. A correct diagnosis beats a repair that can eat it.
  try {
    const report = buildLedgerHealthReport(getGlobalStore(), { readOnly: true });
    if (report.state === "ok") {
      console.log(`  ${green("✓")} Philosophy ledger parses ${dim(`(${report.ledgerPath})`)}`);
      if (report.corruptSnapshots.length > 0) {
        console.log(`    ${dim(`${report.corruptSnapshots.length} old .corrupt-* snapshot(s) alongside it — safe to delete once you've confirmed the live ledger is good.`)}`);
      }
    } else {
      // Fix B — a chmod-000 ledger is FROZEN for a PERMISSION reason, not
      // corrupt content: no snapshot could be taken and a `cp`/`mv` would hit
      // the same EACCES. Branch the remedy on the reason so we don't advise a
      // command that can't run.
      const isPermIssue = !!report.reason && /EACCES|EPERM|permission denied/i.test(report.reason);
      console.log(`  ${red("✗")} Philosophy ledger is FROZEN — corrupt/unreadable, so NOTHING is being recorded across projects (present_*/check_feedback silently drop appends)`);
      console.log(`    ${dim("path:")}   ${report.ledgerPath}${report.sizeBytes !== undefined ? dim(` (${report.sizeBytes} bytes on disk)`) : ""}`);
      if (report.reason) console.log(`    ${dim("reason:")} ${report.reason}`);
      if (report.backupPath) {
        console.log(`    ${dim("backup:")} ${report.backupPath} ${dim("(snapshot taken this session)")}`);
      } else if (report.corruptSnapshots.length > 0) {
        console.log(`    ${dim("backup:")} ${report.corruptSnapshots[report.corruptSnapshots.length - 1]} ${dim("(existing .corrupt snapshot)")}`);
      } else if (!isPermIssue) {
        // Only advise a cp-backup when the file is READABLE (unparseable
        // content). Under EACCES the cp would fail too — the chmod remedy below
        // is what actually unblocks it.
        console.log(`    ${yellow("!")} ${dim("no .corrupt-* snapshot exists — back the file up FIRST: ")}cp ${shQuote(report.ledgerPath)} ${shQuote(report.ledgerPath + ".corrupt-manual")}`);
      }
      console.log();
      console.log(`  ${bold("To recover — run this yourself (doctor will NOT touch this file):")}`);
      if (isPermIssue) {
        console.log(`      chmod u+rw ${shQuote(report.ledgerPath)}`);
        console.log(`    ${dim("Then re-run ")}${bold(cliInvocation("doctor"))}${dim(" — once the file is readable it'll tell you whether it's genuinely corrupt (with the mv remedy) or fine.")}`);
      } else {
        console.log(`      ${report.remedyCommand}`);
        console.log(`    ${dim("The unreadable file is preserved at that path; a fresh ledger starts on the next recording. Hand-repair the JSON and re-merge with `" + cliInvocation("philosophy import <file> --merge") + "` to keep its history.")}`);
      }
    }
  } catch (err) {
    console.log(`  ${dim(`· Could not check philosophy ledger health: ${err}`)}`);
  }

  // 6c. Cross-process locks (#406/#408). A write that returns 503 lock_busy
  // names a lock; list every *.lock under this project's .deeppairing and the
  // global philosophy dir with its owner and liveness. --fix removes ONLY locks
  // whose owner is provably dead (same platform/host/boot/pid-namespace
  // identity, pid gone or reused) — the lock via the writers' own
  // breakDeadLock, a stranded `.break` via the writers' `.recover` guard, and a
  // stranded `.break.recover` (a double crash; doctor is its ONLY remover).
  try {
    const globalDir = path.dirname(getGlobalStore().getLedgerPath());
    const roots = [dpDir, globalDir];
    // Fix order matters for a stranded chain: .recover, then .break, then the lock.
    const rank = { clear: 0, doctor: 1, recover: 2, break: 3, lock: 4 } as const;
    const locks = inspectLocks(roots).sort((a, b) => rank[a.kind] - rank[b.kind]);
    if (locks.length === 0) {
      console.log(`  ${green("✓")} No cross-process locks held`);
    } else {
      for (const lock of locks) {
        const age = lock.ageMs === null ? "?" : `${Math.round(lock.ageMs / 1000)}s`;
        const owner = lock.owner?.pid ? `pid ${lock.owner.pid}${lock.owner.hostname ? ` on ${lock.owner.hostname}` : ""}` : "unknown owner";
        const mark = lock.state === "dead" ? yellow("!") : lock.state === "alive" ? dim("·") : yellow("?");
        const what = lock.kind === "lock" ? "Lock"
          : lock.kind === "break" ? "Breaker guard"
          : lock.kind === "recover" ? "Recovery guard"
          : lock.kind === "doctor" ? "Doctor guard" : "Doctor clear guard";
        console.log(`  ${mark} ${what} ${lock.path} ${dim(`(${owner}, ${lock.state}${lock.why ? ` — ${lock.why}` : ""}, age ${age})`)}`);
        if (lock.state === "dead" && lock.kind === "clear") {
          console.log(`    ${dim("Stranded doctor clear guard (needs a crash while clearing a crash leftover) — stop every deepPairing daemon/CLI/doctor for this project, then delete it by hand.")}`);
        } else if (lock.state === "dead") {
          fixes.push({
            label: `Remove dead-owner ${what.toLowerCase()} ${lock.path}`,
            requiresExplicitConfirmation: opts.protectSharedScopes &&
              (lock.path === globalDir || lock.path.startsWith(globalDir + path.sep)),
            apply: () => {
              try {
                const r = clearDeadLockFile(lock.path);
                return { ok: r.removed, message: r.removed ? "Removed" : `Not removed (${r.reason})` };
              } catch (e) { return { ok: false, message: errorMessage(e) }; }
            },
          });
        } else if (lock.state === "unknown") {
          console.log(`    ${dim("Owner can't be verified (another OS instance, or an unreadable/older lock) — doctor will not remove it. Stop every deepPairing daemon/CLI for this project, then delete it by hand.")}`);
        }
      }
    }
  } catch (err) {
    console.log(`  ${dim(`· Could not inspect locks: ${err}`)}`);
  }

  // 7. Overall verdict
  console.log();
  if (probeOk && daemonFatalHint) {
    // A daemon is answering, but the log shows fresh daemons dying — the
    // responder is almost certainly a leftover/older process. Refusing to
    // call this "healthy" is the whole point of the III9 doctor fix.
    console.log(`  ${yellow(bold("Daemon answering, but unhealthy"))} on port ${port}`);
    console.log(`  ${dim(daemonFatalHint)}`);
  } else if (probeOk) {
    console.log(`  ${green(bold("Daemon healthy"))} on port ${port}`);
  } else if (daemonFatalHint) {
    console.log(`  ${red(bold("Daemon failing to start"))} on port ${port}`);
    console.log(`  ${dim(daemonFatalHint)}`);
  } else if (probeReachable) {
    // III9 follow-up — the port answered with a non-200 (typically a 403 from
    // the AA4 project-hash gate, or 401). The process is ALIVE, so this is an
    // auth/project mismatch — NOT a dead daemon. Crucially, do NOT emit the
    // destructive kill+rm remedy the "not responding" branch below uses.
    console.log(`  ${yellow(bold("Daemon alive but auth-gated"))} on port ${port} ${dim(`(HTTP ${probeStatus})`)}`);
    console.log(`  ${dim("The port is responding, so the daemon is up — this is a project-hash/auth mismatch, not a dead process. If a different project's daemon holds this port, see the mismatch note above; otherwise reload any open companion tab. Do NOT kill the daemon.")}`);
  } else if (info?.pid) {
    console.log(`  ${red(bold("Daemon unhealthy"))} — daemon.json points at PID ${info.pid} but port ${port} is not responding`);
    console.log(`  ${dim("Try: kill ") + info.pid + dim(" && rm .deeppairing/daemon.json — or re-run with --fix")}`);
  } else {
    console.log(`  ${yellow(bold("No daemon detected"))} on port ${port}`);
    console.log(`  ${dim("Start one by opening a Claude Code session with deepPairing configured, or run the daemon directly.")}`);
  }
  console.log();

  // 8. Healing phase — only when --fix was passed AND there's something to heal.
  if (!opts.fix) {
    if (fixes.length > 0) {
      console.log(`  ${dim(`${fixes.length} fix${fixes.length === 1 ? "" : "es"} available. Re-run with --fix to apply.`)}`);
      console.log();
    }
    return;
  }
  if (fixes.length === 0) {
    console.log(`  ${green("Nothing to fix.")}`);
    console.log();
    return;
  }

  console.log(bold(`  Proposed fixes (${fixes.length}):`));
  fixes.forEach((f, i) => console.log(`    ${dim(`${i + 1}.`)} ${f.label}`));
  console.log();

  const confirmed = opts.yes || !process.stdin.isTTY
    ? (opts.yes ?? false)
    : await confirmPrompt(`  Apply all ${fixes.length}? [y/N] `);

  if (!confirmed) {
    console.log(`  ${dim("Cancelled. No changes made.")}`);
    console.log();
    return;
  }

  for (const f of fixes) {
    // AA3 — skip cross-project / cross-process fixes when running under
    // --yes. Surface the skip explicitly so the user can re-run without
    // --yes if they actually want it applied.
    if (f.requiresExplicitConfirmation && opts.yes) {
      console.log(
        `  ${yellow("!")} SKIPPED ${f.label}${dim(" — requires interactive confirmation; re-run without --yes")}`,
      );
      continue;
    }
    const r = await f.apply();
    const mark = r.ok ? green("✓") : red("✗");
    console.log(`  ${mark} ${f.label}${r.message ? dim(` — ${r.message}`) : ""}`);
  }
  console.log();
}

function confirmPrompt(question: string, defaultYes = false): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "" && defaultYes) return resolve(true);
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}
