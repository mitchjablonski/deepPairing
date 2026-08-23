/**
 * R3 — the page that leaves the building, hardened.
 *
 * Round 13 put three lenses on the export path and every one of them came back
 * with something the page did to the person who sent it. These are the pins:
 * each `it` below fails on the code as it stood before this batch, with the
 * exact input that was measured.
 *
 * The grouping is by what goes wrong for a HUMAN, not by function:
 *   - availability — a comment that permanently kills the session's page
 *   - the scan     — a warning that reported clean while a live key rendered
 *   - honesty      — a page that claims more agreement than the session had
 *   - hygiene      — the exporter's username, riding out in prose
 *   - size/layout  — a page too big to open, or too wide to read on a phone
 */
import { describe, it, expect } from "vitest";
import type { Artifact, Comment } from "@deeppairing/shared";
import {
  formatSessionHtml,
  renderMarkdown,
  sanitizePath,
  scrubProse,
  type HtmlSessionState,
} from "../format-html.js";
import {
  scanExportForSecrets,
  secretLabelsOf,
  secretWarningFor,
  secretWarningHeader,
} from "../html-export.js";

const OPTS = {
  version: "0.1.35",
  generatedAt: "2026-08-21T12:00:00.000Z",
  projectName: "checkout",
  projectRoot: "/home/tester/checkout",
};

function baseState(over: Partial<HtmlSessionState> = {}): HtmlSessionState {
  return {
    sessionId: "session_checkout_ab12cd34",
    artifacts: [],
    comments: [],
    decisions: [],
    planReviews: [],
    ...over,
  };
}

function artifact(over: Partial<Artifact> & Pick<Artifact, "id" | "type" | "title" | "content">): Artifact {
  return {
    sessionId: "session_checkout_ab12cd34",
    version: 1,
    parentId: null,
    status: "approved",
    agentReasoning: null,
    createdAt: "2026-08-21T09:00:00.000Z",
    updatedAt: "2026-08-21T09:00:00.000Z",
    ...over,
  } as Artifact;
}

function comment(over: Partial<Comment> & Pick<Comment, "id" | "content"> & { target: any }): Comment {
  return {
    sessionId: "session_checkout_ab12cd34",
    author: "human",
    intent: "comment",
    createdAt: "2026-08-21T09:30:00.000Z",
    acknowledged: false,
    ...over,
  } as Comment;
}

// ---------------------------------------------------------------------------
// 1. Availability — the two inputs that took the route down
// ---------------------------------------------------------------------------

describe("R3 — a pasted comment can never kill the session's page", () => {
  // THE MEASURED REPRO. A 4KB run of ">" recursed once per character:
  // RangeError: Maximum call stack size exceeded → GET /api/export.html 500s,
  // and because the comment is PERSISTED it 500s forever. The session's
  // shareable page was dead permanently and the UI blamed the daemon.
  it("renders a 4KB run of '>' in well under 100ms instead of blowing the stack", () => {
    const bomb = ">".repeat(4096);
    const started = Date.now();
    const html = renderMarkdown(bomb);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);
    expect(html).toContain("<blockquote");
    // Nothing the author typed is dropped — past the depth cap the remainder
    // renders as literal text.
    expect(html).toContain("&gt;");
  });

  it("caps nesting depth rather than nesting once per '>' character", () => {
    const html = renderMarkdown(">".repeat(50) + " deep");
    const depth = (html.match(/<blockquote/g) ?? []).length;
    expect(depth).toBeLessThanOrEqual(9); // MAX_QUOTE_DEPTH + the literal-remainder wrapper
    expect(depth).toBeGreaterThan(0);
    expect(html).toContain("deep");
  });

  it("survives the whole page when a blockquote bomb rides in a comment", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "research", title: "Audit", content: { findings: [] } })],
      comments: [comment({ id: "c1", content: ">".repeat(4096), target: { artifactId: "a1" } })],
    });
    const started = Date.now();
    const html = formatSessionHtml(state, OPTS);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(html).toContain("<!doctype html>");
  });

  // THE MEASURED REPRO. 120k "[" characters took 8.0s of BLOCKED event loop on
  // the old quadratic `\[([^\]]+)\]\(...\)`; the export runs in-process in the
  // daemon, so that is the whole server, for every session.
  it("renders 200k '[' characters in under 500ms instead of quadratic time", () => {
    const started = Date.now();
    renderMarkdown("[".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stays fast on the shapes that DO have a ']' to scan for", () => {
    const started = Date.now();
    renderMarkdown("[".repeat(100_000) + "](x)");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("still renders real links, and still refuses unsafe ones", () => {
    expect(renderMarkdown("see [the docs](https://example.com/a?b=1&c=2)")).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">the docs</a>',
    );
    // Protocol-relative is not relative (F8) — still dropped to plain text.
    expect(renderMarkdown("[x](//evil.example/x)")).not.toContain("<a ");
    expect(renderMarkdown("[x](/local/page)")).toContain("<a ");
  });

  it("degrades one block to plain text rather than losing the page", () => {
    // The last-resort guard: whatever future input finds a new way to throw,
    // the route must still answer 200 with the rest of the session on it.
    const html = renderMarkdown("ordinary paragraph");
    expect(html).toContain("<p>ordinary paragraph</p>");
  });
});

