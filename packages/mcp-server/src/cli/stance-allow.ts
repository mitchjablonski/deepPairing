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

/** `$PAGER`, falling back to `less -R`. Its stdin is the preview; its stdout
 *  and stderr are your terminal. The reason prompt comes only after it exits. */
export function defaultPager(text: string, env: NodeJS.ProcessEnv): Promise<number> {
  const pager = env.PAGER?.trim() || "less -R";
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", pager], { stdio: ["pipe", "inherit", "inherit"], env });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.on("error", () => { /* a pager may quit before reading it all */ });
    child.stdin.end(text);
  });
}

function color(env: NodeJS.ProcessEnv) {
  const on = !env.NO_COLOR;
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap("31"), green: wrap("32"), bold: wrap("1"), dim: wrap("2"), cyan: wrap("36") };
}

function preconditionLine(p: ProposalPrecondition): string {
  if (p.kind === "code_change_prior") {
    return p.priorCodeChangeId
      ? `\`before\` comes from ${p.priorCodeChangeId} (your last change to ${p.filePath})`
      : `\`before\` is empty: there was no earlier change to ${p.filePath}`;
  }
  return `Revises ${p.targetId} v${p.targetVersion}`;
}

/** A unified diff of the effective before/after, with file headers and @@ hunks. */
export function unifiedDiff(filePath: string, before: string, after: string, env: NodeJS.ProcessEnv, context = 3): string {
  const c = color(env);
  const lines = computeLineDiff(before, after);
  const out: string[] = [c.bold(`--- a/${filePath}`), c.bold(`+++ b/${filePath}`)];
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
      out.push(l.type === "added" ? c.green(`+${l.content}`) : l.type === "removed" ? c.red(`-${l.content}`) : ` ${l.content}`);
    }
    i++;
  }
  return out.join("\n");
}

/** The snapshot as readable text — never raw JSON (§3 "Preview"). */
export function renderSnapshot(snapshot: ProposalSnapshot, env: NodeJS.ProcessEnv): string {
  const c = color(env);
  const content = snapshot.content as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (snapshot.type === "code_change") {
    return [
      unifiedDiff(text(content.filePath), text(content.before), text(content.after), env),
      "",
      text(content.reasoning) && `Reasoning: ${text(content.reasoning)}`,
    ].filter((l) => l !== "").join("\n");
  }
  const out: string[] = [c.bold(snapshot.title)];
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
    if (typeof value === "string") { out.push(`${indent}${value}`); return; }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, `${indent}  `)); return; }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string") out.push(`${indent}${k}: ${v}`);
        else if (typeof v === "number" || typeof v === "boolean") out.push(`${indent}${k}: ${String(v)}`);
        else { out.push(`${indent}${k}:`); walk(v, `${indent}  `); }
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
    const { allowances } = await res.json() as { allowances: Array<{ id: string; state: string; grantedVia: string; reason: string; stance: { concept?: string; description: string }; artifactId?: string }> };
    if (allowances.length === 0) { io.write("  No allowances held by this daemon.\n"); return 0; }
    for (const a of allowances) {
      io.write(`  ${a.id}  ${a.state.padEnd(8)} ${a.grantedVia.toUpperCase()}  '${a.stance.concept ?? a.stance.description}' — “${a.reason}”${a.artifactId ? ` → ${a.artifactId}` : ""}\n`);
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
  const preview = await res.json() as Preview;
  if (!preview.eligible || !preview.snapshot) return fail(`This block can't be allowed once (${preview.ineligibleReason ?? "not eligible"}).`);

  const stance = preview.stance?.concept ?? preview.stance?.description ?? "your stance";
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
  if (pagerCode !== 0) return fail(`The pager exited with ${pagerCode}; set $PAGER to a working pager.`);

  const reason = (await io.readLine(`  Why is this one fine? (${MIN_REASON}–${MAX_REASON} characters) `))?.trim() ?? "";
  if (reason.length < MIN_REASON || reason.length > MAX_REASON) return fail(`A reason of ${MIN_REASON}–${MAX_REASON} characters is required.`);
  const confirm = (await io.readLine(`  Type ${c.bold("allow")} to allow it once: `))?.trim();
  if (confirm !== "allow") return fail("Not confirmed.");

  const grant = await io.fetch(`${target.base}/api/preflight-blocks/${encodeURIComponent(blockId)}/exception`, {
    method: "POST", headers: target.headers, body: JSON.stringify({ reason }),
  }).catch(() => null);
  if (!grant) return fail("Couldn't reach the deepPairing daemon.");
  const body = await grant.json().catch(() => ({})) as { error?: string; allowance?: { id: string; state: string; ceilingAt: string } };
  if (!grant.ok || !body.allowance) return fail(body.error ?? `The daemon refused the grant (${grant.status}).`);
  io.write(`  ${c.green("✓")} Allowed once (${body.allowance.id}). Claude can now retry that exact call. It ends with the session, or at ${body.allowance.ceilingAt}.\n`);
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
