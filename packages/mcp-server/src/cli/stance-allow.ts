/**
 * #470 slice 3 (design §3, D2) — `deeppairing stance allow <blockId>` and
 * `deeppairing stance exceptions [revoke <id>]`.
 *
 * The CLI never writes state. It reaches the SAME bearer-gated public route
 * the companion UI uses (`POST /api/preflight-blocks/:blockId/exception`),
 * where the daemon's in-memory registry decides everything (A1). If the
 * daemon is unreachable, nothing is granted.
 *
 * The interactive checks below — a TTY on both ends, no flags at all, not
 * inside Claude Code or CI, a paged preview, a typed reason, a typed `allow` —
 * stop casual misuse. They are one scripted pty away from the agent, which is
 * why the real protection is the narrow Bash `ask` (hooks/stance-allow-ask.ts):
 * when the agent's shell runs this command, you get a prompt. The grant is
 * labelled `cli` by a self-reported header; that labels the door, it never
 * authenticates anyone.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProposalPrecondition, ProposalSnapshot } from "@deeppairing/shared";
import { projectHashOf } from "../project-root.js";
import { readDaemonInfo } from "../daemon/lifecycle.js";
import { computeLineDiff } from "@deeppairing/shared";

export interface StanceIo {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  /** Read one line from the terminal (null at EOF). */
  readLine: (prompt: string) => Promise<string | null>;
  /** Show `text` through the pager; resolves with the pager's exit code. */
  page: (text: string, env: NodeJS.ProcessEnv) => Promise<number>;
  fetch: typeof fetch;
}

const MIN_REASON = 3;
const MAX_REASON = 280;

/** The pager isn't there at all (no $PAGER and no `less` on PATH): the CLI
 *  then shows the preview itself and asks you to confirm you read it. */
export const PAGER_UNAVAILABLE = -127;

/** Find an executable on PATH (PATHEXT-aware on Windows), or null. */
export function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Page `text`: `$PAGER` if set (run through the platform shell, so a Windows
 * `more` or an absolute path both work), else `less -R` when it's on PATH.
 * A pager that starts and fails is a refusal (non-zero); NO pager at all is
 * PAGER_UNAVAILABLE, and the caller falls back to an explicit in-terminal read.
 */
export function defaultPager(text: string, env: NodeJS.ProcessEnv): Promise<number> {
  const custom = env.PAGER?.trim();
  const less = custom ? null : onPath("less", env);
  if (!custom && !less) return Promise.resolve(PAGER_UNAVAILABLE);
  return new Promise((resolve) => {
    const child = custom
      ? spawn(custom, { shell: true, stdio: ["pipe", "inherit", "inherit"], env })
      : spawn(less!, ["-R"], { stdio: ["pipe", "inherit", "inherit"], env });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.on("error", () => { /* a pager may quit before reading it all */ });
    child.stdin.end(text);
  });
}

/**
 * #503 review (Sol P2) — agent-supplied text must not drive your terminal. C0
 * and C1 control bytes (ESC, CR, BEL, the 8-bit CSI, …) are shown as visible
 * escapes; newlines and tabs stay readable. Only this renderer's own colour
 * codes reach the pager.
 */
export function safeText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 ? `^${String.fromCharCode(code + 64)}` : code === 0x7f ? "^?" : `\\x${code.toString(16)}`;
  });
}

