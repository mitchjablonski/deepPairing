/**
 * "Write to your pair" — the house prose linter.
 *
 * WHY THIS EXISTS. A corpus pass over 258k words of real deepPairing artifact
 * prose found a measurable *compression register*: per 1k words, 35.9
 * parentheticals (about one per sentence), 28.0 ALL-CAPS emphasis words, 27.5
 * semicolons, 10.1 slash-packs, 6.9 em-dashes, 1.8 arrow chains and 3.6
 * hyphen-stacked coinages, with 26% of sentences over 25 words. Classic
 * "AI slop" vocabulary (delve, leverage, hedging boilerplate) was almost
 * absent — so this linter targets COMPRESSION, not a slop word list. The one
 * curated substitution map (tier 3) is small on purpose.
 *
 * WHERE IT RUNS. This module is pure, dependency-free and deterministic so the
 * MCP server (which appends a STYLE block to present_* tool results) and the
 * companion web UI (which renders the clarity chip) run the EXACT same rules.
 * Rules can never drift between the two surfaces because there is one copy.
 *
 * WHAT IT IS NOT. It never blocks, never rewrites and never rejects. It scores
 * and it names what it saw.
 */

// --- public types -----------------------------------------------------------

/** Strict is for fields the human ACTS on (a recommendation, an ask, a step
 *  instruction). Flavored is for narrative fields, where a little more room to
 *  breathe is fine. */
export type ProseMode = "strict" | "flavored";

export type ProseSeverity = "high" | "medium" | "low";

/** 1 = the compression register (the corpus headline), 2 = structure,
 *  3 = the small curated wordiness map. */
export type ProseTier = 1 | 2 | 3;

export interface Violation {
  ruleId: string;
  severity: ProseSeverity;
  message: string;
  /** A short quote from the ORIGINAL text, never longer than 80 chars. */
  excerpt: string;
  /** Character offset into the original text. Masking preserves offsets. */
  index: number;
}

export interface LintOptions {
  mode?: ProseMode;
}

export interface LintResult {
  violations: Violation[];
  /** 0-100, higher is better. See SCORING below. */
  score: number;
}

/** One sentence of prose, with its offset in the original text. */
export interface ProseSentence {
  text: string;
  index: number;
  /** Word count, after masking (code/URLs/paths contribute nothing). */
  words: number;
}

/** One blank-line-delimited paragraph of prose. */
export interface ProseParagraph {
  text: string;
  index: number;
  sentences: ProseSentence[];
}

export interface LintContext {
  mode: ProseMode;
  /** The text exactly as the agent wrote it. */
  original: string;
  /** The text with code, tables, URLs and paths blanked to spaces. Offsets
   *  match `original` one-for-one. */
  masked: string;
  paragraphs: ProseParagraph[];
  sentences: ProseSentence[];
}

export interface ProseRule {
  id: string;
  tier: ProseTier;
  severity: ProseSeverity;
  modes: ProseMode[];
  check: (text: string, ctx: LintContext) => Violation[];
}

// --- tunables (exported so callers/tests can read the thresholds) -----------

export const SENTENCE_WORD_LIMIT: Record<ProseMode, number> = {
  flavored: 25,
  strict: 20,
};

/** One parenthetical per this many sentences is the budget. */
export const PARENTHETICAL_SENTENCES_PER = 3;

/** A parenthetical shorter than this is an aside, not a clause — ignored. */
export const PARENTHETICAL_MIN_CHARS = 15;

/** Paragraphs longer than this are flagged by `paragraph-length`. */
export const PARAGRAPH_SENTENCE_LIMIT = 5;

/** Em-dashes allowed per paragraph. */
export const EM_DASH_PER_PARAGRAPH = 1;

/**
 * ALL-CAPS tokens that are names, not shouting. Exported so a consuming
 * project can extend it (`[...ALL_CAPS_WHITELIST, "FOO"]`). Only 3+ letter
 * entries can ever match — the shorter ones are listed for documentation and
 * for anyone extending the check.
 */
export const ALL_CAPS_WHITELIST: readonly string[] = [
  // Protocols, formats, platform words.
  "API", "APIS", "ABI", "AST", "ASCII", "AWS", "CDN", "CI", "CD", "CLI", "CORS",
  "CPU", "CRUD", "CSS", "CSV", "DNS", "DOM", "DTO", "DX", "E2E", "EOF", "ENV",
  "ETA", "GCP", "GIF", "GNU", "GPL", "GPU", "GRPC", "HTML", "HTTP", "HTTPS",
  "ID", "IDE", "IO", "ISO", "JPEG", "JPG", "JS", "JSON", "JSX", "JWT", "LLM",
  "LRU", "MCP", "MD", "MFA", "MIT", "NAT", "NPM", "OAUTH", "OK", "ORM", "OS",
  "PDF", "PII", "PNG", "PNPM", "PR", "PRS", "QA", "QPS", "RAM", "REPL", "REST",
  "RFC", "RPC", "RSS", "SDK", "SHA", "SLA", "SLO", "SSE", "SSH", "SQL", "SSL",
  "SSO", "SVG", "TCP", "TLS", "TODO", "TSX", "TS", "TTL", "UDP", "UI", "URI",
  "URL", "UTC", "UTF", "UUID", "UX", "VM", "VS", "WCAG", "WS", "WSL", "XML",
  "YAML", "README", "FIXME", "NOTE", "WIP",
  // SQL verbs and HTTP methods read as symbol names, not shouting.
  "SELECT", "JOIN", "INSERT", "UPDATE", "GET", "POST", "PUT", "PATCH", "DELETE",
  "HEAD", "OPTIONS",
  // Standards and house shorthand that show up in this project's own prose.
  "BDA", "STE", "PMF", "SOTA",
  // deepPairing's own enum literals. These are field VALUES the agent is
  // quoting back, not emphasis: a `significance: "high"` reads as HIGH.
  "HIGH", "MEDIUM", "LOW", "WARN", "INFO", "ERROR", "DEBUG", "TRACE",
  "DRAFT", "APPROVED", "REJECTED", "PENDING", "REVIEWING", "SUPERSEDED",
  "WITHDRAWN", "RETRACTED", "OBSOLETE",
];

/**
 * Ordinary English words that get set in capitals for emphasis. A LONE
 * all-caps token only counts as shouting when it is one of these (or sits in a
 * run of capitalised words). Everything else that is not on the whitelist is
 * far more likely to be an acronym nobody has listed yet — "SPOF", "SQS",
 * "MRTR" — and scolding the author for naming a thing is the worst failure
 * this rule can have. Exported so a project can extend it.
 */
