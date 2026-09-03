import { describe, it, expect } from "vitest";
import {
  lintProse,
  lintArtifactContent,
  scoreViolations,
  maskNonProse,
  splitProse,
  excerptAt,
  PROSE_RULES,
  PROSE_FIELD_MAP,
  ALL_CAPS_WHITELIST,
  type Violation,
} from "../prose-lint.js";

/** Rule ids fired by a lint run, de-duped, for compact assertions. */
function ids(violations: Violation[]): string[] {
  return [...new Set(violations.map((v) => v.ruleId))].sort();
}

function fired(text: string, ruleId: string, mode: "strict" | "flavored" = "flavored"): boolean {
  return lintProse(text, { mode }).violations.some((v) => v.ruleId === ruleId);
}

describe("prose-lint / rule inventory", () => {
  it("has a unique id per rule and every rule declares at least one mode", () => {
    const seen = new Set<string>();
    for (const rule of PROSE_RULES) {
      expect(seen.has(rule.id), `duplicate rule id ${rule.id}`).toBe(false);
      seen.add(rule.id);
      expect(rule.modes.length).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(rule.tier);
      expect(["high", "medium", "low"]).toContain(rule.severity);
    }
  });

  it("is deterministic — the same input lints identically twice", () => {
    const text =
      "The routing rework is fine (mostly); shop routing outranks healthy elites → ~0.05 fewer relics/run.";
    expect(lintProse(text)).toEqual(lintProse(text));
  });

  it("treats empty and whitespace-only text as clean", () => {
    expect(lintProse("")).toEqual({ violations: [], score: 100 });
    expect(lintProse("   \n\n  ")).toEqual({ violations: [], score: 100 });
  });
});

// --- tier 1 goldens ---------------------------------------------------------

describe("sentence-length", () => {
  const long =
    "The store writes the artifact to disk before it broadcasts, which means a reader " +
    "that joins late still sees the same record the agent just created without any " +
    "extra round trip at all.";

  it("flags a sentence over 25 words in flavored mode and names the count", () => {
    const { violations } = lintProse(long, { mode: "flavored" });
    const hit = violations.find((v) => v.ruleId === "sentence-length");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/^\d+-word sentence \(limit 25\)/);
  });

  it("does not flag a 22-word sentence in flavored mode but does in strict", () => {
    const mid =
      "The store writes the artifact to disk before it broadcasts, so a reader that " +
      "joins late still sees the same record.";
    expect(fired(mid, "sentence-length", "flavored")).toBe(false);
    expect(fired(mid, "sentence-length", "strict")).toBe(true);
    expect(lintProse(mid, { mode: "strict" }).violations[0]!.message).toMatch(/limit 20/);
  });

  it("leaves short sentences alone", () => {
    expect(fired("The daemon binds a per-project port. The UI reads it.", "sentence-length")).toBe(false);
  });
});

describe("parenthetical-density", () => {
  it("flags more than one substantial parenthetical per three sentences", () => {
    const text =
      "The gate fired (a local session stance, not a team rule). " +
      "The artifact still landed (nothing was blocked here). " +
      "The human saw it (the toast rendered immediately).";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "parenthetical-density");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/3 parentheticals across 3 sentences \(budget 1\)/);
  });

  it("allows one substantial parenthetical across three sentences", () => {
    const text =
      "The gate fired on a local session stance. " +
      "The artifact still landed (nothing was blocked here). " +
      "The human saw the toast right away.";
    expect(fired(text, "parenthetical-density")).toBe(false);
  });

  it("ignores short parentheticals under the 15-char floor", () => {
    const text = "The port (3847) is derived. The UI reads it (once). The daemon logs it (twice).";
    expect(fired(text, "parenthetical-density")).toBe(false);
  });

  it("flags a nested parenthetical on its own", () => {
    const text = "The preflight consult (it reads the ledger (and the team file) first) admitted this.";
    const hits = lintProse(text).violations.filter((v) => v.ruleId === "parenthetical-density");
    expect(hits.some((h) => /Nested parenthetical/.test(h.message))).toBe(true);
  });
});