// ---------------------------------------------------------------------------
// 2. The scan — it reported clean while a live key rendered
// ---------------------------------------------------------------------------

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GH_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";
const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz";

function leakyState(): HtmlSessionState {
  return baseState({
    artifacts: [
      artifact({
        id: "a_research",
        type: "research",
        title: "Audit",
        content: {
          findings: [
            {
              category: "Security",
              detail: "The key is inlined.",
              significance: "high",
              // Depth 8 rooted at state / depth 5 rooted at content: the old
              // maxDepth-6-rooted-at-state walk reached NEITHER.
              evidence: [{ filePath: "src/aws.ts", snippet: `const id = "${AWS_KEY}";` }],
            },
          ],
        },
      }),
      artifact({
        id: "a_changeset",
        type: "changeset",
        title: "CI tokens",
        content: {
          files: [
            {
              path: ".github/workflows/ci.yml",
              changeType: "modified",
              hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "add", content: `  token: ${GH_TOKEN}`, newLine: 3 }] }],
            },
          ],
        },
      }),
    ],
  });
}

describe("R3 — the export-time secret scan actually reads what the page renders", () => {
  it("finds an AWS key in an evidence snippet, a ghp_ in a hunk line, and a key in the narrative", () => {
    const matches = scanExportForSecrets(leakyState(), {
      narrative: `I pasted ${OPENAI_KEY} into the test to reproduce it.`,
    });
    const labels = secretLabelsOf(matches);
    expect(labels).toContain("AWS access key id");
    expect(labels).toContain("GitHub personal access token");
    expect(labels).toContain("OpenAI / Anthropic-shape API key");
  });

  it("roots artifact content the way the STORE roots it, so field paths agree", () => {
    const matches = scanExportForSecrets(leakyState());
    const aws = matches.find((m) => m.pattern === "AKIA");
    const gh = matches.find((m) => m.pattern === "ghp_");
    // Not `artifacts[0].content.findings[0]...` — the store says
    // `findings[0].evidence[0].snippet` and now so does the export.
    // R3 (adversarial F4) — the prefix now names the artifact by index + title
    // so 40 hits are 40 findable places; the store-rooted tail is unchanged.
    expect(aws?.field).toBe('research #1 "Audit".findings[0].evidence[0].snippet');
    expect(gh?.field).toBe('changeset #2 "CI tokens".files[0].hunks[0].lines[0].content');
  });

  it("names the field and NEVER the value — on all three surfaces", () => {
    const matches = scanExportForSecrets(leakyState(), { narrative: `key ${OPENAI_KEY}` });
    const sentence = secretWarningFor(leakyState(), { narrative: `key ${OPENAI_KEY}` }) ?? "";
    const header = secretWarningHeader(matches) ?? "";
    const page = formatSessionHtml(leakyState(), { ...OPTS, secretLabels: secretLabelsOf(matches) });
    for (const surface of [sentence, header]) {
      expect(surface).not.toContain(AWS_KEY);
      expect(surface).not.toContain(GH_TOKEN);
      expect(surface).toContain("AWS access key id");
    }
    expect(page).toContain('<div class="secret-banner"');
    expect(page).toContain("AWS access key id");
    expect(page).toContain("Check this page before you send it");
  });

  it("emits an ASCII-only, newline-free header value", () => {
    const header = secretWarningHeader(scanExportForSecrets(leakyState())) ?? "";
    expect(header).not.toBe("");
    expect(header).toMatch(/^[\x20-\x7E]+$/);
    expect(header).not.toContain("\n");
  });

  it("is silent — and byte-identical — for a clean session", () => {
    const clean = baseState({
      artifacts: [artifact({ id: "a1", type: "research", title: "Audit", content: { findings: [] } })],
    });
    expect(scanExportForSecrets(clean)).toEqual([]);
    expect(secretWarningHeader([])).toBeNull();
    // A clean scan renders NO banner and is deterministic. (It DOES add the
    // F11 "scan ran" footnote when secretLabels is defined — [] means
    // scanned-clean — so it is no longer byte-identical to a call that wired no
    // scan at all; that difference is the point of F11.)
    const cleanA = formatSessionHtml(clean, { ...OPTS, secretLabels: [] });
    const cleanB = formatSessionHtml(clean, { ...OPTS, secretLabels: [] });
    expect(cleanA).toBe(cleanB);
    expect(cleanA).not.toContain('<div class="secret-banner"');
    expect(cleanA).toContain("Secret-shape scan ran before export");
    // A call that wires no scan says nothing about scanning.
    expect(formatSessionHtml(clean, OPTS)).not.toContain("Secret-shape scan ran");
  });

  it("warns, never blocks — the page still renders every finding", () => {
    const html = formatSessionHtml(leakyState(), {
      ...OPTS,
      secretLabels: secretLabelsOf(scanExportForSecrets(leakyState())),
    });
    expect(html).toContain("The key is inlined.");
    expect(html).toContain(".github/workflows/ci.yml");
  });
});