export const ALL_CAPS_EMPHASIS_WORDS: readonly string[] = [
  "ALL", "ALREADY", "ALWAYS", "AND", "ANY", "ANYTHING", "ARE", "BAD", "BEFORE",
  "BEST", "BOTH", "BROKEN", "BUT", "CAN", "DEAD", "DELIBERATELY", "DID", "DOES",
  "DONE", "EACH", "ENTIRELY", "EVEN", "EVER", "EVERY", "EVERYTHING", "EXACT",
  "EXACTLY", "FALSE", "FAR", "FEW", "FIRST", "FIX", "FIXED", "FULL", "GOOD",
  "HAD", "HAS", "HAVE", "HERE", "HOW", "HUGE", "INSTEAD", "ITS", "JUST", "KEEP",
  "LAST", "LEAST", "LESS", "LIVE", "LONG", "LOST", "MANY", "MORE", "MOST",
  "MUCH", "MUST", "NEED", "NEVER", "NEW", "NEXT", "NONE", "NOPE", "NOT",
  "NOTHING", "NOW", "OFF", "OLD", "ONCE", "ONE", "ONLY", "OUT", "OVER", "OWN",
  "RATHER", "REAL", "REALLY", "RESEARCH", "RIGHT", "SAME", "SETTLED", "SHOULD",
  "SILENTLY", "SOME", "SOMETHING", "STILL", "STOP", "SUCH", "SURE", "TAKE",
  "THAN", "THAT", "THEIR", "THEM", "THEN", "THERE", "THESE", "THEY", "THIS",
  "THOSE", "THE", "TOO", "TRUE", "TWO", "UNDER", "UNTIL", "VERY", "WAS", "WERE",
  "WHAT", "WHEN", "WHERE", "WHETHER", "WHICH", "WHILE", "WHO", "WHY", "WILL",
  "WITH", "WITHOUT", "WORKING", "WORKS", "WORSE", "WORST", "WRONG", "YES",
  "YET", "YOU", "YOUR",
];

/**
 * Slash pairs that are established compounds, not compression. Kept small on
 * purpose — the `\w{3,}/\w{3,}` shape already excludes "and/or", "n/a", "w/o",
 * "I/O" and every date/version shape, so this list only covers genuine
 * three-plus-letter idioms.
 */
export const SLASH_PACK_EXCEPTIONS: readonly string[] = [
  "tcp/ip", "and/or", "read/write", "input/output", "pass/fail", "yes/no",
  "his/her", "her/his", "she/he", "date/time", "true/false", "http/https",
];

/**
 * First-segment words that make a slash-run a REPO PATH rather than a word
 * pack. An extension-less path ("packages/shared/src") looks exactly like
 * compression to a regex, so the masker uses this list to tell them apart.
 * Kept to directory names a source tree actually uses.
 */
export const SOURCE_ROOT_WORDS: readonly string[] = [
  "packages", "src", "app", "apps", "lib", "libs", "test", "tests", "docs",
  "web", "scripts", "dist", "node_modules", "claude-plugin", "components",
  "hooks", "store", "mcp", "http",
];

/**
 * Number words, so a written ratio ("two/thirds") is not read as a word pack.
 * Bare digit runs ("3/4", "12/31/2026") are handled separately.
 */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "twenty", "thirty", "forty", "fifty",
  "hundred", "thousand", "million", "billion", "half", "halves", "third",
  "thirds", "quarter", "quarters", "fifth", "fifths", "sixth", "sixths",
  "eighth", "eighths", "tenth", "tenths",
]);

/**
 * Ordinary English compounds that happen to stack three or more hyphenated
 * parts. None of them is a coinage, so `undefined-coinage` must never ask an
 * author to define "end-to-end". Matched case-insensitively.
 */
export const COMMON_HYPHEN_COMPOUNDS: readonly string[] = [
  "end-to-end", "out-of-the-box", "up-to-date", "out-of-date", "one-to-one",
  "many-to-many", "one-to-many", "many-to-one", "day-to-day", "state-of-the-art",
  "well-thought-out", "peer-to-peer", "copy-on-write", "one-size-fits-all",
  "first-come-first-served", "face-to-face", "side-by-side", "back-and-forth",
  "hand-in-hand", "all-or-nothing", "off-the-shelf", "step-by-step",
  "line-by-line", "word-for-word", "apples-to-apples", "point-to-point",
  "run-of-the-mill", "on-the-fly", "out-of-band", "out-of-scope",
  "nice-to-have", "trial-and-error", "cause-and-effect", "black-and-white",
  "up-and-running", "plug-and-play", "drag-and-drop", "copy-and-paste",
  "mix-and-match", "tried-and-true", "man-in-the-middle", "time-to-live",
  "point-in-time", "right-to-left", "left-to-right", "top-to-bottom",
  "bottom-to-top", "pay-as-you-go", "over-the-wire", "as-a-service",
  "best-of-breed", "least-recently-used", "first-in-first-out",
  "last-in-first-out", "so-and-so", "give-and-take", "wait-and-see",
];

/**
 * Base verbs that make a sentence read as an instruction. Used by the
 * strict-only `trailing-condition` rule, which only fires on an imperative —
 * a descriptive sentence ending in a condition is perfectly good prose.
 */
export const IMPERATIVE_VERBS: readonly string[] = [
  "add", "avoid", "call", "check", "delete", "do", "don't", "drop", "fix",
  "keep", "make", "move", "name", "never", "pass", "prefer", "put", "read",
  "remove", "rename", "replace", "return", "run", "set", "ship", "split",
  "start", "stop", "use", "wrap", "write",
];

/**
 * Tier 3 — the curated wordiness map. Deliberately ~15 entries. We do NOT
 * vendor a big "AI words" list: the corpus showed that vocabulary is not this
 * codebase's problem, and a long list is mostly false positives.
 * An empty replacement means "delete the phrase".
 */
export const WORDINESS_MAP: Readonly<Record<string, string>> = {
  "in order to": "to",
  "utilize": "use",
  "leverage": "use",
  "prior to": "before",
  "it's worth noting that": "",
  "it is important to note that": "",
  "note that": "",
  "as mentioned above": "",
  "a number of": "some",
  "in addition": "also",
  "due to the fact that": "because",
  "at this point in time": "now",
  "perform an analysis of": "analyze",
  "provides assistance to": "helps",
  "make use of": "use",
};