describe("semicolon", () => {
  it("flags every semicolon in prose", () => {
    const text = "The beat vocabulary already exists; the licensing reality is the blocker; both are real.";
    const hits = lintProse(text).violations.filter((v) => v.ruleId === "semicolon");
    expect(hits).toHaveLength(2);
    expect(hits[0]!.message).toBe("Semicolon — split it into two sentences.");
  });

  it("does not flag a semicolon inside an HTML entity", () => {
    expect(fired("Tokens are joined with &amp; in the query.", "semicolon")).toBe(false);
  });
});

describe("all-caps-emphasis", () => {
  it("flags shouted emphasis", () => {
    const text = "WHAT THE RESEARCH SETTLED: the middle gear is REAL.";
    const hits = lintProse(text).violations.filter((v) => v.ruleId === "all-caps-emphasis");
    expect(hits.map((h) => h.excerpt.split(" ")[0])).toContain("WHAT");
    expect(hits.some((h) => /"REAL" shouts/.test(h.message))).toBe(true);
  });

  it("does not flag whitelisted acronyms, including plurals", () => {
    const text = "The MCP server exposes an HTTP API over JSON, and the CLI reads the WSL paths.";
    expect(fired(text, "all-caps-emphasis")).toBe(false);
    expect(fired("Two APIS and several SDKS were checked.", "all-caps-emphasis")).toBe(false);
  });

  it("does not flag two-letter caps or a symbol reference followed by a paren", () => {
    expect(fired("The UI and the PR both agree.", "all-caps-emphasis")).toBe(false);
    expect(fired("Call RUNPREFLIGHT(args) at the boundary.", "all-caps-emphasis")).toBe(false);
  });

  it("keeps the whitelist exported and extendable", () => {
    expect(ALL_CAPS_WHITELIST).toContain("JSON");
    expect(ALL_CAPS_WHITELIST).toContain("WSL");
    expect([...ALL_CAPS_WHITELIST, "GOLDEN"]).toContain("GOLDEN");
  });
});

describe("slash-pack", () => {
  it("flags a word pack and suggests the written-out form", () => {
    const hit = lintProse("The build/test/deploy loop is the slow part.").violations.find(
      (v) => v.ruleId === "slash-pack",
    );
    expect(hit).toBeDefined();
    expect(hit!.message).toContain('write "build, test, deploy" out');
  });

  it("flags a two-term pack like file/socket", () => {
    expect(fired("Every file/socket handle is closed on exit.", "slash-pack")).toBe(true);
  });

  it("does not flag and/or, n/a, w/o, I/O or dates", () => {
    for (const s of [
      "Pass a name and/or an id.",
      "The field is n/a here.",
      "It runs w/o the daemon.",
      "The I/O layer is fine.",
      "Recorded on 12/31/2026 at the boundary.",
      "It runs 24/7 in the daemon.",
    ]) {
      expect(fired(s, "slash-pack"), s).toBe(false);
    }
  });

  it("does not flag an established compound on the exception list", () => {
    expect(fired("The tcp/ip stack is untouched.", "slash-pack")).toBe(false);
  });
});

describe("arrow-chain", () => {
  it("flags unicode and ascii arrows and points at visuals[]", () => {
    const text = "Shop routing outranks healthy elites → ~0.05 fewer relics/run.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "arrow-chain");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("arrows belong in visuals[] diagrams");
    expect(fired("The daemon -> the UI -> the store.", "arrow-chain")).toBe(true);
    expect(fired("Preflight ⇒ block.", "arrow-chain")).toBe(true);
  });

  it("carries high severity", () => {
    const hit = lintProse("The store → the UI.").violations.find((v) => v.ruleId === "arrow-chain");
    expect(hit!.severity).toBe("high");
  });
});