// ---------------------------------------------------------------------------
// 3. Honesty — unapproved work, external review, the gate's own counter
// ---------------------------------------------------------------------------

describe("R3 — work nobody approved is marked as work nobody approved", () => {
  const statuses = [
    ["draft", "draft", "still a draft"],
    ["reviewing", "under review", "still under review"],
    ["revised", "sent back", "asked for changes"],
  ] as const;

  for (const [status, badge, phrase] of statuses) {
    it(`marks a ${status} artifact — without the not-shipped strike`, () => {
      const state = baseState({
        artifacts: [
          artifact({ id: "a1", type: "spec", title: "Rate limiting", status, content: { objective: "Cap the burst." } }),
        ],
      });
      const html = formatSessionHtml(state, OPTS);
      expect(html).toContain("not approved");
      expect(html).toContain(phrase);
      expect(html).toContain(`chip--unapproved">${badge}<`);
      // The strike-through means "we decided against this" — a different claim.
      expect(html).not.toContain("<s>Rate limiting</s>");
    });
  }

  it("leaves approved work unmarked", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "spec", title: "Rate limiting", content: { objective: "Cap the burst." } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).not.toContain("not approved");
    expect(html).not.toContain('chip--unapproved">');
  });

  it("still strikes rejected work — the two marks are distinct", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "plan", title: "Big bang cutover", status: "rejected", content: { steps: [] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("<s>Big bang cutover</s>");
    expect(html).toContain("rejected: the human declined this");
    expect(html).not.toContain('chip--unapproved">');
  });
});