/** Score deduction per violation, before length normalization. */
export const SEVERITY_WEIGHT: Readonly<Record<ProseSeverity, number>> = {
  high: 8,
  medium: 4,
  low: 1,
};

// --- preprocessing ----------------------------------------------------------

const BLANK = " ";

/** Replace [start, end) with spaces, preserving newlines so paragraph and line
 *  structure (and every character offset) survives masking. */
function blank(chars: string[], start: number, end: number): void {
  for (let i = start; i < end && i < chars.length; i++) {
    if (chars[i] !== "\n") chars[i] = BLANK;
  }
}

/**
 * Blank out everything a prose rule must never see: fenced code blocks, inline
 * code spans, markdown tables, URLs and file paths. Offsets are preserved
 * exactly, so a violation index computed on the masked string points at the
 * same character in the original.
 */
export function maskNonProse(text: string): string {
  const chars = text.split("");

  // 1. Fenced code blocks (``` or ~~~), including the fences themselves.
  const fence = /^[ \t]*(?:```|~~~)/gm;
  let openAt: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (openAt === null) {
      openAt = m.index;
    } else {
      const lineEnd = text.indexOf("\n", m.index);
      blank(chars, openAt, lineEnd === -1 ? text.length : lineEnd);
      openAt = null;
    }
  }
  // An unterminated fence swallows the rest of the text — a half-written code
  // block is still code, and linting it would be pure noise.
  if (openAt !== null) blank(chars, openAt, text.length);

  const masked0 = chars.join("");

  // 2. Inline code spans. Run on the fence-masked copy so a backtick inside a
  //    fenced block can't pair with one outside it.
  const span = /`[^`\n]*`/g;
  while ((m = span.exec(masked0)) !== null) {
    blank(chars, m.index, m.index + m[0].length);
  }

  const masked1 = chars.join("");

  // 3. Markdown table rows and separator rules — a row is not a sentence.
  const tableLine = /^[ \t]*\|.*$|^[ \t]*[:\- |]{6,}$/gm;
  while ((m = tableLine.exec(masked1)) !== null) {
    if (m[0].trim().length === 0) continue;
    blank(chars, m.index, m.index + m[0].length);
  }

  const masked2 = chars.join("");

  // 4. URLs (bare or inside a markdown link target).
  const url = /\b(?:https?|ftp|file|ws|wss):\/\/[^\s)\]]+/gi;
  while ((m = url.exec(masked2)) !== null) {
    blank(chars, m.index, m.index + m[0].length);
  }

  const masked3 = chars.join("");

  // 5. Blockquote lines. A `>` line is text the agent is QUOTING — the human's
  //    own words, a log line, a spec excerpt. It is not the agent's register,
  //    so linting it would scold the author for someone else's punctuation.
  const quoteLine = /^[ \t]*>.*$/gm;
  while ((m = quoteLine.exec(masked3)) !== null) {
    blank(chars, m.index, m.index + m[0].length);
  }

  const masked4 = chars.join("");

  // 6. File paths. A slash-run counts as a path when it is anchored (`./`,
  //    `../`, `/`, `~/`), when any segment carries a file extension, or when
  //    it is shaped like a repo path — see isRepoPath. That deliberately
  //    leaves bare word-packs like "build/test/deploy" visible, which are the
  //    compression the `slash-pack` rule is here to catch.
  const pathRe = /(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g;
  while ((m = pathRe.exec(masked4)) !== null) {
    // Drop sentence punctuation the greedy class swallowed ("…/prose-lint.ts."),
    // or the trailing period hides the extension and the path reads as a pack.
    const tok = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!tok.includes("/")) continue;
    const anchored = /^(?:~\/|\.{1,2}\/|\/)/.test(tok);
    const hasExtension = tok.split("/").some((seg) => /^[\w@+-][\w.@+-]*\.[A-Za-z]{1,6}$/.test(seg));
    if (anchored || hasExtension || isRepoPath(tok)) blank(chars, m.index, m.index + tok.length);
  }

  return chars.join("");
}

/**
 * An EXTENSION-LESS repo path, told apart from a word pack. Two shapes count:
 * a run whose first segment is a source-root directory name
 * ("packages/shared/src"), and a deep run of four or more segments, which no
 * one writes as prose compression.
 *
 * Three-segment runs are deliberately NOT masked on depth alone. That is
 * exactly the shape of the canonical pack — "build/test/deploy" — and losing
 * it would gut the rule. Write an extension-less three-segment path in
 * backticks and it masks as code.
 */
const REPO_PATH_MIN_DEEP_SEGMENTS = 4;

/**
 * The subset of SOURCE_ROOT_WORDS that is safe to match ANYWHERE in a run, not
 * just at the front. "test", "store", "app" and friends are left out because
 * they are also ordinary English words, and a middle segment is exactly where
 * a word pack puts one — "build/test/deploy" is the canonical pack and it must
 * keep firing.
 */
const INNER_ROOT_WORDS: ReadonlySet<string> = new Set([
  "packages", "src", "lib", "libs", "node_modules", "claude-plugin",
  "components", "dist", "scripts", "mcp",
]);

function isRepoPath(token: string): boolean {
  const segments = token.replace(/\/+$/, "").split("/");
  if (segments.length < 2) return false;
  const roots = new Set(SOURCE_ROOT_WORDS);
  if (roots.has((segments[0] ?? "").toLowerCase())) return true;
  if (segments.length >= REPO_PATH_MIN_DEEP_SEGMENTS) return true;
  // A three-segment run still reads as a path when one of its inner segments
  // is an unmistakable source directory ("my-app/src/store").
  return segments.length >= 3 && segments.some((s) => INNER_ROOT_WORDS.has(s.toLowerCase()));
}

/** Lines that are structure, not prose: headings, list bullets, blockquotes and
 *  the leftovers of a masked table row. */
function isStructuralLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return true;
  if (/^#{1,6}\s/.test(t)) return true; // heading
  if (/^[-*+]\s*$/.test(t)) return true; // empty bullet
  if (/^>\s/.test(t)) return true; // blockquote marker line
  if (/^[-=_*]{3,}$/.test(t)) return true; // horizontal rule
  return false;
}

/** Strip a leading list/blockquote marker so "- Use the store." lints as a
 *  sentence rather than as a bullet glyph plus a fragment. */
function stripLeadingMarker(line: string): { text: string; shift: number } {
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+|\s*>\s+)/.exec(line);
  if (!m) return { text: line, shift: 0 };
  return { text: line.slice(m[0].length), shift: m[0].length };
}

