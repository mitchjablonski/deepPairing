#!/usr/bin/env node
/**
 * #430 slice 2 — the only route from the attention walkthrough output to an
 * uploaded artifact. It copies into a fresh directory, so the workflow can't
 * upload anything this script didn't validate:
 *
 *  - each evidence.v1.json must match the known shape, at every depth, and the
 *    dispatched SHA;
 *  - absolute and home-relative paths in any string are replaced (a failure
 *    message or the project-root UI text can carry the mkdtemp sandbox or runner
 *    workspace). URLs, relative text and a short list of app routes are kept;
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
const REDACTED_PATH = "<absolute-path>";
const PATH_END = "[^\\s\"'`<>()\\[\\]{},;]*";

// Scans left to right, so a URL is consumed whole before its path can look like
// a filesystem path. Everything else that is rooted is a path whatever its root
// is called. Relative text (a/b, ./x, ../x, OFF/ON, 1/2) never matches.
const PATH_CANDIDATE = new RegExp([
  `(?<url>\\b(?:https?|wss?)://${PATH_END})`,
  `\\bfile:/{1,3}${PATH_END}`,
  `(?<rooted>(?<![\\w.~/<\\\\-])/${PATH_END})`,
  `(?<![\\w/.-])~[\\w-]*[/\\\\]${PATH_END}`,
  `(?<!\\w)(?:\\$HOME|\\$\\{HOME\\}|%USERPROFILE%|%HOMEPATH%)${PATH_END}`,
  `(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]${PATH_END}`,
  `(?<![\\w\\\\.])\\\\{1,2}[^\\s\\\\]+\\\\${PATH_END}`,
].join("|"), "gi");
// The rooted strings the UI legitimately shows. Anything else rooted is redacted.
const ALLOWED_ROOTED = [
  /^\/+$/, // A bare separator: "Escape / Home".
  /^\/\?[^/]*$/, // This app's own deep link: "/?session=abc".
  /^\/api(?:\/(?!\.\.?(?:\/|$))[\w.:~%-]+)*\/?(?:\?\S*)?$/, // A daemon route, never a traversal.
  /^\/ws(?:\?\S*)?$/,
  /^\/(?:url|placeholder|children):$/, // Playwright aria-snapshot properties.
  /^\/deeppairing:[a-z-]+$/, // A slash command named in UI copy.
];
const CREDENTIAL = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{16,})/;

function redactPaths(text, onReplace = () => undefined) {
  return text.replace(PATH_CANDIDATE, (match, ...rest) => {
    const groups = rest[rest.length - 1];
    if (groups.url) return match;
    if (groups.rooted && ALLOWED_ROOTED.some((allowed) => allowed.test(match))) return match;
    onReplace();
    return REDACTED_PATH;
  });
}

// A small typed schema: every object is a closed key list and every string,
// array and dynamic field is bounded. Bounds are about twice the harness LIMITS
// because the harness redacts after truncating, which can lengthen a string.
const fail = (at, why) => { throw new Error(`${at} ${why}`); };
const string = (max = 1000) => (value, at) => {
  if (typeof value !== "string") fail(at, "must be a string");
  if (value.length > max) fail(at, `is longer than ${max}`);
};
const number = (value, at) => { if (typeof value !== "number" || !Number.isFinite(value)) fail(at, "must be a number"); };
const boolean = (value, at) => { if (typeof value !== "boolean") fail(at, "must be a boolean"); };
const literal = (expected) => (value, at) => { if (value !== expected) fail(at, `must be ${expected}`); };
const nullable = (check) => (value, at) => { if (value !== null) check(value, at); };
const oneOf = (...allowed) => (value, at) => { if (!allowed.includes(value)) fail(at, `is not one of ${allowed.join("/")}`); };
const pattern = (regex, description) => (value, at) => { if (typeof value !== "string" || !regex.test(value)) fail(at, `must be ${description}`); };
const array = (check, max) => (value, at) => {
  if (!Array.isArray(value)) fail(at, "must be an array");
  if (value.length > max) fail(at, `has more than ${max} entries`);
  value.forEach((item, i) => check(item, `${at}[${i}]`));
};
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const object = (required, optional = {}) => (value, at) => {
  if (!isRecord(value)) fail(at, "must be an object");
  for (const key of Object.keys(value)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) fail(at, `has unexpected key "${key}"`);
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(value, key)) fail(at, `is missing "${key}"`);
    check(value[key], `${at}.${key}`);
  }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(value, key)) check(value[key], `${at}.${key}`);
};

// Seed bodies are the one free-form tree: synthetic artifact content. They stay
// bounded, and a key that names an out-of-scope payload is refused at any depth.
const SEED_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const OUT_OF_SCOPE_KEY = /^(?:env|environment|headers?|cookies?|trace|traces|har|network|logs?|stdout|stderr|video|tokens?|authorization|password|secrets?|credentials?|api_?key)$/i;
const SEED_BODY_LIMITS = { depth: 10, nodes: 2000, string: 4000 };
function seedBody(value, at) {
  let nodes = 0;
  const visit = (node, depth) => {
    if (++nodes > SEED_BODY_LIMITS.nodes) fail(at, `has more than ${SEED_BODY_LIMITS.nodes} values`);
    if (depth > SEED_BODY_LIMITS.depth) fail(at, `is deeper than ${SEED_BODY_LIMITS.depth}`);
    if (node === null || typeof node === "boolean" || typeof node === "number") return;
    if (typeof node === "string") { string(SEED_BODY_LIMITS.string)(node, at); return; }
    if (Array.isArray(node)) { node.forEach((item) => visit(item, depth + 1)); return; }
    if (!isRecord(node)) fail(at, "holds a non-JSON value");
    for (const [key, item] of Object.entries(node)) {
      if (!SEED_KEY.test(key)) fail(at, "has a key that isn't a plain field name");
      if (OUT_OF_SCOPE_KEY.test(key)) fail(at, `has out-of-scope key "${key}"`);
      visit(item, depth + 1);
    }
  };
  if (!isRecord(value)) fail(at, "must be an object");
  visit(value, 0);
}
function seedOperation(value, at) {
  if (isRecord(value) && Object.hasOwn(value, "operation")) { object({ operation: literal("restart") })(value, at); return; }
  object({
    session: pattern(/^[a-z0-9_-]{1,64}$/i, "a synthetic session id"),
    route: pattern(/^[a-z][a-z0-9_/-]{0,127}$/i, "a daemon route"),
    body: seedBody,
  })(value, at);
}

const digest = pattern(HEX64, "a sha256 digest");
export const PROVENANCE_KEYS = {
  gitSha: pattern(GIT_SHA, "a full commit id"), trackedWorktreeDirty: boolean, trackedDiffSha256: digest,
  daemonEntrySha256: digest, distManifestSha256: digest, distFiles: number, webManifestSha256: digest, webFiles: number,
  sharedManifestSha256: digest, harnessSourceSha256: digest, lockfileSha256: digest,
};
const provenance = object(PROVENANCE_KEYS);
const ariaText = string(32_768);
export const ARIA_KEYS = { nextUp: ariaText, pending: ariaText, sessions: ariaText, main: ariaText };
const top = nullable(number);
const shortText = nullable(string(1200));
export const LAYOUT_KEYS = {
  step: string(100), atMs: number, settled: boolean, viewportHeight: number,
  mainTop: top, mainTopPct: top, sidebarTop: top, sidebarFirstContentTop: top, detailPaneTop: top, detailFirstContentTop: top,
  agentsFilterSurface: oneOf("menu", "row", "none"), sidebarRows: number,
  openArtifactId: nullable(string(200)), pendingLead: shortText, nextUpText: shortText,
};
const REQUIRED_KEYS = {
  schemaVersion: literal(1),
  runtime: object({
    gitSha: pattern(GIT_SHA, "a full commit id"), node: string(40), platform: string(40), playwright: string(40), browser: string(80),
    startups: array(provenance, 16), atSave: provenance, builtRuntimeStable: boolean, provenanceLimit: string(),
  }),
  syntheticOnly: literal(true),
  status: oneOf("passed", "failed"),
  cleanup: oneOf("removed", "retained"),
  mode: oneOf("OFF", "ON"),
  theme: oneOf("dark", "light"),
  viewport: object({ width: number, height: number }),
  scenario: object({ id: string(100), task: string(300), boundSession: string(64) }),
  matrix: object({ caseCount: number, cases: array(string(200), 200) }),
  seedDigest: digest,
  seedOperations: array(seedOperation, 200),
  recipeDigest: digest,
  keyboard: object({
    presses: number, truncated: boolean,
    events: array(object({
      key: string(40), atMs: number,
      focused: object({ tag: string(40), role: nullable(string(80)), name: string(1200), testId: nullable(string(200)), disabled: boolean }),
    }), 1024),
  }),
  clocks: object({ keyboardAndCaptures: string(), liveRegions: string() }),
  assertions: array(object({ label: string(), passed: boolean }), 500),
  captures: array(object({
    step: string(100), atMs: number, screenshot: pattern(SCREENSHOT, "a bare .png file name"),
    aria: object({}, ARIA_KEYS), visibleText: string(24_000),
  }), 50),
  liveRegions: object(
    { entries: array(object({ atMs: number, role: nullable(string(80)), live: nullable(string(40)), text: string(1200) }), 256), truncated: boolean },
    { unavailable: literal(true) },
  ),
  limitations: array(string(), 20),
};
export const EVIDENCE_TOP_LEVEL_KEYS = Object.keys(REQUIRED_KEYS);
const evidenceSchema = object(REQUIRED_KEYS, { layout: array(object(LAYOUT_KEYS), 20), failure: string(4000) });

/** Throws on anything but the shape AttentionEvidence.save writes, at any depth. */
export function validateEvidence(evidence, sha) {
  if (!GIT_SHA.test(sha)) throw new Error("Expected SHA must be a full 40-character commit id");
  evidenceSchema(evidence, "evidence");
  const { runtime } = evidence;
  for (const [at, value] of [["runtime", runtime], ["runtime.atSave", runtime.atSave], ...runtime.startups.map((start, i) => [`runtime.startups[${i}]`, start])]) {
    if (value.gitSha !== sha) throw new Error(`evidence.${at}.gitSha is not the dispatched SHA`);
  }
}

/** Replaces private paths in every string and key; throws on a credential shape. */
export function sanitizeEvidence(evidence) {
  let replaced = 0;
  const clean = (value) => {
    if (CREDENTIAL.test(value)) throw new Error("evidence contains a credential-shaped string");
    return redactPaths(value, () => { replaced++; });
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
  return redactPaths(String(error instanceof Error ? error.message : error).slice(0, 300));
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