describe("R3 — a page about someone else's PR says so", () => {
  function reviewState(source?: Record<string, unknown>): HtmlSessionState {
    return baseState({
      artifacts: [
        artifact({
          id: "a_ext",
          type: "changeset",
          title: "Rate limiter",
          content: {
            summary: "Their limiter.",
            reviewIntent: "external",
            ...(source ? { source } : {}),
            files: [{ path: "src/limit.ts", changeType: "modified", hunks: [] }],
          },
        }),
      ],
      decisions: [],
    });
  }

  it("puts a PR provenance block in the masthead", () => {
    const html = formatSessionHtml(
      reviewState({ kind: "github-pr", number: 412, url: "https://github.com/acme/api/pull/412", headRef: "feat/limit", baseRef: "main", author: "priya" }),
      OPTS,
    );
    expect(html).toContain("review of someone else's code");
    expect(html).toContain("pull request #412");
    expect(html).toContain('href="https://github.com/acme/api/pull/412"');
    expect(html).toContain("priya");
    expect(html).toContain("feat/limit");
    expect(html).toContain("main");
    expect(html).toContain("Nothing on this page merged, landed or approved anything");
  });

  it("badges the external changeset's own timeline block", () => {
    const html = formatSessionHtml(reviewState({ kind: "github-pr", number: 412 }), OPTS);
    expect(html).toContain('beat--external"');
    expect(html).toContain("external review");
    expect(html).toContain("the reviewer's opinion");
  });

  it("says only what the record carries when provenance is thin", () => {
    const html = formatSessionHtml(reviewState(), OPTS);
    expect(html).toContain("a pull request from another author");
    expect(html).not.toContain("#undefined");
    expect(html).not.toContain("undefined");
  });

  it("leaves a page about the pair's OWN work untouched", () => {
    const own = baseState({
      artifacts: [
        artifact({ id: "a1", type: "changeset", title: "Our limiter", content: { files: [{ path: "src/limit.ts", changeType: "modified", hunks: [] }] } }),
      ],
    });
    const html = formatSessionHtml(own, OPTS);
    expect(html).not.toContain('<div class="provenance">');
    expect(html).not.toContain('chip--external">');
  });

  it("titles the page from the narrative's first heading, not the first decision", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "decision", title: "Which lens first?", content: { decisionId: "d1", options: [] } })],
      decisions: [
        {
          decisionId: "d1",
          artifactId: "a1",
          context: "Which lens first?",
          title: "Which lens first?",
          options: [],
          createdAt: "2026-08-21T09:00:00.000Z",
        },
      ],
    });
    const withNarrative = formatSessionHtml(state, {
      ...OPTS,
      narrative: "# Reviewing Priya's rate limiter\n\nShe asked for a read.",
    });
    expect(withNarrative).toContain("<title>Reviewing Priya&#39;s rate limiter — deepPairing session</title>");
    expect(withNarrative).toContain("<h1>Reviewing Priya&#39;s rate limiter</h1>");
    // Without a narrative the old heuristic is still the fallback.
    expect(formatSessionHtml(state, OPTS)).toContain("<h1>Which lens first?</h1>");
  });

  it("strips inline markdown out of a heading used as the title", () => {
    const html = formatSessionHtml(baseState(), { ...OPTS, narrative: "## **Rate** `limiting`\n\nbody" });
    expect(html).toContain("<h1>Rate limiting</h1>");
  });
});