function countWords(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/**
 * Split masked text into paragraphs and sentences, carrying original offsets.
 * Sentence splitting is `(?<=[.!?])\s+`, which over-splits abbreviations
 * ("e.g. the store") — that is the conservative direction: a shorter fragment
 * cannot trip the length rule.
 */
export function splitProse(masked: string): ProseParagraph[] {
  const paragraphs: ProseParagraph[] = [];
  // Paragraph = run of non-blank lines.
  const blockRe = /[^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(masked)) !== null) {
    if (m[0].length === 0) {
      blockRe.lastIndex++;
      if (blockRe.lastIndex > masked.length) break;
      continue;
    }
    const blockStart = m.index;
    const block = m[0];
    if (block.trim().length === 0) continue;

    const sentences: ProseSentence[] = [];
    // Walk line by line so list markers and headings are handled per-line.
    let lineOffset = 0;
    for (const line of block.split("\n")) {
      const lineStart = blockStart + lineOffset;
      lineOffset += line.length + 1;
      if (isStructuralLine(line)) continue;
      if (/^#{1,6}\s/.test(line.trim())) continue;
      const { text: body, shift } = stripLeadingMarker(line);
      let cursor = 0;
      for (const piece of body.split(/(?<=[.!?])\s+/)) {
        const at = body.indexOf(piece, cursor);
        const start = at === -1 ? cursor : at;
        cursor = start + piece.length;
        const trimmedLead = piece.length - piece.trimStart().length;
        const text = piece.trim();
        if (!text) continue;
        sentences.push({
          text,
          index: lineStart + shift + start + trimmedLead,
          words: countWords(text),
        });
      }
    }
    if (sentences.length === 0) continue;
    paragraphs.push({ text: block, index: blockStart, sentences });
  }
  return paragraphs;
}

// --- helpers ----------------------------------------------------------------

const EXCERPT_MAX = 80;

/** A short, single-line quote from the original text, never over 80 chars. */
export function excerptAt(original: string, index: number, length: number): string {
  const raw = original.slice(Math.max(0, index), Math.max(0, index) + Math.max(1, length));
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

function v(
  rule: { id: string; severity: ProseSeverity },
  message: string,
  ctx: LintContext,
  index: number,
  length: number,
): Violation {
  return {
    ruleId: rule.id,
    severity: rule.severity,
    message,
    excerpt: excerptAt(ctx.original, index, length),
    index,
  };
}

// --- tier 1: the compression register ---------------------------------------

const sentenceLength: ProseRule = {
  id: "sentence-length",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (_text, ctx) => {
    const limit = SENTENCE_WORD_LIMIT[ctx.mode];
    return ctx.sentences
      .filter((s) => s.words > limit)
      .map((s) =>
        v(
          sentenceLength,
          `${s.words}-word sentence (limit ${limit}) — split it. One idea per sentence.`,
          ctx,
          s.index,
          s.text.length,
        ),
      );
  },
};

/** All balanced top-level paren groups, plus any nested opener inside them. */
function scanParens(masked: string): { groups: Array<{ start: number; end: number }>; nested: number[] } {
  const groups: Array<{ start: number; end: number }> = [];
  const nested: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") {
      if (stack.length > 0) nested.push(i);
      stack.push(i);
    } else if (c === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      if (stack.length === 0) groups.push({ start, end: i + 1 });
    }
  }
  return { groups, nested };
}

const parentheticalDensity: ProseRule = {
  id: "parenthetical-density",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const out: Violation[] = [];
    const { groups, nested } = scanParens(text);
    const substantial = groups.filter((g) => g.end - g.start - 2 >= PARENTHETICAL_MIN_CHARS);
    const sentenceCount = Math.max(1, ctx.sentences.length);
    const budget = Math.max(1, Math.ceil(sentenceCount / PARENTHETICAL_SENTENCES_PER));
    const first = substantial[0];
    if (substantial.length > budget && first) {
      out.push(
        v(
          parentheticalDensity,
          `${substantial.length} parentheticals across ${sentenceCount} sentence${sentenceCount === 1 ? "" : "s"} (budget ${budget}) — an aside that matters should be its own sentence.`,
          ctx,
          first.start,
          first.end - first.start,
        ),
      );
    }
    for (const at of nested) {
      out.push(
        v(
          parentheticalDensity,
          "Nested parenthetical — an aside inside an aside is never readable.",
          ctx,
          at,
          40,
        ),
      );
    }
    return out;
  },
};

const semicolon: ProseRule = {
  id: "semicolon",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const out: Violation[] = [];
    const re = /;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Skip HTML/character entities (&amp; &#8212;) — not prose punctuation.
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/&#?\w+$/.test(before)) continue;
      out.push(v(semicolon, "Semicolon — split it into two sentences.", ctx, m.index, 60));
    }
    return out;
  },
};

/** Start of the line containing `index`. */
function lineStartAt(text: string, index: number): number {
  const at = text.lastIndexOf("\n", Math.max(0, index - 1));
  return at === -1 ? 0 : at + 1;
}

/** End of the line containing `index` (exclusive). */
function lineEndAt(text: string, index: number): number {
  const at = text.indexOf("\n", index);
  return at === -1 ? text.length : at;
}

/** True when `index` sits inside a double-quoted run on its own line, straight
 *  or smart. A quoted ALL-CAPS token is a value being reported, not a shout. */
function insideQuotes(text: string, index: number): boolean {
  const line = text.slice(lineStartAt(text, index), lineEndAt(text, index));
  const at = index - lineStartAt(text, index);
  let openStraight = false;
  let openSmart = false;
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (c === '"') openStraight = !openStraight;
    else if (c === "“") openSmart = true;
    else if (c === "”") openSmart = false;
  }
  if (!openStraight && !openSmart) return false;
  // Only count it as quoted when the run actually CLOSES after the token.
  const rest = line.slice(at);
  return openStraight ? rest.includes('"') : rest.includes("”");
}

/** True when `index` sits on a markdown heading line. A heading is a label,
 *  and labels in caps are a formatting choice, not shouting mid-paragraph. */
function onHeadingLine(text: string, index: number): boolean {
  const line = text.slice(lineStartAt(text, index), lineEndAt(text, index));
  return /^[ \t]*#{1,6}\s/.test(line);
}

/**
 * Grow a bare ALL-CAPS match out to the whole hyphen- or slash-joined token it
 * belongs to, so "ASD-STE100" and "CI/CD" are ONE token rather than two
 * separate shouts. Returns the token's absolute [start, end).
 */