describe("em-dash-budget", () => {
  it("flags a paragraph that spends two separate em-dashes", () => {
    const text = "The gate fired — it held. The artifact landed — it rendered.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "em-dash-budget");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/2 em-dashes in one paragraph/);
  });

  it("allows one em-dash per paragraph", () => {
    expect(fired("The gate fired — the artifact still landed.", "em-dash-budget")).toBe(false);
  });

  it("counts a PAIRED em-dash as one unit, not two", () => {
    // A parenthetical written with two marks is a single gesture.
    expect(fired("The gate fired — a local stance — and the artifact landed.", "em-dash-budget")).toBe(false);
    // Four marks in one sentence is two pairs, which is still over budget.
    expect(
      fired(
        "The gate fired — a local stance — and the artifact — a draft — still landed.",
        "em-dash-budget",
      ),
    ).toBe(true);
  });

  it("still charges an ODD run in full", () => {
    expect(fired("The gate fired — a local stance — and it held — twice.", "em-dash-budget")).toBe(true);
  });

  it("counts per paragraph, not per field", () => {
    const text = "The gate fired — it held.\n\nThe artifact landed — it rendered.";
    expect(fired(text, "em-dash-budget")).toBe(false);
  });
});

describe("undefined-coinage", () => {
  it("flags a plain hyphen-stacked coinage leaned on three times", () => {
    const text =
      "The alive-surface-law explains the routing. Every card obeys the alive-surface-law here. " +
      "So the alive-surface-law wins.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "undefined-coinage");
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("define it at first use");
    // Medium, so a residual miss can never own line 1 of the STYLE block.
    expect(hit!.severity).toBe("medium");
  });

  it("flags a NAME-shaped coinage on the second use", () => {
    const text =
      "Every card obeys the alive-Surface-law. The alive-Surface-law is why.";
    expect(fired(text, "undefined-coinage")).toBe(true);
    const camel = "The deepPairing-gate-rule holds. The deepPairing-gate-rule holds again.";
    expect(fired(camel, "undefined-coinage")).toBe(true);
  });

  it("does not flag a plain compound used only twice", () => {
    const text = "The read-through-cache is warm. The read-through-cache holds.";
    expect(fired(text, "undefined-coinage")).toBe(false);
  });

  it("does not flag a coinage defined at first use", () => {
    const text =
      "The alive-surface-law is the rule that content lands where people already look. " +
      "Every card obeys the alive-surface-law here.";
    expect(fired(text, "undefined-coinage")).toBe(false);
  });

  it("does not flag a coinage glossed with a parenthetical at first use", () => {
    const text =
      "The alive-surface-law (content lands where people already look) drives this. " +
      "The alive-surface-law wins again.";
    expect(fired(text, "undefined-coinage")).toBe(false);
  });

  it("does not flag a single mention", () => {
    expect(fired("The alive-surface-law explains the routing.", "undefined-coinage")).toBe(false);
  });

  it("does not flag a short hyphenated term below the length floor", () => {
    expect(fired("The a-b-c path is fine. The a-b-c path holds.", "undefined-coinage")).toBe(false);
  });
});

describe("inline-enumeration", () => {
  it("flags a (1)…(2) enumeration inside one sentence", () => {
    const text =
      "Two things block this: (1) the beat vocabulary already exists, and (2) licensing reality bites.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "inline-enumeration");
    expect(hit).toBeDefined();
    expect(hit!.message).toBe("Inline (1)…(2) enumeration — use a real list.");
  });

  it("does not flag a real markdown list", () => {
    const text = "Two things block this:\n\n1. The beat vocabulary exists.\n2. Licensing reality bites.";
    expect(fired(text, "inline-enumeration")).toBe(false);
  });
});

// --- tier 2 -----------------------------------------------------------------

describe("paragraph-length", () => {
  it("flags a paragraph over five sentences", () => {
    const text = "One thing. Two things. Three things. Four things. Five things. Six things.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "paragraph-length");
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/6-sentence paragraph \(limit 5\)/);
  });

  it("allows five sentences", () => {
    expect(fired("One. Two. Three. Four. Five.", "paragraph-length")).toBe(false);
  });
});

describe("trailing-condition (strict only)", () => {
  const text = "Call check_feedback again, if the human has not answered yet.";

  it("flags an imperative ending in a condition, in strict mode", () => {
    const hit = lintProse(text, { mode: "strict" }).violations.find(
      (v) => v.ruleId === "trailing-condition",
    );
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("put the condition first");
  });

  it("is silent in flavored mode", () => {
    expect(fired(text, "trailing-condition", "flavored")).toBe(false);
  });

  it("does not flag a descriptive sentence ending in a condition", () => {
    const descriptive = "The daemon respawns on the next call, if the port was released.";
    expect(fired(descriptive, "trailing-condition", "strict")).toBe(false);
  });
});

