#!/usr/bin/env node
/**
 * #430 slice 2 — the only route from the attention walkthrough output to an
 * uploaded artifact. It copies into a fresh directory, so the workflow can't
 * upload anything this script didn't validate:
 *
 *  - each evidence.v1.json must match the known shape and the dispatched SHA;
 *  - absolute paths in any string are replaced (a failure message or the
 *    project-root UI text can carry the mkdtemp sandbox or runner workspace);
 *  - a PNG is copied only when a validated evidence file names it, so an
 *    unreferenced image, trace, log or attachment never leaves the runner.
 *
 * A file that fails is dropped with its PNGs and turns the step red. PNG pixels
 * can't be sanitized here; the rows are synthetic and run in a throwaway HOME.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVIDENCE_FILE = "evidence.v1.json";
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SCREENSHOT = /^[A-Za-z0-9._-]+\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PATH_END = "[^\\s\"'`<>()\\[\\]{},;]*";
const ABSOLUTE_PATHS = [
  new RegExp(`\\bfile:/{2,3}${PATH_END}`, "gi"),
  new RegExp(`(?<![\\w.:/~-])/(?:home|Users|root|tmp|var|private|mnt|opt|etc|usr|run|srv|media|nix|runner|github|workspace|Volumes|__w)(?![\\w-])(?:/${PATH_END})?`, "g"),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_END}`, "g"),
  new RegExp(`(?<![\\w\\\\])\\\\\\\\[^\\s\\\\]+\\\\${PATH_END}`, "g"),
];
const CREDENTIAL = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{16,})/;

export const EVIDENCE_TOP_LEVEL_KEYS = [
  "schemaVersion", "runtime", "syntheticOnly", "status", "cleanup", "mode", "theme", "viewport", "scenario", "matrix",
  "seedDigest", "seedOperations", "recipeDigest", "keyboard", "clocks", "assertions", "captures", "liveRegions", "limitations",
];
const OPTIONAL_TOP_LEVEL_KEYS = ["layout", "failure"];
const RUNTIME_KEYS = ["gitSha", "node", "platform", "playwright", "browser", "startups", "atSave", "builtRuntimeStable", "provenanceLimit"];
const PROVENANCE_DIGESTS = ["trackedDiffSha256", "daemonEntrySha256", "distManifestSha256", "webManifestSha256", "sharedManifestSha256", "harnessSourceSha256", "lockfileSha256"];
const PROVENANCE_KEYS = ["gitSha", "trackedWorktreeDirty", "distFiles", "webFiles", ...PROVENANCE_DIGESTS];

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, required, optional, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} has unexpected key "${key}"`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing "${key}"`);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} is not one of ${allowed.join("/")}`);
}

function validateProvenance(value, sha, label) {
  exactKeys(value, PROVENANCE_KEYS, [], label);
  if (value.gitSha !== sha) throw new Error(`${label}.gitSha is not the dispatched SHA`);
  for (const key of PROVENANCE_DIGESTS) if (!HEX64.test(value[key])) throw new Error(`${label}.${key} is not a sha256 digest`);
}

/** Throws on anything but the shape AttentionEvidence.save writes. */
export function validateEvidence(evidence, sha) {
  if (!GIT_SHA.test(sha)) throw new Error("Expected SHA must be a full 40-character commit id");
  exactKeys(evidence, EVIDENCE_TOP_LEVEL_KEYS, OPTIONAL_TOP_LEVEL_KEYS, "evidence");
  if (evidence.schemaVersion !== 1) throw new Error("evidence.schemaVersion must be 1");
  if (evidence.syntheticOnly !== true) throw new Error("evidence.syntheticOnly must be true");
  oneOf(evidence.status, ["passed", "failed"], "evidence.status");
  oneOf(evidence.cleanup, ["removed", "retained"], "evidence.cleanup");
  oneOf(evidence.mode, ["OFF", "ON"], "evidence.mode");
  oneOf(evidence.theme, ["dark", "light"], "evidence.theme");
  exactKeys(evidence.runtime, RUNTIME_KEYS, [], "evidence.runtime");
  if (evidence.runtime.gitSha !== sha) throw new Error("evidence.runtime.gitSha is not the dispatched SHA");
  validateProvenance(evidence.runtime.atSave, sha, "evidence.runtime.atSave");
  if (!Array.isArray(evidence.runtime.startups)) throw new Error("evidence.runtime.startups must be an array");
  evidence.runtime.startups.forEach((start, i) => validateProvenance(start, sha, `evidence.runtime.startups[${i}]`));
  for (const key of ["seedDigest", "recipeDigest"]) if (!HEX64.test(evidence[key])) throw new Error(`evidence.${key} is not a sha256 digest`);
  if (!Array.isArray(evidence.captures)) throw new Error("evidence.captures must be an array");
  for (const capture of evidence.captures) {
    exactKeys(capture, ["step", "atMs", "screenshot", "aria", "visibleText"], [], "evidence.captures[]");
    if (typeof capture.screenshot !== "string" || !SCREENSHOT.test(capture.screenshot)) throw new Error("evidence.captures[].screenshot must be a bare .png file name");
  }
  for (const key of ["seedOperations", "assertions", "limitations"]) if (!Array.isArray(evidence[key])) throw new Error(`evidence.${key} must be an array`);
}