describe("R3 — the gate beat counts what it says it counts", () => {
  function traceState(consideredCount: number, source: "session" | "global"): HtmlSessionState {
    return baseState({
      preflightTraces: [
        {
          at: "2026-08-21T10:00:00.000Z",
          artifactId: "a1",
          toolName: "present_plan",
          decision: "admitted",
          consideredCount,
          nearMisses: [{ concept: "shared mutable cache", source, project: "battleBabies" }],
        },
      ],
    });
  }

  // THE BUG: `consideredCount` counts LOCAL stances only, so a trace whose
  // near-miss came from the cross-project ledger rendered "The gate weighed 0
  // recorded stances" at the exact moment the gate had weighed one and said so.
  it("never claims zero when a cross-project stance is what fired", () => {
    const html = formatSessionHtml(traceState(0, "global"), OPTS);
    expect(html).not.toContain("weighed 0 recorded stances");
    expect(html).toContain("carried over from another project");
  });

  it("still names the local count when there is one", () => {
    expect(formatSessionHtml(traceState(3, "session"), OPTS)).toContain("weighed 3 recorded stances");
  });

  it("names both when both fired", () => {
    const state = baseState({
      preflightTraces: [
        {
          at: "2026-08-21T10:00:00.000Z",
          artifactId: "a1",
          toolName: "present_plan",
          decision: "admitted",
          consideredCount: 2,
          nearMisses: [
            { concept: "shared mutable cache", source: "session" },
            { concept: "in-process state", source: "global", project: "battleBabies" },
          ],
        },
      ],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("2 stances recorded in this session");
    expect(html).toContain("1 more carried over from another project");
  });
});

// ---------------------------------------------------------------------------
// 4. Hygiene — the username that rode out in prose
// ---------------------------------------------------------------------------

describe("R3 — machine paths are collapsed in PROSE, not only in path fields", () => {
  it("collapses the home directory inside a narrative", () => {
    const html = formatSessionHtml(baseState(), {
      ...OPTS,
      projectRoot: undefined,
      narrative: "I traced it through /home/mitch/work/checkout/src/auth/hash.ts and it was fine.",
    });
    expect(html).not.toContain("/home/mitch");
    expect(html).toContain("~/work/checkout/src/auth/hash.ts");
  });

  it("collapses the WSL layout this repo is developed on", () => {
    expect(scrubProse("see /mnt/c/Users/mitch/Documents/dev/x.ts", undefined)).toBe("see ~/Documents/dev/x.ts");
  });

  it("collapses paths in comment bodies and artifact summaries too", () => {
    const state = baseState({
      artifacts: [
        artifact({
          id: "a1",
          type: "research",
          title: "Audit",
          content: { summary: "Everything hangs off /home/mitch/checkout/src/index.ts." },
        }),
      ],
      comments: [comment({ id: "c1", content: "also /home/mitch/notes.md", target: { artifactId: "a1" } })],
    });
    const html = formatSessionHtml(state, { ...OPTS, projectRoot: undefined });
    expect(html).not.toContain("/home/mitch");
    expect(html).toContain("~/checkout/src/index.ts");
    expect(html).toContain("~/notes.md");
  });

  it("collapses a path inside a fenced code block in prose", () => {
    const html = formatSessionHtml(baseState(), {
      ...OPTS,
      projectRoot: undefined,
      narrative: "```\ncat /home/mitch/secret-layout/x.env\n```",
    });
    expect(html).not.toContain("/home/mitch");
  });

  // THE OTHER DIRECTION. The unanchored `^.*?/(home|Users)/[^/]+/` mangled a
  // legitimate RELATIVE path every Rails app has: three directories deleted and
  // a home directory invented, on the page a colleague reads to find the file.
  it("leaves a legitimate relative path containing 'home/' exactly as written", () => {
    expect(sanitizePath("app/views/home/partials/index.erb")).toBe("app/views/home/partials/index.erb");
    expect(sanitizePath("src/Users/profile.ts")).toBe("src/Users/profile.ts");
    expect(scrubProse("open app/views/home/partials/index.erb", undefined)).toBe(
      "open app/views/home/partials/index.erb",
    );
  });

  it("still collapses the absolute forms", () => {
    expect(sanitizePath("/home/mitch/x/y.ts")).toBe("~/x/y.ts");
    expect(sanitizePath("/Users/mitch/x/y.ts")).toBe("~/x/y.ts");
    expect(sanitizePath("C:/Users/mitch/x/y.ts")).toBe("~/x/y.ts");
    expect(sanitizePath("/mnt/c/Users/mitch/x/y.ts")).toBe("~/x/y.ts");
    expect(sanitizePath("/cygdrive/c/Users/mitch/x/y.ts")).toBe("~/x/y.ts");
  });

  it("does not mistake a URL path for a home directory", () => {
    expect(scrubProse("see https://example.com/home/mitch/post", undefined)).toBe(
      "see https://example.com/home/mitch/post",
    );
  });

  it("prints no session id anywhere on the page", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "research", title: "Audit", content: { findings: [] } })],
      comments: [comment({ id: "c1", content: "note", target: { artifactId: "a1" } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).not.toContain("session_");
    expect(html).not.toContain("ab12cd34");
  });
});