function wholeCapsToken(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s >= 2 && /[-/]/.test(text[s - 1] ?? "") && /[A-Za-z0-9]/.test(text[s - 2] ?? "")) {
    const prev = /[A-Za-z0-9]+$/.exec(text.slice(0, s - 1));
    if (!prev) break;
    s = s - 1 - prev[0].length;
  }
  for (;;) {
    if (!/[-/]/.test(text[e] ?? "")) break;
    const next = /^[A-Za-z0-9]+/.exec(text.slice(e + 1));
    if (!next) break;
    e = e + 1 + next[0].length;
  }
  return { start: s, end: e };
}

const allCapsEmphasis: ProseRule = {
  id: "all-caps-emphasis",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const whitelist = new Set(ALL_CAPS_WHITELIST.map((w) => w.toUpperCase()));
    const emphasis = new Set(ALL_CAPS_EMPHASIS_WORDS.map((w) => w.toUpperCase()));
    const candidates: Array<{ start: number; end: number; full: string; parts: string[] }> = [];
    const re = /\b([A-Z][A-Z0-9]{2,})(s?)\b/g;
    let reportedTo = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[1] ?? "";
      if (m.index < reportedTo) continue; // already covered by a wider token
      if ((word.match(/[A-Z]/g) ?? []).length < 3) continue;
      if (whitelist.has(word)) continue;
      // A pluralized acronym: "SDKS" / "SDKs" is still the whitelisted "SDK".
      if (word.endsWith("S") && whitelist.has(word.slice(0, -1))) continue;
      if (m[2] === "s" && whitelist.has(word)) continue;
      // Immediately followed by "(" reads as a symbol reference, not shouting.
      if (text[m.index + m[0].length] === "(") continue;
      if (onHeadingLine(text, m.index)) continue;
      if (insideQuotes(text, m.index)) continue;

      const token = wholeCapsToken(text, m.index, m.index + m[0].length);
      const full = text.slice(token.start, token.end);
      reportedTo = token.end;
      // A hyphenated or slashed identifier carrying a digit is a standard name
      // ("ASD-STE100", "ISO-8601"), never emphasis.
      if (full !== word && /\d/.test(full)) continue;
      // Every ALL-CAPS part whitelisted means the whole token is fine ("CI/CD").
      const parts = full.split(/[-/]/).filter((p) => /^[A-Z][A-Z0-9]{2,}$/.test(p));
      if (parts.length > 0 && parts.every((p) => whitelist.has(p))) continue;
      candidates.push({ start: token.start, end: token.end, full, parts: parts.length ? parts : [full] });
    }

    // THE SHOUT TEST. A whitelist can never name every acronym in the world,
    // and the corpus showed which way the misses fall: a lone unknown token
    // amid lowercase ("a SPOF in the write path", "the SQS consumer") is a
    // NAME, while shouting is either an ordinary English word set in capitals
    // or a RUN of capitalised words. So a candidate has to be one of those two
    // to count. That kills the acronym false positives wholesale instead of
    // one list entry at a time.
    const out: Violation[] = [];
    candidates.forEach((c, i) => {
      const isWord = c.parts.some((p) => emphasis.has(p));
      const prev = candidates[i - 1];
      const next = candidates[i + 1];
      const runsWith = (other?: { start: number; end: number }) => {
        if (!other) return false;
        const gap = other.start > c.end ? text.slice(c.end, other.start) : text.slice(other.end, c.start);
        return gap.length <= 3 && /^[\s,:–—-]*$/.test(gap);
      };
      if (!isWord && !runsWith(prev) && !runsWith(next)) return;
      out.push(
        v(
          allCapsEmphasis,
          `"${c.full}" shouts — use bold for emphasis, not capitals.`,
          ctx,
          c.start,
          Math.max(c.full.length, 48),
        ),
      );
    });
    return out;
  },
};

const slashPack: ProseRule = {
  id: "slash-pack",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const exceptions = new Set(SLASH_PACK_EXCEPTIONS.map((s) => s.toLowerCase()));
    const out: Violation[] = [];
    const re = /\b\w{3,}\/\w{3,}(?:\/\w{3,})*\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const tok = m[0];
      if (exceptions.has(tok.toLowerCase())) continue;
      // Digit-only segments are dates/versions, not word packs. Number WORDS
      // are the same thing spelled out — "two/thirds" is a ratio.
      const segs = tok.split("/");
      if (segs.every((seg) => /^\d+$/.test(seg) || NUMBER_WORDS.has(seg.toLowerCase()))) continue;
      out.push(
        v(
          slashPack,
          `"${tok}" packs terms into a slash — write "${tok.split("/").join(", ")}" out.`,
          ctx,
          m.index,
          Math.max(tok.length, 48),
        ),
      );
    }
    return out;
  },
};

const arrowChain: ProseRule = {
  id: "arrow-chain",
  tier: 1,
  severity: "high",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const out: Violation[] = [];
    const re = /(?:→|⇒|->)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // A numeric arrow is a measurement ("5 -> 4", "92% → 71%"), not a
      // causal chain the author should have written out.
      const before = /([\d.,%]+)\s*$/.exec(text.slice(0, m.index));
      const after = /^\s*(~?[\d.,%]+)/.exec(text.slice(m.index + m[0].length));
      if (before && after && /\d/.test(before[1] ?? "") && /\d/.test(after[1] ?? "")) continue;
      out.push(
        v(
          arrowChain,
          "Arrow in prose — write the causation out; arrows belong in visuals[] diagrams.",
          ctx,
          m.index,
          60,
        ),
      );
    }
    return out;
  },
};

/**
 * Em-dashes a paragraph actually spends, counted as UNITS rather than glyphs.
 *
 * A PAIRED em-dash inside one sentence — like this one — is a single
 * parenthetical gesture written with two marks. Charging it twice made the
 * most careful use of the punctuation the most expensive, which is backwards.
 * So an even run of two or more inside one sentence costs half its glyphs, and
 * an odd run (a genuine trailing dash, or three marks in a row) costs all of
 * them. The returned offsets are absolute, one per unit spent.
 */
function emDashUnits(paragraph: ProseParagraph): number[] {
  const units: number[] = [];
  for (const s of paragraph.sentences) {
    const hits = [...s.text.matchAll(/—/g)].map((h) => s.index + (h.index ?? 0));
    if (hits.length >= 2 && hits.length % 2 === 0) {
      for (let i = 0; i < hits.length; i += 2) units.push(hits[i] as number);
    } else {
      units.push(...hits);
    }
  }
  return units.sort((a, b) => a - b);
}