/** Replaces absolute paths in every string and key; throws on a credential shape. */
export function sanitizeEvidence(evidence) {
  let replaced = 0;
  const clean = (value) => {
    if (CREDENTIAL.test(value)) throw new Error("evidence contains a credential-shaped string");
    return ABSOLUTE_PATHS.reduce((text, pattern) => text.replace(pattern, () => { replaced++; return "<absolute-path>"; }), value);
  };
  const walk = (value) => {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) return value.map(walk);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), walk(item)]));
    return value;
  };
  const sanitized = walk(evidence);
  return { evidence: { ...sanitized, sanitization: { absolutePathsReplaced: replaced } }, replaced };
}

function evidenceFiles(root) {
  const found = [];
  const rejected = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { if (entry.name === EVIDENCE_FILE) rejected.push({ file: path.relative(root, file), reason: "evidence file is a symbolic link" }); continue; }
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === EVIDENCE_FILE) found.push(file);
    }
  };
  visit(root);
  return { found, rejected };
}

function readPng(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error("referenced screenshot is not a regular file");
  const bytes = fs.readFileSync(file);
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error("referenced screenshot is not a PNG");
  return bytes;
}

/** Copies validated evidence from `from` into a new or empty `to`. */
export function stageEvidence({ from, to, sha }) {
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) throw new Error("Staging directory must be new or empty");
  fs.mkdirSync(to, { recursive: true });
  const report = { staged: [], rejected: [], pngs: 0, pathsReplaced: 0 };
  if (!fs.existsSync(from)) return report;
  const { found, rejected } = evidenceFiles(from);
  report.rejected.push(...rejected);
  for (const file of found) {
    const relative = path.relative(from, file);
    const directory = path.dirname(file);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      validateEvidence(parsed, sha);
      const { evidence, replaced } = sanitizeEvidence(parsed);
      const screenshots = [...new Set(parsed.captures.map((capture) => capture.screenshot))]
        .map((name) => ({ name, bytes: readPng(path.join(directory, name)) }));
      const target = path.join(to, path.dirname(relative));
      fs.mkdirSync(target, { recursive: true });
      for (const { name, bytes } of screenshots) fs.writeFileSync(path.join(target, name), bytes);
      fs.writeFileSync(path.join(target, EVIDENCE_FILE), JSON.stringify(evidence, null, 2));
      report.staged.push({ file: relative, scenario: evidence.scenario?.id, mode: evidence.mode, status: evidence.status, recipeDigest: evidence.recipeDigest, seedDigest: evidence.seedDigest, dirty: evidence.runtime.atSave.trackedWorktreeDirty });
      report.pngs += screenshots.length;
      report.pathsReplaced += replaced;
    } catch (error) {
      // JSON and fs errors name absolute paths and evidence content; the reason
      // printed to a public log stays relative and bounded.
      const reason = sanitizeReason(error);
      report.rejected.push({ file: relative, reason });
    }
  }
  return report;
}

function sanitizeReason(error) {
  const text = String(error instanceof Error ? error.message : error).slice(0, 300);
  return ABSOLUTE_PATHS.reduce((value, pattern) => value.replace(pattern, "<absolute-path>"), text);
}

/** Markdown for the run page. Goes to the step summary, never into the artifact. */
export function summarize(report, sha) {
  const failed = report.staged.filter((row) => row.status === "failed").length;
  const recipes = new Set(report.staged.map((row) => row.recipeDigest)).size;
  return [
    "### Attention evidence",
    `- Commit: \`${sha}\``,
    `- Rows staged: ${report.staged.length} (${failed} failed), PNGs: ${report.pngs}, distinct recipes: ${recipes}`,
    `- Tracked tree dirty on: ${report.staged.filter((row) => row.dirty).length} rows`,
    `- Absolute paths replaced: ${report.pathsReplaced}`,
    `- Rejected, not uploaded: ${report.rejected.length}`,
    ...report.rejected.map(({ file, reason }) => `  - \`${file}\`: ${reason}`),
    "",
  ].join("\n");
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const sha = argument("sha");
    const report = stageEvidence({ from: argument("from"), to: argument("to"), sha });
    const summary = summarize(report, sha);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (report.rejected.length > 0) throw new Error("Some evidence failed validation and was not staged");
    if (report.staged.length === 0) throw new Error("No evidence was produced");
  } catch (error) {
    console.error(`[attention-evidence] ${sanitizeReason(error)}`);
    process.exit(1);
  }
}
