/**
 * #546 — the doctor half: recorded preflight failures, plus the preflight
 * MODE as far as doctor can actually see it.
 *
 * Provenance is the hard part, and this module refuses to overclaim it. The
 * hook that enforces DEEPPAIRING_PREFLIGHT_MODE is a child of Claude Code,
 * which merges the environment it was launched from with the `env` blocks of
 * its settings files. Doctor is a different process, started from a different
 * shell, at a different time. So it reports each source it can read, labelled
 * as what it is — a settings file's `env` block, or doctor's own shell — and
 * never names one of them "the effective mode". An invalid value is flagged
 * (and, like the hook's own warning, never echoed: it is arbitrary input).
 *
 * Read-only. Nothing here writes, repairs or clears anything.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookStatePath } from "../hooks/hook-state.js";
import { PREFLIGHT_FAILURE_CLASSES, readPreflightFailures, type PreflightFailureClass, type PreflightFailureEntry } from "../hooks/preflight-diagnostics.js";

export const PREFLIGHT_MODE_ENV = "DEEPPAIRING_PREFLIGHT_MODE";

export type ModeReading =
  | { kind: "no-file" }
  | { kind: "unreadable" }
  | { kind: "unset" }
  | { kind: "ask" }
  | { kind: "strict-stop" }
  | { kind: "invalid" };

export interface ModeSource {
  /** What this reading is, in words: never "effective". */
  label: string;
  path?: string;
  reading: ModeReading;
}

/** The same exact-match rule as resolvePreflightMode, minus the value. */
export function classifyModeValue(value: unknown): ModeReading {
  if (value === undefined) return { kind: "unset" };
  if (value === "" || value === "ask") return { kind: "ask" };
  if (value === "strict-stop") return { kind: "strict-stop" };
  return { kind: "invalid" };
}

