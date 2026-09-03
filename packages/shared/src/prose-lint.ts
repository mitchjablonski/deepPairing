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
  "API", "APIS", "ABI", "AST", "ASCII", "AWS", "CDN", "CI", "CD", "CLI", "CPU",
  "CRUD", "CSS", "CSV", "DNS", "DOM", "DTO", "E2E", "EOF", "ENV", "GCP", "GNU",
  "GPL", "GPU", "GRPC", "HTML", "HTTP", "HTTPS", "ID", "IDE", "IO", "ISO",
  "JS", "JSON", "JSX", "JWT", "LLM", "MCP", "MD", "MFA", "MIT", "NPM", "OAUTH",
  "OK", "ORM", "OS", "PDF", "PII", "PNPM", "PR", "PRS", "QA", "QPS", "RAM",
  "REST", "RFC", "RPC", "SDK", "SHA", "SLA", "SLO", "SQL", "SSL", "SSO", "TLS",
  "TODO", "TSX", "TS", "TTL", "UI", "URI", "URL", "UTC", "UTF", "UUID", "UX",
  "VM", "VS", "WS", "WSL", "XML", "YAML", "README", "FIXME", "NOTE", "WIP",
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

  // 5. File paths. A slash-run counts as a path when it is anchored (`./`,
  //    `../`, `/`, `~/`) or when any segment carries a file extension. That
  //    deliberately leaves bare word-packs like "build/test/deploy" visible —
  //    those are the compression the `slash-pack` rule is here to catch. Write
  //    an extension-less path in backticks and it is masked as code.
  const pathRe = /(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g;
  while ((m = pathRe.exec(masked3)) !== null) {
    // Drop sentence punctuation the greedy class swallowed ("…/prose-lint.ts."),
    // or the trailing period hides the extension and the path reads as a pack.
    const tok = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!tok.includes("/")) continue;
    const anchored = /^(?:~\/|\.{1,2}\/|\/)/.test(tok);
    const hasExtension = tok.split("/").some((seg) => /^[\w@+-][\w.@+-]*\.[A-Za-z]{1,6}$/.test(seg));
    if (anchored || hasExtension) blank(chars, m.index, m.index + tok.length);
  }

  return chars.join("");
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
          `${s.words}-word sentence (limit ${limit}) — split it; one idea per sentence.`,
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

const allCapsEmphasis: ProseRule = {
  id: "all-caps-emphasis",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    const whitelist = new Set(ALL_CAPS_WHITELIST.map((w) => w.toUpperCase()));
    const out: Violation[] = [];
    const re = /\b([A-Z][A-Z0-9]{2,})(s?)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const word = m[1] ?? "";
      if ((word.match(/[A-Z]/g) ?? []).length < 3) continue;
      if (whitelist.has(word)) continue;
      // A pluralized acronym: "SDKS" / "SDKs" is still the whitelisted "SDK".
      if (word.endsWith("S") && whitelist.has(word.slice(0, -1))) continue;
      if (m[2] === "s" && whitelist.has(word)) continue;
      // Immediately followed by "(" reads as a symbol reference, not shouting.
      if (text[m.index + m[0].length] === "(") continue;
      out.push(
        v(
          allCapsEmphasis,
          `"${word}" shouts — use bold for emphasis, not capitals.`,
          ctx,
          m.index,
          Math.max(m[0].length, 48),
        ),
      );
    }
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
      // Digit-only segments are dates/versions, not word packs.
      if (tok.split("/").every((seg) => /^\d+$/.test(seg))) continue;
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