// ---------------------------------------------------------------------------
// 5. Size + layout — a page you can open, on a phone
// ---------------------------------------------------------------------------

describe("R3 — the whole page has a size bound", () => {
  // THE MEASURED REPRO: 60 changesets × 40 files × 500 diff lines produced a
  // 210MB single HTML file, because every cap in the renderer was per-thing and
  // none of them multiplied.
  it("keeps the 60x40x500 fixture to a size a browser can open, and says what it dropped", () => {
    const artifacts: Artifact[] = [];
    for (let c = 0; c < 60; c++) {
      artifacts.push(
        artifact({
          id: `cs_${c}`,
          type: "changeset",
          title: `Changeset ${c}`,
          createdAt: `2026-08-21T09:${String(c % 60).padStart(2, "0")}:00.000Z`,
          content: {
            files: Array.from({ length: 40 }, (_, f) => ({
              path: `src/pkg${c}/file${f}.ts`,
              changeType: "modified",
              hunks: [
                {
                  header: "@@ -1,500 +1,500 @@",
                  lines: Array.from({ length: 500 }, (_, l) => ({
                    kind: "add",
                    content: `const value${l} = ${l}; // a line of a very large generated diff`,
                    newLine: l + 1,
                  })),
                },
              ],
            })),
          },
        }),
      );
    }
    const html = formatSessionHtml(baseState({ artifacts }), OPTS);
    const megabytes = Buffer.byteLength(html, "utf-8") / (1024 * 1024);
    expect(megabytes).toBeLessThan(8);
    expect(html.toLowerCase()).toContain("truncated for size");
    expect(html).toMatch(/sections were truncated to keep this/);
    // The RECORD survives at full fidelity — only the code inside it collapses.
    expect(html).toContain("Changeset 59");
    expect(html).toContain("src/pkg59/file39.ts");
  });

  it("adds no size note to a page that never hit the cap", () => {
    const html = formatSessionHtml(
      baseState({ artifacts: [artifact({ id: "a1", type: "research", title: "Audit", content: { findings: [] } })] }),
      OPTS,
    );
    expect(html.toLowerCase()).not.toContain("truncated for size");
    expect(html).not.toContain('<p class="size-note">');
  });
});