describe("vague-recommendation (strict only)", () => {
  it("flags an improvement with no named target", () => {
    const hit = lintProse("Improve error handling around the boundary.", { mode: "strict" }).violations.find(
      (v) => v.ruleId === "vague-recommendation",
    );
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("name the file or symbol");
  });

  it("does not flag when the sentence names a symbol or a path", () => {
    expect(fired("Improve error handling in `runPreflight`.", "vague-recommendation", "strict")).toBe(false);
    expect(
      fired("Improve error handling in packages/shared/src/errors.ts.", "vague-recommendation", "strict"),
    ).toBe(false);
  });

  it("is silent in flavored mode", () => {
    expect(fired("Improve error handling around the boundary.", "vague-recommendation", "flavored")).toBe(false);
  });
});

// --- tier 3 -----------------------------------------------------------------

describe("wordiness", () => {
  it("suggests the shorter form", () => {
    const hits = lintProse("In order to utilize the store, note that a number of calls are needed.")
      .violations.filter((v) => v.ruleId === "wordiness");
    const messages = hits.map((h) => h.message);
    expect(messages).toContain('"in order to" → "to".');
    expect(messages).toContain('"utilize" → "use".');
    expect(messages).toContain('"note that" — cut it.');
    expect(messages).toContain('"a number of" → "some".');
  });

  it("carries low severity", () => {
    const hit = lintProse("We utilize the store.").violations.find((v) => v.ruleId === "wordiness");
    expect(hit!.severity).toBe("low");
  });
});

// --- negative tests: preprocessing ------------------------------------------

describe("preprocessing: what must never trigger a rule", () => {
  it("ignores fenced code blocks entirely", () => {
    const text =
      "Here is the shape.\n\n```ts\nconst a = b; // SHOUTING and/or build/test/deploy → x\nif (x) { y(); }\n```\n\nThat is all.";
    expect(lintProse(text).violations).toHaveLength(0);
  });

  it("ignores an unterminated fence rather than linting half a code block", () => {
    const text = "Here it is.\n\n```ts\nconst a = b; // BUILD/TEST/DEPLOY → x";
    expect(lintProse(text).violations).toHaveLength(0);
  });

  it("ignores inline code spans", () => {
    const text = "Call `store.get(a; b)` and `build/test/deploy` before the REAL fix.";
    expect(ids(lintProse(text).violations)).toEqual(["all-caps-emphasis"]);
  });

  it("ignores markdown tables", () => {
    const text =
      "The tally:\n\n| lane | shape |\n| --- | --- |\n| build/test/deploy | LOUD; yes |\n\nThat is the table.";
    expect(lintProse(text).violations).toHaveLength(0);
  });

  it("ignores URLs", () => {
    const text = "Open http://localhost:3847/sessions/abc/def?x=A;B and read it.";
    expect(lintProse(text).violations).toHaveLength(0);
  });

  it("ignores file paths, anchored and extensioned", () => {
    for (const s of [
      "Look in packages/shared/src/prose-lint.ts for the rules.",
      "The bundle lives at ./claude-plugin/server/index.js today.",
      "Read /mnt/c/Users/mitch/notes.md first.",
      "Config is at ~/.deeppairing/projects.json now.",
    ]) {
      expect(lintProse(s).violations, s).toHaveLength(0);
    }
  });

  it("does not let a masked region shift a violation index", () => {
    const text = "Read `code` and then the build/test/deploy loop.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "slash-pack")!;
    expect(text.slice(hit.index, hit.index + "build/test/deploy".length)).toBe("build/test/deploy");
  });

  it("does not count a heading or a bullet glyph as a sentence", () => {
    // Headings and bullets are structure, so the sentence-shaped rules skip
    // them. Caps in a HEADING are a formatting choice, not shouting in a
    // paragraph, so all-caps-emphasis skips heading lines too.
    const text = "## WHAT THE RESEARCH SETTLED\n\n- one\n- two\n";
    expect(fired(text, "sentence-length")).toBe(false);
    expect(fired(text, "paragraph-length")).toBe(false);
    expect(fired(text, "all-caps-emphasis")).toBe(false);
    // ...but the same words in a body paragraph still count.
    expect(fired("WHAT THE RESEARCH SETTLED is the middle gear.", "all-caps-emphasis")).toBe(true);
  });

  it("lints the sentence inside a bullet, marker stripped", () => {
    const text = "- The gate fired; the artifact landed.";
    const hit = lintProse(text).violations.find((v) => v.ruleId === "semicolon");
    expect(hit).toBeDefined();
    expect(hit!.excerpt.startsWith("-")).toBe(false);
  });
});