const emDashBudget: ProseRule = {
  id: "em-dash-budget",
  tier: 1,
  severity: "medium",
  modes: ["strict", "flavored"],
  check: (_text, ctx) => {
    const out: Violation[] = [];
    for (const p of ctx.paragraphs) {
      const hits = [...p.text.matchAll(/—/g)];
      if (hits.length <= EM_DASH_PER_PARAGRAPH) continue;
      out.push(
        v(
          emDashBudget,
          `${hits.length} em-dashes in one paragraph (budget ${EM_DASH_PER_PARAGRAPH}) — the rest should be full stops.`,
          ctx,
          p.index + (hits[EM_DASH_PER_PARAGRAPH]?.index ?? 0),
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

const undefinedCoinage: ProseRule = {
  id: "undefined-coinage",
  tier: 1,
  severity: "high",
  modes: ["strict", "flavored"],
  check: (text, ctx) => {
    // `first`/`firstEnd` bracket the FIRST mention including any quote marks,
    // so the definition probe starts exactly after it.
    const candidates: Record<string, { label: string; first: number; firstEnd: number; count: number }> = {};
    const note = (label: string, at: number, end: number) => {
      const key = label.toLowerCase();
      const existing = candidates[key];
      if (existing) existing.count += 1;
      else candidates[key] = { label, first: at, firstEnd: end, count: 1 };
    };

    // Hyphen-stacked coinage: three or more hyphenated parts.
    const stacked = /\b[A-Za-z]{2,}(?:-[A-Za-z]{2,}){2,}\b/g;
    let m: RegExpExecArray | null;
    while ((m = stacked.exec(text)) !== null) note(m[0], m.index, m.index + m[0].length);

    // Quoted term: "the alive-surface law", “compression register”.
    const quoted = /["“]([^"”\n]{3,40})["”]/g;
    while ((m = quoted.exec(text)) !== null) note((m[1] ?? "").trim(), m.index, m.index + m[0].length);

    const out: Violation[] = [];
    for (const c of Object.values(candidates)) {
      if (c.count < 2) continue;
      if (c.label.length < COINAGE_MIN_CHARS) continue;
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
  severity: "medium",
  modes: ["strict"],
  check: (_text, ctx) => {
    const out: Violation[] = [];
    for (const s of ctx.sentences) {
      const m = /\b(consider improving|improve|enhance|better)\s+(?:the\s+|a\s+|its\s+)?([a-z]{3,})\b/i.exec(s.text);
      if (!m) continue;
      // If the sentence names something concrete in the ORIGINAL text — a
      // backticked symbol, a path, an extension — it is not vague.
      const source = ctx.original.slice(s.index, s.index + s.text.length + 2);
      if (/`|\.[a-z]{1,5}\b|\//.test(source)) continue;
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
 * The MIN_SCORING_WORDS floor stops a one-line field from scoring 0 on a
 * single violation (and stops a two-word field from dividing by nearly zero).
 * With the floor, one high-severity violation in a short field costs 8 points,
 * and ten of them in a 1,000-word field cost the same 8 — the score reads as
 * "density of trouble", which is what the corpus measured.
 */
export const MIN_SCORING_WORDS = 100;

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
}

export const PROSE_FIELD_MAP: Readonly<Record<string, readonly ProseFieldSpec[]>> = {
  research: [
    { path: "summary", mode: "flavored" },
    { path: "findings[].detail", mode: "flavored" },
    { path: "findings[].impact", mode: "flavored" },
    { path: "findings[].recommendation", mode: "strict" },
    { path: "findings[].concept.oneLineExplanation", mode: "flavored" },
    { path: "openQuestions[]", mode: "strict" },
  ],
  plan: [
    { path: "steps[].description", mode: "strict" },
    { path: "steps[].reasoning", mode: "flavored" },
    { path: "steps[].statusNote", mode: "flavored" },
    { path: "steps[].branches[].description", mode: "strict" },
    { path: "steps[].branches[].reasoning", mode: "flavored" },
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
  ],
  decision: [
    { path: "context", mode: "flavored" },
    { path: "options[].description", mode: "flavored" },
    { path: "options[].pros[]", mode: "strict" },
    { path: "options[].cons[]", mode: "strict" },
    { path: "options[].concept.oneLineExplanation", mode: "flavored" },
  ],
  code_change: [{ path: "reasoning", mode: "flavored" }],
  changeset: [
    { path: "summary", mode: "flavored" },
    { path: "risks[]", mode: "flavored" },
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
  ],
  explainer: [
    { path: "overview", mode: "flavored" },
    { path: "sections[].body", mode: "flavored" },
    { path: "unknowns[]", mode: "flavored" },
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
    for (const hit of resolvePath(content, spec.path.split("."), "")) {
      const { violations, score } = lintProse(hit.text, { mode: spec.mode });
      if (violations.length === 0) continue;
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