/** Every string (keys included) in an agent-supplied value, made safe. The
 *  one choke point the renderers go through, so no field can be missed. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return safeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [safeText(k), sanitizeDeep(v)])) as T;
  }
  return value;
}

function color(env: NodeJS.ProcessEnv) {
  const on = !env.NO_COLOR;
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap("31"), green: wrap("32"), bold: wrap("1"), dim: wrap("2"), cyan: wrap("36") };
}

function preconditionLine(p: ProposalPrecondition): string {
  if (p.kind === "code_change_prior") {
    return p.priorCodeChangeId
      ? `\`before\` comes from ${safeText(p.priorCodeChangeId)} (your last change to ${safeText(p.filePath)})`
      : `\`before\` is empty: there was no earlier change to ${safeText(p.filePath)}`;
  }
  return `Revises ${safeText(p.targetId)} v${p.targetVersion}`;
}

/** A unified diff of the effective before/after, with file headers and @@ hunks. */
export function unifiedDiff(filePath: string, before: string, after: string, env: NodeJS.ProcessEnv, context = 3): string {
  const c = color(env);
  const lines = computeLineDiff(before, after);
  const out: string[] = [c.bold(`--- a/${safeText(filePath)}`), c.bold(`+++ b/${safeText(filePath)}`)];
  const changed = lines.map((l, i) => (l.type === "unchanged" ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [...out, c.dim("(no changes)")].join("\n");
  // Group changes into hunks with `context` lines around each.
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - context);
    let end = Math.min(lines.length - 1, changed[i]! + context);
    while (i + 1 < changed.length && changed[i + 1]! - context <= end + 1) {
      i++;
      end = Math.min(lines.length - 1, changed[i]! + context);
    }
    const hunk = lines.slice(start, end + 1);
    const oldStart = hunk.find((l) => l.oldLineNum)?.oldLineNum ?? 0;
    const newStart = hunk.find((l) => l.newLineNum)?.newLineNum ?? 0;
    const oldCount = hunk.filter((l) => l.type !== "added").length;
    const newCount = hunk.filter((l) => l.type !== "removed").length;
    out.push(c.cyan(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`));
    for (const l of hunk) {
      const line = safeText(l.content);
      out.push(l.type === "added" ? c.green(`+${line}`) : l.type === "removed" ? c.red(`-${line}`) : ` ${line}`);
    }
    i++;
  }
  return out.join("\n");
}

/** The snapshot as readable text — never raw JSON (§3 "Preview"). */
export function renderSnapshot(rawSnapshot: ProposalSnapshot, env: NodeJS.ProcessEnv): string {
  // #503 review round 2 (Sol P2) — sanitise the WHOLE snapshot here, once,
  // before any field is read: decision arrays, titles, option text, paths.
  const snapshot = sanitizeDeep(rawSnapshot);
  const c = color(env);
  const content = snapshot.content as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? safeText(v) : "");
  if (snapshot.type === "code_change") {
    return [
      unifiedDiff(text(content.filePath), text(content.before), text(content.after), env),
      "",
      text(content.reasoning) && `Reasoning: ${text(content.reasoning)}`,
    ].filter((l) => l !== "").join("\n");
  }
  const out: string[] = [c.bold(safeText(snapshot.title))];
  if (snapshot.type === "decision") {
    if (text(content.context)) out.push("", text(content.context));
    for (const o of (Array.isArray(content.options) ? content.options : []) as Array<Record<string, unknown>>) {
      out.push("", c.bold(`• ${text(o.title)}`));
      if (text(o.description)) out.push(`  ${text(o.description)}`);
      if (Array.isArray(o.pros) && o.pros.length) out.push(c.green(`  Pros: ${(o.pros as string[]).join("; ")}`));
      if (Array.isArray(o.cons) && o.cons.length) out.push(c.red(`  Cons: ${(o.cons as string[]).join("; ")}`));
    }
    return out.join("\n");
  }
  // Any other shape: each field as readable lines.
  const walk = (value: unknown, indent: string): void => {
    if (typeof value === "string") { out.push(`${indent}${safeText(value)}`); return; }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, `${indent}  `)); return; }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string") out.push(`${indent}${safeText(k)}: ${safeText(v)}`);
        else if (typeof v === "number" || typeof v === "boolean") out.push(`${indent}${k}: ${String(v)}`);
        else { out.push(`${indent}${safeText(k)}:`); walk(v, `${indent}  `); }
      }
    }
  };
  walk(content, "");
  return out.join("\n");
}

interface Preview {
  eligible: boolean;
  ineligibleReason?: string;
  stance?: { description: string; concept?: string };
  snapshot?: ProposalSnapshot;
  preconditions?: ProposalPrecondition[];
}

/** Daemon-routed: base URL + the headers every request carries. */
function daemonTarget(io: StanceIo): { base: string; headers: Record<string, string> } | null {
  const info = readDaemonInfo(io.projectRoot);
  if (!info?.port || !info.authToken) return null;
  return {
    base: `http://localhost:${info.port}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${info.authToken}`,
      "X-Project-Hash": projectHashOf(io.projectRoot),
      "X-DeepPairing-Grant-Origin": "cli",
    },
  };
}

/** Why the interactive grant refuses to run, or null when it may. */
export function interactiveRefusal(args: string[], io: StanceIo): string | null {
  if (args.some((a) => a.startsWith("-"))) return "`stance allow` takes no flags (not even --reason). Run it yourself, interactively.";
  if (io.env.CLAUDECODE === "1") return "`stance allow` refuses to run inside Claude Code. Run it yourself in your own terminal.";
  if (io.env.CI) return "`stance allow` refuses to run in CI.";
  if (!io.stdinIsTTY || !io.stdoutIsTTY) return "`stance allow` needs an interactive terminal (stdin and stdout must be a TTY).";
  return null;
}

/** Returns the process exit code. Never throws for an expected refusal. */
export async function runStanceCommand(args: string[], io: StanceIo): Promise<number> {
  const c = color(io.env);
  const fail = (msg: string) => { io.writeErr(`  ${c.red("✗")} ${msg} Nothing was allowed.\n`); return 1; };
  const [sub, ...rest] = args;

  if (sub === "exceptions") {
    const target = daemonTarget(io);
    if (!target) return fail("The deepPairing daemon for this project isn't running (no daemon.json with a token).");
    if (rest[0] === "revoke") {
      const id = rest[1];
      if (!id) return fail("Usage: stance exceptions revoke <allowance-id>.");
      const res = await io.fetch(`${target.base}/api/stance-exceptions/${encodeURIComponent(id)}/revoke`, { method: "POST", headers: target.headers, body: "{}" }).catch(() => null);
      if (!res) return fail("Couldn't reach the deepPairing daemon.");
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { io.writeErr(`  ${c.red("✗")} ${body.error ?? `Revoke failed (${res.status}).`}\n`); return 1; }
      io.write(`  ${c.green("✓")} Revoked ${id}.\n`);
      return 0;
    }
    const res = await io.fetch(`${target.base}/api/stance-exceptions`, { headers: target.headers }).catch(() => null);
    if (!res?.ok) return fail("Couldn't read allowances from the deepPairing daemon.");
    const { allowances } = sanitizeDeep(await res.json() as { allowances: Array<{ id: string; state: string; grantedVia: string; reason: string; stance: { concept?: string; description: string }; artifactId?: string }> });
    if (allowances.length === 0) { io.write("  No allowances held by this daemon.\n"); return 0; }
    for (const a of allowances) {
      io.write(`  ${safeText(a.id)}  ${safeText(a.state).padEnd(8)} ${safeText(a.grantedVia).toUpperCase()}  '${safeText(a.stance.concept ?? a.stance.description)}' — “${safeText(a.reason)}”${a.artifactId ? ` → ${safeText(a.artifactId)}` : ""}\n`);
    }
    return 0;
  }

  if (sub !== "allow") {
    io.writeErr("  Usage: stance allow <blockId> | stance exceptions [revoke <id>]\n");
    return 1;
  }
  const refusal = interactiveRefusal(rest, io);
  if (refusal) return fail(refusal);
  const blockId = rest[0];
  if (!blockId || rest.length !== 1) return fail("Usage: stance allow <blockId> (the id from the gate log).");

  const target = daemonTarget(io);
  if (!target) return fail("The deepPairing daemon for this project isn't running, so there's nothing to allow.");
  const res = await io.fetch(`${target.base}/api/preflight-blocks/${encodeURIComponent(blockId)}/exception`, { headers: target.headers }).catch(() => null);
  if (!res) return fail("Couldn't reach the deepPairing daemon.");
  if (res.status === 404) return fail(`No block ${blockId} is held by the running daemon.`);
  if (!res.ok) return fail(`The daemon refused the preview (${res.status}).`);
  const preview = sanitizeDeep(await res.json() as Preview);
  if (!preview.eligible || !preview.snapshot) return fail(`This block can't be allowed once (${preview.ineligibleReason ?? "not eligible"}).`);

  const stance = safeText(preview.stance?.concept ?? preview.stance?.description ?? "your stance");
  const page = [
    c.bold(`Allow one proposal past '${stance}'`),
    "Allows this exact proposal, once, until this Claude session ends (at most 72 hours). The stance stays on for everything else.",
    "",
    ...(preview.preconditions ?? []).map(preconditionLine),
    "",
    renderSnapshot(preview.snapshot, io.env),
    "",
    "If the agent changes anything, or what it depends on changes first, this allowance won't apply.",
    "",
  ].join("\n");
  const pagerCode = await io.page(page, io.env);
  if (pagerCode === PAGER_UNAVAILABLE) {
    // No $PAGER and no `less` (e.g. Windows): show the whole preview here and
    // make reading it an explicit step before the reason prompt.
    io.write(`${page}\n`);
    const read = await io.readLine("  That's the whole proposal. Press Enter once you've read it (Ctrl+C to stop). ");
    if (read === null) return fail("Preview not confirmed.");
  } else if (pagerCode !== 0) {
    return fail(`The pager exited with ${pagerCode}; set $PAGER to a working pager.`);
  }

  const reason = (await io.readLine(`  Why is this one fine? (${MIN_REASON}–${MAX_REASON} characters) `))?.trim() ?? "";
  if (reason.length < MIN_REASON || reason.length > MAX_REASON) return fail(`A reason of ${MIN_REASON}–${MAX_REASON} characters is required.`);
  const confirm = (await io.readLine(`  Type ${c.bold("allow")} to allow it once: `))?.trim();
  if (confirm !== "allow") return fail("Not confirmed.");

  // #503 review (Sol P2) — after dispatch, "nothing happened" is no longer
  // provable: a lost response may follow a grant the daemon recorded.
  const unconfirmed = () => {
    io.writeErr(`  ${c.red("✗")} Couldn't confirm whether the grant went through (the daemon's answer was lost). Check with \`stance exceptions\` before trying again.\n`);
    return 1;
  };
  const grant = await io.fetch(`${target.base}/api/preflight-blocks/${encodeURIComponent(blockId)}/exception`, {
    method: "POST", headers: target.headers, body: JSON.stringify({ reason }),
  }).catch(() => null);
  if (!grant) return unconfirmed();
  const body = await grant.json().catch(() => null) as { error?: unknown; existing?: boolean; allowance?: { id?: unknown; state?: unknown; ceilingAt?: unknown } } | null;
  // #503 review round 2 (Sol P2) — a SUCCESS status whose body we can't read,
  // or whose receipt isn't the expected shape, is unconfirmed: the daemon may
  // well have recorded the grant. Only a well-formed receipt is success.
  if (grant.ok) {
    const r = body?.allowance;
    if (!r || typeof r.id !== "string" || typeof r.state !== "string" || typeof r.ceilingAt !== "string") return unconfirmed();
  } else {
    if (grant.status >= 500 && typeof body?.error !== "string") return unconfirmed();
    return fail(safeText(typeof body?.error === "string" ? body.error : `The daemon refused the grant (${grant.status}).`));
  }
  const a = body!.allowance as { id: string; state: string; ceilingAt: string };
  // An idempotent repeat returns the block's EXISTING allowance, whatever its
  // state now: say so truthfully, never as a fresh grant (#503 review).
  if (a.state !== "allowed") {
    io.writeErr(`  ${c.red("✗")} This block was already allowed once, and that allowance (${safeText(a.id)}) is now ${safeText(a.state)}. Nothing new was allowed.\n`);
    return 1;
  }
  io.write(body.existing
    ? `  ${c.green("✓")} Already allowed once (${safeText(a.id)}), still waiting for Claude to retry. It ends with the session, or at ${safeText(a.ceilingAt)}.\n`
    : `  ${c.green("✓")} Allowed once (${safeText(a.id)}). Claude can now retry that exact call. It ends with the session, or at ${safeText(a.ceilingAt)}.\n`);
  return 0;
}

/** The real terminal. */
export function processStanceIo(projectRoot: string): StanceIo {
  return {
    projectRoot,
    env: process.env,
    stdinIsTTY: !!process.stdin.isTTY,
    stdoutIsTTY: !!process.stdout.isTTY,
    write: (t) => { process.stdout.write(t); },
    writeErr: (t) => { process.stderr.write(t); },
    readLine: async (prompt) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(prompt); } catch { return null; } finally { rl.close(); }
    },
    page: defaultPager,
    fetch: globalThis.fetch.bind(globalThis),
  };
}