describe("R3 — risk chips read on a phone", () => {
  it("wraps instead of forcing sideways scroll, and prints no literal backticks", () => {
    const state = baseState({
      artifacts: [
        artifact({
          id: "a1",
          type: "changeset",
          title: "Auth rework",
          content: {
            risks: [
              "This touches `src/auth/session.ts`, which re-signs the session cookie on every request, so a mistake here logs everyone out at once rather than failing loudly in CI.",
            ],
            files: [],
          },
        }),
      ],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("chips--risk");
    expect(html).toContain(".chip--risk { white-space: normal;");
    // The agent writes markdown; the chip is not a markdown surface.
    expect(html).not.toContain("`src/auth/session.ts`");
    expect(html).toContain("src/auth/session.ts");
  });
});

// ---------------------------------------------------------------------------
// 6. Visuals — the diagram the pair discussed is at least PRESENT
// ---------------------------------------------------------------------------

describe("R3 — visuals reach the page", () => {
  const diagram = {
    id: "v1",
    kind: "diagram",
    title: "Token refresh",
    caption: "How the refresh races.",
    source: "flowchart TD\n  A[Client] --> B[Auth]\n  B --> C[(Store)]",
  };

  it("renders a plan's diagram source in a labelled collapsible block", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "plan", title: "Refresh plan", content: { steps: [], visuals: [diagram] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("Token refresh");
    expect(html).toContain("How the refresh races.");
    // T1 (round-15) — the source is labelled honestly + prominently, framed as a
    // diagram rendered in deepPairing, and the note names where to see it drawn.
    expect(html).toContain("Diagram source (Mermaid)");
    expect(html).toContain("flowchart TD");
    expect(html).toContain("rendered in deepPairing");
    expect(html).toContain("mermaid.live");
  });

  // S4 (round-14) + T1 (round-15) — the diagram ships as an honest source-note.
  // Server-side Mermaid→SVG was investigated AGAIN and rejected: mermaid@11 needs
  // a real browser DOM; driven headless against happy-dom it throws in edge
  // geometry (getPointAtLength / getTotalLength are a browser engine, not a shim),
  // and a faithful render needs a headless Chromium the daemon export path can't
  // take over arbitrary/hostile source. The pins the fallback must keep: the
  // source is XSS-safe (a hostile diagram body does NOT execute), the block makes
  // ZERO external requests, and malformed/huge source degrades gracefully.
  it("a hostile diagram source is escaped, not executed (XSS-safe)", () => {
    const evil = {
      id: "vx",
      kind: "diagram",
      title: "Evil",
      source: 'graph TD\n  A["</code></pre><script>alert(1)</script>"] --> B',
    };
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "plan", title: "P", content: { steps: [], visuals: [evil] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("the diagram block is self-contained — no external subresource requests", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "plan", title: "P", content: { steps: [], visuals: [diagram] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    // Isolate the diagram block (head → the </details> that closes its source)
    // and prove it pulls nothing off the network. A plain-text mention of
    // "mermaid.live" in the note is prose, not a request; there must be no
    // src=/href= to an http(s) origin and no active subresource element.
    const start = html.indexOf('class="visual"');
    const block = html.slice(start, html.indexOf("</details>", start));
    expect(block).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(block).not.toMatch(/<(?:script|iframe|img|link|object|embed)\b/i);
  });

  // T1 (round-15) — a fuller hostile-source matrix: an escaped diagram body must
  // never introduce an active element or an event-handler attribute, whatever the
  // agent (or an attacker who fed the agent) put in the source.
  it("a diagram source with img/svg/handler payloads stays inert (XSS matrix)", () => {
    const evil = {
      id: "vx2",
      kind: "diagram",
      title: "Evil2",
      source:
        'graph TD\n  A["</code></pre><img src=x onerror=alert(1)>"] --> B\n' +
        '  B["<svg onload=alert(2)></svg>"] --> C\n' +
        '  C["<iframe src=javascript:alert(3)></iframe>"]',
    };
    const html = formatSessionHtml(
      baseState({ artifacts: [artifact({ id: "a1", type: "plan", title: "P", content: { steps: [], visuals: [evil] } })] }),
      OPTS,
    );
    const start = html.indexOf('class="visual"');
    const block = html.slice(start, html.indexOf("</details>", start) + 10);
    // No LIVE element survives — the payloads exist only as escaped text, so an
    // `onerror=` substring inside `&lt;img …&gt;` is inert and expected.
    expect(block).not.toMatch(/<(?:script|iframe|img|svg|link|object|embed)\b/i);
    expect(block).toContain("&lt;img");
    expect(block).toContain("&lt;svg");
    expect(block).toContain("&lt;iframe");
  });

  it("a malformed / huge diagram source degrades gracefully (no throw, still self-contained)", () => {
    const huge = {
      id: "vx3",
      kind: "diagram",
      title: "Huge",
      // not valid mermaid, and large — the exporter must not parse or render it,
      // just carry it as escaped source text.
      source: "this is )(*&^ not %%% mermaid at all\n".repeat(4000),
    };
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "plan", title: "P", content: { steps: [], visuals: [huge] } })],
    });
    let html = "";
    expect(() => { html = formatSessionHtml(state, OPTS); }).not.toThrow();
    const start = html.indexOf('class="visual"');
    const block = html.slice(start, html.indexOf("</details>", start));
    expect(block).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(block).toContain("not %%% mermaid at all");
  });

  it("renders a spec's visuals and a decision option's visuals too", () => {
    const spec = baseState({
      artifacts: [artifact({ id: "a1", type: "spec", title: "S", content: { objective: "o", visuals: [diagram] } })],
    });
    expect(formatSessionHtml(spec, OPTS)).toContain("flowchart TD");

    const decision = baseState({
      artifacts: [
        artifact({
          id: "a2",
          type: "decision",
          title: "D",
          content: {
            decisionId: "d1",
            options: [
              { id: "o1", title: "Option one", description: "d", pros: [], cons: [], effort: "low", risk: "low", visuals: [diagram] },
            ],
          },
        }),
      ],
    });
    expect(formatSessionHtml(decision, OPTS)).toContain("flowchart TD");
  });

  it("renders a file map as a real list", () => {
    const state = baseState({
      artifacts: [
        artifact({
          id: "a1",
          type: "plan",
          title: "P",
          content: {
            steps: [],
            visuals: [{ id: "v2", kind: "file_map", files: [{ path: "/home/tester/checkout/src/new.ts", change: "create", note: "the entry point" }] }],
          },
        }),
      ],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("File map");
    expect(html).toContain("src/new.ts");
    expect(html).not.toContain("/home/tester");
    expect(html).toContain("the entry point");
  });

  it("never embeds a prototype — the page runs nothing and fetches nothing", () => {
    const state = baseState({
      artifacts: [
        artifact({
          id: "a1",
          type: "plan",
          title: "P",
          content: { steps: [], visuals: [{ id: "v3", kind: "prototype", html: "<script>alert(1)</script>" }] },
        }),
      ],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("not embedded");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<iframe");
  });

  // R4 (#284) — the strip fix reaches the share page too: research / explainer /
  // changeset / debrief visuals now survive schema→store→render→EXPORT.
  const r4diagram = { id: "r4v", kind: "diagram", title: "The shape", source: "graph LR; A to B" };

  it("R4 P-B — a research artifact's visuals reach the page", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "research", title: "R", content: { summary: "s", findings: [], visuals: [r4diagram] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("The shape");
    expect(html).toContain("graph LR; A to B");
  });

  it("R4 P-B — an EXPLAINER's visuals reach the page (the round-13 headline, end-to-end)", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "explainer", title: "How it works", content: { title: "How it works", overview: "o", sections: [{ heading: "1", body: "b" }], visuals: [r4diagram] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("The shape");
    expect(html).toContain("graph LR; A to B");
  });

  it("R4 P-B — changeset + debrief visuals reach the page", () => {
    const cs = baseState({
      artifacts: [artifact({ id: "a1", type: "changeset", title: "CS", content: { files: [], visuals: [r4diagram] } })],
    });
    expect(formatSessionHtml(cs, OPTS)).toContain("graph LR; A to B");
    const db = baseState({
      artifacts: [artifact({ id: "a2", type: "debrief", title: "DB", content: { summary: "we built it", visuals: [r4diagram] } })],
    });
    expect(formatSessionHtml(db, OPTS)).toContain("graph LR; A to B");
  });

  it("R4 P-C — an explainer's unknowns reach the page", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "explainer", title: "How it works", content: { title: "How it works", overview: "o", sections: [{ heading: "1", body: "b" }], unknowns: ["I did not read cli/init.ts"] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("What the agent wasn't sure about");
    expect(html).toContain("I did not read cli/init.ts");
  });

  it("R4 P-A — a finding's concept reaches the page as a named pattern", () => {
    const state = baseState({
      artifacts: [artifact({ id: "a1", type: "research", title: "R", content: { summary: "s", findings: [{ category: "security", detail: "d", significance: "high", concept: { name: "parameterized queries", oneLineExplanation: "bind, don't concatenate" } }] } })],
    });
    const html = formatSessionHtml(state, OPTS);
    expect(html).toContain("parameterized queries");
    expect(html).toContain("Pattern:");
  });
});