const emDashBudget: ProseRule = {
  id: "em-dash-budget",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (_text, ctx) => {
    const out: Violation[] = [];
    for (const p of ctx.paragraphs) {
      const units = emDashUnits(p);
      if (units.length <= EM_DASH_PER_PARAGRAPH) continue;
      out.push(
        v(
          emDashBudget,
          `${units.length} em-dashes in one paragraph (budget ${EM_DASH_PER_PARAGRAPH}) — the rest should be full stops.`,
          ctx,
          units[EM_DASH_PER_PARAGRAPH] ?? p.index,
          60,
        ),
      );
    }
    return out;
  },
};

/** Minimum length of a coined label before we will call it a coinage. */
const COINAGE_MIN_CHARS = 8;
/** How far past the first mention we look for a definition. */
const COINAGE_DEFINITION_WINDOW = 220;
/** A lowercase hyphen-stack has to be leaned on this hard before it reads as a
 *  private label rather than an ordinary descriptive compound. */
const COINAGE_PLAIN_MIN_USES = 3;

/**
 * Does the token carry a segment that marks it as a NAME rather than a
 * description? Three shapes count: an internal capital ("deepPairing-aware"),
 * a fully capitalised part ("MOAT-safe-lane"), and a capitalised part that is
 * not the first ("alive-Surface-law"). A capital on the FIRST part alone is
 * ignored, because that is just how a sentence starts.
 */
function hasProperSegment(token: string): boolean {
  const parts = token.split("-");
  return parts.some((part, i) => {
    if (/[A-Z]/.test(part.slice(1))) return true; // deepPairing, MOAT
    return i > 0 && /^[A-Z]/.test(part);
  });
}

const undefinedCoinage: ProseRule = {
  id: "undefined-coinage",
  tier: 1,
  // Medium, not high. The rule reads INTENT off surface shape, which is the
  // shakiest inference in the file, so a residual false positive must never
  // own the first line of the agent's STYLE block.
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const common = new Set(COMMON_HYPHEN_COMPOUNDS.map((w) => w.toLowerCase()));
    // `first`/`firstEnd` bracket the FIRST mention, so the definition probe
    // starts exactly after it.
    const candidates: Record<string, { label: string; first: number; firstEnd: number; count: number }> = {};

    // Hyphen-stacked coinage: three or more hyphenated parts. This is the ONLY
    // arm. A repeated QUOTED phrase used to count too, which flagged the agent
    // for quoting its pair back to them — the one register the pairing
    // protocol explicitly asks for.
    const stacked = /\b[A-Za-z]{2,}(?:-[A-Za-z]{2,}){2,}\b/g;
    let m: RegExpExecArray | null;
    while ((m = stacked.exec(text)) !== null) {
      const label = m[0];
      if (common.has(label.toLowerCase())) continue;
      const key = label.toLowerCase();
      const existing = candidates[key];
      if (existing) existing.count += 1;
      else candidates[key] = { label, first: m.index, firstEnd: m.index + label.length, count: 1 };
    }

    const out: Violation[] = [];
    for (const c of Object.values(candidates)) {
      if (c.label.length < COINAGE_MIN_CHARS) continue;
      // Two uses of a plain lowercase compound is just ordinary description
      // ("a read-through cache"). Ask for a definition only when the token
      // reads as a NAME, or when the author leans on it a third time.
      const minUses = hasProperSegment(c.label) ? 2 : COINAGE_PLAIN_MIN_USES;
      if (c.count < minUses) continue;
      const tail = text.slice(c.firstEnd, c.firstEnd + COINAGE_DEFINITION_WINDOW);
      // A definition looks like "X is ...", "X = ...", "X — ..." or "X (gloss)".
      const defined =
        /^\s*(?:is|are|means|=|—|:)\s/.test(tail) || /^\s*\([^)]{6,}\)/.test(tail);
      if (defined) continue;
      out.push(
        v(
          undefinedCoinage,
          `"${c.label}" is coined and used ${c.count} times without a definition — define it at first use or don't coin it.`,
          ctx,
          c.first,
          Math.max(c.label.length, 60),
        ),
      );
    }
    return out.sort((a, b) => a.index - b.index);
  },
};

const inlineEnumeration: ProseRule = {
  id: "inline-enumeration",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (_text, ctx) => {
    const out: Violation[] = [];
    for (const s of ctx.sentences) {
      if (/\(1\)/.test(s.text) && /\(2\)/.test(s.text)) {
        out.push(
          v(inlineEnumeration, "Inline (1)…(2) enumeration — use a real list.", ctx, s.index, s.text.length),
        );
      }
    }
    return out;
  },
};

// --- tier 2: structure ------------------------------------------------------

const paragraphLength: ProseRule = {
  id: "paragraph-length",
  tier: 2,
  severity: "low",
  modes: ["strict", "flavored"],
  check: (_text, ctx) =>
    ctx.paragraphs
      .filter((p) => p.sentences.length > PARAGRAPH_SENTENCE_LIMIT)
      .map((p) =>
        v(
          paragraphLength,
          `${p.sentences.length}-sentence paragraph (limit ${PARAGRAPH_SENTENCE_LIMIT}) — break it up.`,
          ctx,
          p.index,
          60,
        ),
      ),
};