function readSettingsMode(file: string): ModeReading {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "no-file" } : { kind: "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw) as { env?: unknown } | null;
    const env = parsed && typeof parsed === "object" ? parsed.env : undefined;
    if (env === undefined) return { kind: "unset" };
    if (!env || typeof env !== "object" || Array.isArray(env)) return { kind: "unreadable" };
    const has = Object.prototype.hasOwnProperty.call(env, PREFLIGHT_MODE_ENV);
    return has ? classifyModeValue((env as Record<string, unknown>)[PREFLIGHT_MODE_ENV]) : { kind: "unset" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Every source doctor can read, in a fixed order, each labelled. */
export function preflightModeSources(
  cwd: string,
  opts: { env?: Record<string, string | undefined>; homeDir?: string } = {},
): ModeSource[] {
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const files: Array<[string, string]> = [
    ["settings env, user", path.join(home, ".claude", "settings.json")],
    ["settings env, project", path.join(cwd, ".claude", "settings.json")],
    ["settings env, local", path.join(cwd, ".claude", "settings.local.json")],
  ];
  const out: ModeSource[] = files.map(([label, p]) => ({ label, path: p, reading: readSettingsMode(p) }));
  out.push({
    label: "doctor's own shell",
    reading: Object.prototype.hasOwnProperty.call(env, PREFLIGHT_MODE_ENV) ? classifyModeValue(env[PREFLIGHT_MODE_ENV]) : { kind: "unset" },
  });
  return out;
}

export function describeModeReading(r: ModeReading): string {
  switch (r.kind) {
    case "no-file": return "no settings file";
    case "unreadable": return "settings file unreadable or not JSON (not inspected)";
    case "unset": return "not set (default ask)";
    case "ask": return "ask";
    case "strict-stop": return "strict-stop";
    case "invalid": return "INVALID value (not shown); the hook treats a matching edit as strict-stop and warns";
  }
}

/** What each class means for the gate, in one line. */
export const PREFLIGHT_FAILURE_MEANING: Record<PreflightFailureClass, string> = {
  input_malformed: "Claude Code sent an event the hook could not read, so no check ran for it.",
  ledger_unreadable: "a ledger file (.deeppairing/preferences.json or team.json) exists but could not be read, so its rules were not checked.",
  ledger_corrupt: "a ledger file (.deeppairing/preferences.json or team.json) is not valid JSON or has the wrong shape, so its rules were not checked.",
  ledger_entry_invalid: "a .deeppairing/preferences.json entry has a concept the matcher can't read (for example a number); it was ignored, so the entry matched on its description, or the entry was skipped if nothing usable remained. Every other stance still enforced.",
  matcher_import_failed: "the init-installed hook could not load part of the matcher; rebuild deepPairing, then start a session so the hook is re-stamped.",
  evaluator_threw: "the matcher threw while checking an edit, for a reason no single ledger entry explains, so the whole check was skipped.",
  session_store_unreadable: "no session store could be read, so the guardrail backstop stayed silent.",
};

export interface PreflightDoctorReport {
  failures: Array<{ cls: PreflightFailureClass; entry: PreflightFailureEntry }>;
  modes: ModeSource[];
  anyInvalidMode: boolean;
  /** Stamped URLs in the init-generated hook that point at nothing. */
  missingStamps: Array<{ name: string; path: string }>;
}

/** Read the init-generated hook's stamped module URLs and report any missing. */
export function missingPreflightStamps(cwd: string): Array<{ name: string; path: string }> {
  let src: string;
  try {
    src = fs.readFileSync(path.join(cwd, ".deeppairing", "hooks", "preflight.mjs"), "utf-8");
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const name of ["CORE_URL", "RULES_URL", "DIAG_URL"]) {
    const m = new RegExp(`const ${name} = ("[^"\\n]*");`).exec(src);
    if (!m) continue;
    try {
      const p = fileURLToPath(JSON.parse(m[1]!) as string);
      if (!fs.existsSync(p)) out.push({ name, path: p });
    } catch {
      out.push({ name, path: "(unparseable URL)" });
    }
  }
  return out;
}

export function buildPreflightDoctorReport(
  cwd: string,
  opts: { env?: Record<string, string | undefined>; homeDir?: string } = {},
): PreflightDoctorReport {
  // A plain read: readHookState would write a .corrupt-* salvage copy, and
  // doctor's report is read-only.
  let state: unknown = null;
  try {
    state = JSON.parse(fs.readFileSync(hookStatePath(cwd), "utf-8"));
  } catch {
    state = null;
  }
  const recorded = readPreflightFailures(state);
  const failures = PREFLIGHT_FAILURE_CLASSES
    .filter((cls) => recorded[cls])
    .map((cls) => ({ cls, entry: recorded[cls]! }));
  const modes = preflightModeSources(cwd, opts);
  return {
    failures,
    modes,
    anyInvalidMode: modes.some((m) => m.reading.kind === "invalid"),
    missingStamps: missingPreflightStamps(cwd),
  };
}

/** Plain lines (mark + text + indented details) for the doctor printer. */
export function preflightDoctorLines(report: PreflightDoctorReport): Array<{ mark: "ok" | "warn" | "info"; text: string; details: string[] }> {
  const lines: Array<{ mark: "ok" | "warn" | "info"; text: string; details: string[] }> = [];
  if (report.failures.length === 0) {
    lines.push({ mark: "ok", text: "No preflight failures recorded", details: [] });
  } else {
    lines.push({
      mark: "warn",
      text: "Preflight failures recorded. Each one failed open: the edit went ahead without that part of the check, exactly as before.",
      details: report.failures.flatMap(({ cls, entry }) => [
        `${cls} ×${entry.count} (${entry.detail}${entry.indices ? `, entries ${entry.indices.join(", ")}` : ""}; first ${entry.firstAt}, last ${entry.lastAt})`,
        `  ${PREFLIGHT_FAILURE_MEANING[cls]}`,
      ]),
    });
  }
  for (const s of report.missingStamps) {
    lines.push({
      mark: "warn",
      text: `The installed preflight hook points ${s.name} at a missing file, so that part fails open`,
      details: [s.path, "Rebuild deepPairing, then start a session so the daemon re-stamps the hook."],
    });
  }
  lines.push({
    mark: report.anyInvalidMode ? "warn" : "info",
    text: `Preflight mode (${PREFLIGHT_MODE_ENV}) as visible to doctor${report.anyInvalidMode ? ": an INVALID value is set" : ""}`,
    details: [
      ...report.modes.map((m) => `${m.label}${m.path ? ` (${m.path})` : ""}: ${describeModeReading(m.reading)}`),
      "Claude Code merges its launch environment with these settings env blocks; doctor is a separate process and cannot see the hook's effective value.",
    ],
  });
  return lines;
}