describe("maskNonProse / splitProse", () => {
  it("preserves length and newlines exactly", () => {
    const text = "Prose here.\n\n```\ncode; LOUD\n```\n\nMore prose.";
    const masked = maskNonProse(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")).toHaveLength(text.split("\n").length);
    expect(masked).not.toContain("LOUD");
  });

  it("splits paragraphs on blank lines and sentences on terminal punctuation", () => {
    const paras = splitProse(maskNonProse("One. Two.\n\nThree."));
    expect(paras).toHaveLength(2);
    expect(paras[0]!.sentences.map((s) => s.text)).toEqual(["One.", "Two."]);
    expect(paras[1]!.sentences.map((s) => s.text)).toEqual(["Three."]);
  });
});

describe("excerptAt", () => {
  it("caps at 80 characters and collapses whitespace", () => {
    const long = `x${"y".repeat(200)}`;
    const out = excerptAt(long, 0, 200);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
    expect(excerptAt("a\n  b\tc", 0, 7)).toBe("a b c");
  });

  it("is applied to every violation a real sample produces", () => {
    const messy =
      "WHAT THE RESEARCH SETTLED: the build/test/deploy loop is slow (the daemon respawns, " +
      "which costs a second or two); shop routing outranks healthy elites → ~0.05 fewer relics per run.";
    for (const v of lintProse(messy).violations) {
      expect(v.excerpt.length).toBeLessThanOrEqual(80);
      expect(v.excerpt).not.toContain("\n");
      expect(v.index).toBeGreaterThanOrEqual(0);
      expect(v.index).toBeLessThan(messy.length);
    }
  });
});

// --- scoring ----------------------------------------------------------------

describe("scoring", () => {
  it("returns 100 for clean prose", () => {
    expect(lintProse("The daemon binds a port. The UI reads it.").score).toBe(100);
  });

  it("weights severity high 8, medium 4, low 1 per 100 words", () => {
    expect(scoreViolations([], 500)).toBe(100);
    expect(scoreViolations([{ ruleId: "x", severity: "high", message: "", excerpt: "", index: 0 }], 100)).toBe(92);
    expect(scoreViolations([{ ruleId: "x", severity: "medium", message: "", excerpt: "", index: 0 }], 100)).toBe(96);
    expect(scoreViolations([{ ruleId: "x", severity: "low", message: "", excerpt: "", index: 0 }], 100)).toBe(99);
  });

  it("normalizes by length so a long field is not punished for being long", () => {
    const one: Violation = { ruleId: "x", severity: "high", message: "", excerpt: "", index: 0 };
    expect(scoreViolations([one], 100)).toBe(92);
    expect(scoreViolations(Array(10).fill(one), 1000)).toBe(92);
  });

  it("floors very short fields at MIN_SCORING_WORDS so one slip cannot zero them", () => {
    const one: Violation = { ruleId: "x", severity: "high", message: "", excerpt: "", index: 0 };
    // 8 x 100 / 30 — the floor stops a three-word field dividing by nearly zero.
    expect(scoreViolations([one], 3)).toBe(73);
    expect(scoreViolations([one], 30)).toBe(73);
  });

  it("costs a SHORT field proportionally more, so the amber band is reachable", () => {
    const medium: Violation = { ruleId: "x", severity: "medium", message: "", excerpt: "", index: 0 };
    // The pre-review curve floored every field at 100 words, so this scored 96
    // and nothing could ever reach amber (<85) or red (<65).
    expect(scoreViolations([medium, medium], 50)).toBe(84);
    expect(scoreViolations([medium, medium], 500)).toBe(98);
  });

  it("clamps at 0", () => {
    const one: Violation = { ruleId: "x", severity: "high", message: "", excerpt: "", index: 0 };
    expect(scoreViolations(Array(50).fill(one), 10)).toBe(0);
  });

  it("scores a genuinely messy field well below a clean one", () => {
    const messy =
      "WHAT THE RESEARCH SETTLED: the build/test/deploy loop is slow (it respawns the daemon, " +
      "which costs a second or two); shop routing outranks healthy elites → fewer relics per run.";
    const clean = "Shop routing now outranks healthy elites. That is worth about 0.05 fewer relics per run.";
    expect(lintProse(messy).score).toBeLessThan(lintProse(clean).score);
    expect(lintProse(clean).score).toBe(100);
  });
});

// --- review round 1: the false positives, pinned ---------------------------

describe("regression: undefined-coinage false positives", () => {
  const COMMON = [
    "end-to-end", "out-of-the-box", "up-to-date", "one-to-one", "day-to-day",
    "state-of-the-art", "well-thought-out", "peer-to-peer", "copy-on-write",
    "one-size-fits-all", "first-come-first-served", "side-by-side",
    "back-and-forth", "off-the-shelf", "step-by-step", "on-the-fly",
    "out-of-band", "time-to-live",
  ];

  it("never asks the author to define an ordinary English compound", () => {
    for (const word of COMMON) {
      const text = `The ${word} path is fine. Every lane is ${word} here. Still ${word}.`;
      expect(fired(text, "undefined-coinage"), word).toBe(false);
    }
    expect(COMMON.length).toBe(18);
  });

  it("never flags a repeated QUOTED phrase — quoting your pair is the protocol", () => {
    const text =
      'You said "needs your eyes" on the gate. That "needs your eyes" note is why I stopped. ' +
      'The "needs your eyes" lane stays open.';
    expect(fired(text, "undefined-coinage")).toBe(false);
    const smart = "You called it \u201cthe compression register\u201d twice. The \u201cthe compression register\u201d holds.";
    expect(fired(smart, "undefined-coinage")).toBe(false);
  });
});

describe("regression: all-caps-emphasis false positives", () => {
  it("does not flag the acronyms and enum literals on the whitelist", () => {
    const tokens = [
      "LRU", "NAT", "CORS", "SVG", "PNG", "GIF", "JPEG", "JPG", "ETA", "SSE",
      "TTL", "WCAG", "SQL", "SELECT", "JOIN", "GET", "POST", "PUT", "PATCH",
      "DELETE", "HEAD", "BDA", "STE", "PMF", "RSS", "DNS", "TCP", "UDP", "SSH",
      "TLS", "SSL", "JWT", "UUID", "SHA", "CRUD", "REPL", "AST", "ORM", "E2E",
      "HIGH", "MEDIUM", "LOW", "WARN", "INFO", "ERROR", "DEBUG", "DRAFT",
    ];
    for (const t of tokens) {
      expect(fired(`The ${t} value is set on the record.`, "all-caps-emphasis"), t).toBe(false);
    }
  });

  it("does not flag caps on a markdown heading line", () => {
    expect(fired("### WHAT CHANGED\n\nThe daemon rebound its port.", "all-caps-emphasis")).toBe(false);
  });

  it("does not flag a quoted value, straight or smart", () => {
    expect(fired('The daemon logged "BIND FAILED" and retried.', "all-caps-emphasis")).toBe(false);
    expect(fired("The daemon logged \u201cBIND FAILED\u201d and retried.", "all-caps-emphasis")).toBe(false);
  });

  it("does not flag a LONE unlisted acronym, but does flag a run of caps", () => {
    // The whitelist can never name every acronym, so a lone unknown token amid
    // lowercase is read as a name, not a shout.
    expect(fired("A SPOF in the write path is the risk.", "all-caps-emphasis")).toBe(false);
    expect(fired("The SQS consumer drains it.", "all-caps-emphasis")).toBe(false);
    expect(fired("The MRTR spec landed.", "all-caps-emphasis")).toBe(false);
    // An ordinary English word in capitals is shouting.
    expect(fired("The middle gear is REAL.", "all-caps-emphasis")).toBe(true);
    // ...and so is a RUN of capitalised words, listed or not.
    expect(fired("The SPOF SQS lane is the risk.", "all-caps-emphasis")).toBe(true);
  });

  it("treats a hyphenated identifier as ONE token, and passes it when it carries a digit", () => {
    const hits = lintProse("The ASD-STE100 register is the reference.").violations.filter(
      (v) => v.ruleId === "all-caps-emphasis",
    );
    expect(hits).toHaveLength(0);
    expect(fired("Every ISO-8601 stamp is UTC.", "all-caps-emphasis")).toBe(false);
    // A digit-free hyphenated shout is still ONE violation, not two.
    const shout = lintProse("The REALLY-BADLY written line.").violations.filter(
      (v) => v.ruleId === "all-caps-emphasis",
    );
    expect(shout).toHaveLength(1);
    expect(shout[0]!.message).toContain('"REALLY-BADLY"');
  });
});

describe("regression: slash-pack false positives", () => {
  it("does not flag an extension-less repo path", () => {
    for (const s of [
      "The rules live in packages/shared/src today.",
      "Look under src/mcp/tools for the handler.",
      "The bundle is claude-plugin/server here.",
      "It sits in web/src/components/artifacts somewhere.",
      "Check node_modules/.bin first.",
      "The file is in my-app/src/store already.",
    ]) {
      expect(fired(s, "slash-pack"), s).toBe(false);
    }
  });

  it("still flags the canonical word pack", () => {
    expect(fired("The build/test/deploy loop is the slow part.", "slash-pack")).toBe(true);
    expect(fired("Every file/socket handle is closed.", "slash-pack")).toBe(true);
  });

  it("does not flag a ratio written in digits or in words", () => {
    for (const s of [
      "About 3/4 of the corpus is narrative.",
      "Roughly two/thirds of the cards carried a chip.",
      "That is one/half of the budget.",
    ]) {
      expect(fired(s, "slash-pack"), s).toBe(false);
    }
  });
});

describe("regression: arrow-chain, blockquotes, vague recommendations", () => {
  it("does not flag an arrow whose sides are both numbers", () => {
    expect(fired("The chip count went 5 -> 4 after the fix.", "arrow-chain")).toBe(false);
    expect(fired("Coverage moved 92% → 71% overnight.", "arrow-chain")).toBe(false);
    // A causal arrow between words still fires.
    expect(fired("Preflight → block → toast.", "arrow-chain")).toBe(true);
    expect(fired("Shop routing → ~0.05 fewer relics per run.", "arrow-chain")).toBe(true);
  });

  it("masks a markdown blockquote — quoted text is not the agent's register", () => {
    const text = "You wrote:\n\n> The build/test/deploy loop is slow; it SHOUTS at me → always.\n\nThat is fixed now.";
    expect(lintProse(text).violations).toHaveLength(0);
  });

  it("does not call a localized recommendation vague", () => {
    for (const s of [
      "Improve the retry loop in the daemon supervisor.",
      "Improve its error handling before the next release.",
      "Improve error handling in runPreflight.",
      "Improve error handling on line 40.",
    ]) {
      expect(fired(s, "vague-recommendation", "strict"), s).toBe(false);
    }
  });

  it("still flags a bare mass-noun improvement, at LOW severity", () => {
    const hit = lintProse("Improve error handling around the boundary.", { mode: "strict" }).violations.find(
      (v) => v.ruleId === "vague-recommendation",
    );
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("low");
  });
});

// --- lintArtifactContent ----------------------------------------------------

describe("lintArtifactContent", () => {
  it("walks research fields and reports concrete paths", () => {
    const result = lintArtifactContent("research", {
      summary: "The gate fired; the artifact landed.",
      findings: [
        { category: "a", detail: "Clean detail here.", significance: "low" },
        {
          category: "b",
          detail: "The build/test/deploy loop is slow.",
          significance: "high",
          recommendation: "Improve error handling around the boundary.",
        },
      ],
    });
    const paths = result.fields.map((f) => f.path);
    expect(paths).toContain("summary");
    expect(paths).toContain("findings[1].detail");
    expect(paths).toContain("findings[1].recommendation");
    expect(paths).not.toContain("findings[0].detail");
  });

  it("applies strict mode to recommendations and flavored mode to details", () => {
    const result = lintArtifactContent("research", {
      summary: "",
      findings: [
        {
          category: "a",
          detail: "x",
          significance: "low",
          recommendation: "Improve error handling around the boundary.",
        },
      ],
    });
    const rec = result.fields.find((f) => f.path === "findings[0].recommendation")!;
    expect(rec.mode).toBe("strict");
    expect(rec.violations.some((v) => v.ruleId === "vague-recommendation")).toBe(true);
  });

  it("takes the WORST field score as the artifact score", () => {
    const result = lintArtifactContent("debrief", {
      summary: "A perfectly ordinary summary of the work.",
      needsYourEyes: [
        {
          what: "WHAT THE RESEARCH SETTLED; the build/test/deploy loop → slow (a real problem here).",
          why: "It matters.",
        },
      ],
    });
    const worst = Math.min(...result.fields.map((f) => f.score));
    expect(result.score).toBe(worst);
    expect(result.score).toBeLessThan(100);
  });

  it("returns a clean result for clean content, an unknown type, or a non-object", () => {
    expect(lintArtifactContent("research", { summary: "The daemon binds a port.", findings: [] })).toEqual({
      fields: [],
      violations: [],
      score: 100,
    });
    expect(lintArtifactContent("nope", { summary: "x; y" }).score).toBe(100);
    expect(lintArtifactContent("research", null).score).toBe(100);
    expect(lintArtifactContent("research", "a string").score).toBe(100);
  });

  it("reads defensively — wrong-typed and missing fields are skipped, never thrown on", () => {
    expect(() =>
      lintArtifactContent("research", {
        summary: 42,
        findings: "not an array",
        openQuestions: [null, 7, { nope: true }],
      }),
    ).not.toThrow();
    expect(
      lintArtifactContent("plan", { steps: [null, { description: undefined }, 3] }).score,
    ).toBe(100);
  });

  it("walks a nested array path (plan step branches)", () => {
    const result = lintArtifactContent("plan", {
      steps: [
        {
          description: "Do the thing.",
          reasoning: "Because.",
          branches: [{ description: "The build/test/deploy loop applies here.", reasoning: "Because." }],
        },
      ],
    });
    expect(result.fields.map((f) => f.path)).toContain("steps[0].branches[0].description");
  });

  it("walks bare string arrays (openQuestions)", () => {
    const result = lintArtifactContent("debrief", {
      summary: "Fine.",
      openQuestions: ["Should we keep the build/test/deploy loop?"],
    });
    expect(result.fields.map((f) => f.path)).toContain("openQuestions[0]");
    expect(result.fields[0]!.mode).toBe("strict");
  });

  it("lints a visual caption but never tells it to move its arrow into a visual", () => {
    const result = lintArtifactContent("decision", {
      options: [
        {
          id: "o1",
          label: "Redis",
          description: "Fine.",
          visuals: [{ id: "v1", kind: "diagram", caption: "App → Redis, TTL on the key" }],
        },
      ],
    });
    expect(result.violations.some((v) => v.ruleId === "arrow-chain")).toBe(false);
    expect(result.score).toBe(100);
    // The path IS in the map, and a non-exempt rule still fires there.
    const shouty = lintArtifactContent("explainer", {
      overview: "Fine.",
      sections: [],
      visuals: [{ id: "v1", kind: "diagram", caption: "The store is REALLY the ONLY source." }],
    });
    expect(shouty.fields.map((f) => f.path)).toContain("visuals[0].caption");
  });

  it("covers every artifact type in the field map with at least one field", () => {
    for (const type of Object.keys(PROSE_FIELD_MAP)) {
      expect(PROSE_FIELD_MAP[type]!.length, type).toBeGreaterThan(0);
    }
    for (const type of [
      "research",
      "plan",
      "spec",
      "decision",
      "code_change",
      "changeset",
      "reasoning",
      "debrief",
      "explainer",
    ]) {
      expect(Object.keys(PROSE_FIELD_MAP), type).toContain(type);
    }
  });
});