const trailingCondition: ProseRule = {
  id: "trailing-condition",
  tier: 2,
  severity: "medium",
  modes: ["strict"],
  check: (_text, ctx) => {
    const verbs = new Set(IMPERATIVE_VERBS.map((w) => w.toLowerCase()));
    const out: Violation[] = [];
    for (const s of ctx.sentences) {
      const firstWord = (/^([A-Za-z']+)/.exec(s.text)?.[1] ?? "").toLowerCase();
      if (!verbs.has(firstWord)) continue;
      const m = /,\s+(if|when|unless)\s+[^,]{4,}[.!?]?$/i.exec(s.text);
      if (!m) continue;
      out.push(
        v(
          trailingCondition,
          `Instruction ends in an "${(m[1] ?? "if").toLowerCase()}" clause — put the condition first.`,
          ctx,
          s.index,
          s.text.length,
        ),
      );
    }
    return out;
  },
};

const vagueRecommendation: ProseRule = {
  id: "vague-recommendation",
  tier: 2,
  // Low. "Vague" is a judgement about meaning made from surface shape alone,
  // so this rule is the most likely in the file to be wrong about a sentence
  // that is fine. Low severity keeps a miss cheap.
  severity: "low",
  modes: ["strict"],
  check: (_text, ctx) => {
    const out: Violation[] = [];
    for (const s of ctx.sentences) {
      // A DEFINITE article points at a specific thing the reader can go find
      // ("improve THE retry loop"). The vague shape is the bare mass noun:
      // "improve error handling", "improve performance".
      const m =
        /\b(consider improving|improve|enhance|better)\s+(?!the\b|a\b|an\b|its\b|this\b|that\b|our\b|your\b|their\b)([a-z]{3,})\b/i.exec(
          s.text,
        );
      if (!m) continue;
      // If the sentence names something concrete in the ORIGINAL text — a
      // backticked symbol, a path, an extension, a number, or a capitalised
      // identifier past the first word — it is not vague.
      const source = ctx.original.slice(s.index, s.index + s.text.length + 2);
      if (/`|\.[a-z]{1,5}\b|\/|\d/.test(source)) continue;
      const laterWords = source.trim().split(/\s+/).slice(1);
      if (laterWords.some((w) => /^[A-Z]/.test(w) || /[a-z][A-Z]/.test(w))) continue;
      out.push(
        v(
          vagueRecommendation,
          `"${m[0]}" names no target — a recommendation should name the file or symbol.`,
          ctx,
          s.index,
          s.text.length,
        ),
      );
    }
    return out;
  },
};

// --- tier 3: wordiness ------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const wordiness: ProseRule = {
  id: "wordiness",
  tier: 3,
  severity: "low",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const out: Violation[] = [];
    for (const phrase of Object.keys(WORDINESS_MAP)) {
      const replacement = WORDINESS_MAP[phrase];
      const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        out.push(
          v(
            wordiness,
            replacement ? `"${phrase}" → "${replacement}".` : `"${phrase}" — cut it.`,
            ctx,
            m.index,
            Math.max(m[0].length, 48),
          ),
        );
      }
    }
    return out.sort((a, b) => a.index - b.index);
  },
};

/** Every rule, in report order. Exported so the UI can group/label by rule. */
export const PROSE_RULES: readonly ProseRule[] = [
  sentenceLength,
  parentheticalDensity,
  semicolon,
  allCapsEmphasis,
  slashPack,
  arrowChain,
  emDashBudget,
  undefinedCoinage,
  inlineEnumeration,
  paragraphLength,
  trailingCondition,
  vagueRecommendation,
  wordiness,
];

// --- scoring ----------------------------------------------------------------

/**
 * SCORING. Start at 100 and subtract the weighted violation cost, normalized
 * per 100 words so a long field is not punished for being long:
 *
 *   raw        = Σ SEVERITY_WEIGHT[violation.severity]
 *   normalized = raw × 100 / max(wordCount, MIN_SCORING_WORDS)
 *   score      = clamp(round(100 − normalized), 0, 100)
 *
 * The MIN_SCORING_WORDS floor only stops a two-word field from dividing by
 * nearly zero. It used to sit at 100, which quietly flattened the whole curve:
 * almost every artifact field is shorter than 100 words, so almost every field
 * was divided by 100 no matter how short it was, and two real problems in a
 * 50-word summary scored 92. Nothing could reach the amber band, let alone the
 * red one, and the chip became a number that only ever said "fine".
 *
 * At 30 the arithmetic is honest again. A 50-word field with two medium
 * violations now scores 84 (8 × 100 / 50), which is where a reader would put
 * it. A 500-word field with the same two scores 98, because two slips across
 * five hundred words genuinely is fine. The score still reads as density of
 * trouble — it just measures the density the author actually wrote.
 */
export const MIN_SCORING_WORDS = 30;

export function scoreViolations(violations: Violation[], wordCount: number): number {
  const raw = violations.reduce((sum, x) => sum + SEVERITY_WEIGHT[x.severity], 0);
  if (raw === 0) return 100;
  const normalized = (raw * 100) / Math.max(wordCount, MIN_SCORING_WORDS);
  return Math.max(0, Math.min(100, Math.round(100 - normalized)));
}

// --- the entry point --------------------------------------------------------

/**
 * Lint one prose field. Pure and deterministic: the same text and mode always
 * produce the same violations in the same order.
 */
/** The word count `lintProse` scores against: prose only, after masking. */
function proseWordCount(text: string): number {
  return splitProse(maskNonProse(text))
    .flatMap((p) => p.sentences)
    .reduce((n, s) => n + s.words, 0);
}

export function lintProse(text: string, options: LintOptions = {}): LintResult {
  const mode: ProseMode = options.mode ?? "flavored";
  if (typeof text !== "string" || text.trim().length === 0) {
    return { violations: [], score: 100 };
  }
  const masked = maskNonProse(text);
  const paragraphs = splitProse(masked);
  const sentences = paragraphs.flatMap((p) => p.sentences);
  const ctx: LintContext = { mode, original: text, masked, paragraphs, sentences };

  const violations: Violation[] = [];
  for (const rule of PROSE_RULES) {
    if (!rule.modes.includes(mode)) continue;
    violations.push(...rule.check(masked, ctx));
  }
  violations.sort((a, b) => a.index - b.index || a.ruleId.localeCompare(b.ruleId));

  const words = sentences.reduce((n, s) => n + s.words, 0);
  return { violations, score: scoreViolations(violations, words) };
}

// --- the artifact field map -------------------------------------------------

/**
 * Which prose fields of which artifact type get linted, and in which mode.
 *
 *   strict   — fields the human ACTS on: a recommendation, an ask, a step
 *              instruction, an option's tradeoffs.
 *   flavored — narrative fields: summaries, details, overviews, section bodies.
 *
 * Path syntax: dots for objects, `[]` for "every element of this array". A
 * bare `openQuestions[]` means the array holds the strings themselves.
 * Everything is read defensively — a missing or wrong-typed field is skipped,
 * never thrown on. NO schema field is added by this map; it only reads.
 */
export interface ProseFieldSpec {
  path: string;
  mode: ProseMode;
  /**
   * Rule ids this field is exempt from. One field needs it today: a diagram's
   * own `caption`, where `arrow-chain` would tell the author that "arrows
   * belong in visuals[] diagrams" about a line that IS the label on a
   * visuals[] diagram.
   */
  exclude?: readonly string[];
}

/** A caption labels a diagram, so an arrow in it is the diagram talking. */
const CAPTION_EXEMPT: readonly string[] = ["arrow-chain"];

export const PROSE_FIELD_MAP: Readonly<Record<string, readonly ProseFieldSpec[]>> = {
  research: [
    { path: "summary", mode: "flavored" },
    { path: "findings[].detail", mode: "flavored" },
    { path: "findings[].impact", mode: "flavored" },
    { path: "findings[].recommendation", mode: "strict" },
    { path: "findings[].concept.oneLineExplanation", mode: "flavored" },
    { path: "openQuestions[]", mode: "strict" },
    { path: "visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
  plan: [
    { path: "steps[].description", mode: "strict" },
    { path: "steps[].reasoning", mode: "flavored" },
    { path: "steps[].statusNote", mode: "flavored" },
    { path: "steps[].branches[].description", mode: "strict" },
    { path: "steps[].branches[].reasoning", mode: "flavored" },
    { path: "visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
  spec: [
    { path: "objective", mode: "flavored" },
    { path: "context", mode: "flavored" },
    { path: "design", mode: "flavored" },
    { path: "requirements[].statement", mode: "strict" },
    { path: "requirements[].rationale", mode: "flavored" },
    { path: "requirements[].acceptanceCriteria[]", mode: "strict" },
    { path: "tasks[].description", mode: "strict" },
    { path: "openQuestions[]", mode: "strict" },
    { path: "visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
  decision: [
    { path: "context", mode: "flavored" },
    { path: "options[].description", mode: "flavored" },
    { path: "options[].pros[]", mode: "strict" },
    { path: "options[].cons[]", mode: "strict" },
    { path: "options[].concept.oneLineExplanation", mode: "flavored" },
    { path: "options[].visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
  code_change: [{ path: "reasoning", mode: "flavored" }],
  changeset: [
    { path: "summary", mode: "flavored" },
    { path: "risks[]", mode: "flavored" },
    { path: "visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
  reasoning: [
    { path: "action", mode: "flavored" },
    { path: "reasoning", mode: "flavored" },
    { path: "alternativesConsidered[]", mode: "flavored" },
    { path: "alternativeDetails[].reason", mode: "flavored" },
    { path: "concept.oneLineExplanation", mode: "flavored" },
  ],
  debrief: [
    { path: "summary", mode: "flavored" },
    { path: "sections[].body", mode: "flavored" },
    { path: "decisionsMade[].what", mode: "flavored" },
    { path: "decisionsMade[].why", mode: "flavored" },
    { path: "decisionsMade[].alternative", mode: "flavored" },
    { path: "needsYourEyes[].what", mode: "strict" },
    { path: "needsYourEyes[].why", mode: "strict" },
    { path: "deferred[].what", mode: "flavored" },
    { path: "deferred[].why", mode: "flavored" },
    { path: "openQuestions[]", mode: "strict" },
    { path: "visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
  explainer: [
    { path: "overview", mode: "flavored" },
    { path: "sections[].body", mode: "flavored" },
    { path: "unknowns[]", mode: "flavored" },
    { path: "visuals[].caption", mode: "flavored", exclude: CAPTION_EXEMPT },
  ],
};

/** One linted field of one artifact. `path` is concrete (`findings[2].detail`). */
export interface ProseFieldResult {
  path: string;
  mode: ProseMode;
  violations: Violation[];
  score: number;
}

export interface ArtifactProseResult {
  fields: ProseFieldResult[];
  violations: Violation[];
  /** The WORST field score. See the note in lintArtifactContent. */
  score: number;
}

/** Resolve a `foo[].bar` spec against a content object, yielding concrete
 *  `{ path, text }` pairs. Defensive at every hop — anything unexpected is
 *  skipped silently. */
function resolvePath(node: unknown, segments: string[], prefix: string): Array<{ path: string; text: string }> {
  if (node === null || node === undefined) return [];
  if (segments.length === 0) {
    return typeof node === "string" && node.trim().length > 0 ? [{ path: prefix, text: node }] : [];
  }
  const head = segments[0] ?? "";
  const rest = segments.slice(1);
  const isArray = head.endsWith("[]");
  const key = isArray ? head.slice(0, -2) : head;

  let next: unknown = node;
  if (key.length > 0) {
    if (typeof node !== "object" || Array.isArray(node)) return [];
    next = (node as Record<string, unknown>)[key];
  }
  if (!isArray) return resolvePath(next, rest, prefix ? `${prefix}.${key}` : key);

  if (!Array.isArray(next)) return [];
  const base = prefix ? `${prefix}.${key}` : key;
  const out: Array<{ path: string; text: string }> = [];
  next.forEach((item, i) => {
    out.push(...resolvePath(item, rest, `${base}[${i}]`));
  });
  return out;
}

/**
 * Walk an artifact's prose fields (per PROSE_FIELD_MAP), lint each in its own
 * mode, and roll up.
 *
 * The overall score is the MINIMUM of the field scores, not the mean. A
 * debrief whose summary is clean but whose "needs your eyes" item is a
 * 40-word semicolon chain should not average its way to a comfortable number:
 * the chip exists to point at the worst thing on the card, and the worst field
 * is what the human actually hits.
 */
export function lintArtifactContent(type: string, content: unknown): ArtifactProseResult {
  const specs = PROSE_FIELD_MAP[type];
  if (!specs || content === null || typeof content !== "object") {
    return { fields: [], violations: [], score: 100 };
  }
  const fields: ProseFieldResult[] = [];
  for (const spec of specs) {
    const exempt = new Set(spec.exclude ?? []);
    for (const hit of resolvePath(content, spec.path.split("."), "")) {
      const lint = lintProse(hit.text, { mode: spec.mode });
      const violations = exempt.size === 0
        ? lint.violations
        : lint.violations.filter((x) => !exempt.has(x.ruleId));
      if (violations.length === 0) continue;
      // Re-score without the exempt rules, so an exemption actually costs
      // nothing rather than being hidden from the list but charged anyway.
      const score = violations.length === lint.violations.length
        ? lint.score
        : scoreViolations(violations, proseWordCount(hit.text));
      fields.push({ path: hit.path, mode: spec.mode, violations, score });
    }
  }
  const violations = fields.flatMap((f) => f.violations);
  const score = fields.length === 0 ? 100 : Math.min(...fields.map((f) => f.score));
  return { fields, violations, score };
}

/** Severity order for "show me the worst first" ranking. */
const SEVERITY_RANK: Readonly<Record<ProseSeverity, number>> = { high: 0, medium: 1, low: 2 };

/** Sort a flat violation list worst-first, stable on index. */
export function bySeverity(a: Violation, b: Violation): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.index - b.index;
}
