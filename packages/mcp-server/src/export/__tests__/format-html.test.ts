/**
 * Q5 — the shareable session page.
 *
 * The properties that make this format worth sending to a stranger are the
 * ones under test: it is SELF-CONTAINED (no external request can leak the
 * reader's IP or break the page offline), it is HONEST (rejected/superseded
 * work is marked, never silently shipped or dropped; no gate event is
 * invented), the discussion is anchored where it happened, and it survives a
 * big session (long diffs collapse, snippets truncate with an explicit marker).
 */
import { describe, it, expect } from "vitest";
import type { Artifact, Comment } from "@deeppairing/shared";
import { formatSessionHtml, renderMarkdown, sanitizePath, type HtmlSessionState } from "../format-html.js";

const T = (n: number) => `2026-08-1${n < 10 ? "0" : ""}T0${Math.min(n, 9)}:00:00.000Z`;

function artifact(over: Partial<Artifact> & Pick<Artifact, "id" | "type" | "title" | "content">): Artifact {
  const a = {
    sessionId: "s_share",
    version: 1,
    parentId: null,
    status: "approved",
    agentReasoning: null,
    createdAt: T(1),
    ...over,
  } as Artifact;
  // Absent an explicit updatedAt, an artifact was never transitioned after
  // creation — buildTimeline keys its status beat off the difference.
  if (!over.updatedAt) a.updatedAt = a.createdAt;
  return a;
}

function comment(over: Partial<Comment> & Pick<Comment, "id" | "content"> & { target: any }): Comment {
  return {
    sessionId: "s_share",
    author: "human",
    intent: "comment",
    createdAt: T(2),
    acknowledged: false,
    ...over,
  } as Comment;
}

/** A long unified diff — long enough to trip the <details> collapse. */
function longHunkLines(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: i % 3 === 0 ? "add" : i % 3 === 1 ? "del" : "ctx",
    content: `line ${i} of the long diff`,
    newLine: i + 1,
    oldLine: i + 1,
  }));
}

/** The rich fixture: every artifact type, comments anchored several ways, a
 *  rejection with a recorded reason, and a superseded v1 → v2 chain. */
function richState(): HtmlSessionState {
  const artifacts: Artifact[] = [
    artifact({
      id: "art_research",
      type: "research",
      title: "Auth audit",
      createdAt: T(1),
      content: {
        summary: "Three things stood out in the auth path.",
        findings: [
          {
            category: "Security",
            title: "Weak hashing",
            detail: "bcrypt at 10 rounds is under budget.",
            significance: "high",
            severity: "high",
            impact: "Offline cracking is cheap.",
            recommendation: "Move to argon2id.",
            evidence: [
              {
                filePath: "/home/tester/checkout/src/auth/hash.ts",
                lineStart: 12,
                lineEnd: 14,
                language: "ts",
                snippet: "const rounds = 10;\nexport const hash = (p: string) => bcrypt.hash(p, rounds);",
                explanation: "The cost factor is a constant.",
              },
            ],
          },
        ],
        openQuestions: ["Do we need a migration window?"],
      },
    }),
    artifact({
      id: "art_spec",
      type: "spec",
      title: "Password storage spec",
      createdAt: T(2),
      content: {
        objective: "Store passwords so a dump is worthless.",
        requirements: [
          { id: "REQ-1", statement: "Use argon2id", rationale: "Memory-hard", acceptanceCriteria: ["Verified in tests"], priority: "must" },
        ],
      },
    }),
    artifact({
      id: "art_decision",
      type: "decision",
      title: "Which hashing scheme?",
      createdAt: T(3),
      content: {
        decisionId: "dec_1",
        context: "We must pick a scheme before the migration.",
        title: "Which hashing scheme?",
        options: [
          { id: "opt_bcrypt", title: "Stay on bcrypt", description: "Raise the cost factor", pros: ["No migration"], cons: ["Still GPU-friendly"], effort: "low", risk: "medium" },
          { id: "opt_argon", title: "Move to argon2id", description: "Memory-hard KDF", pros: ["Best in class"], cons: ["Migration needed"], effort: "medium", risk: "low", recommendation: true },
        ],
      },
    }),
    artifact({
      id: "art_plan_v1",
      type: "plan",
      title: "Migration plan",
      version: 1,
      status: "superseded",
      createdAt: T(4),
      updatedAt: T(5),
      content: { steps: [{ description: "Rehash on login", reasoning: "No downtime" }], estimatedChanges: 3 },
    }),
    artifact({
      id: "art_plan_v2",
      type: "plan",
      title: "Migration plan",
      version: 2,
      parentId: "art_plan_v1",
      createdAt: T(5),
      content: {
        steps: [{ description: "Rehash on login, behind a flag", reasoning: "Reversible", files: ["/home/tester/checkout/src/auth/login.ts"], status: "done" }],
        estimatedChanges: 4,
      },
    }),
    artifact({
      id: "art_changeset",
      type: "changeset",
      title: "argon2id rollout",
      createdAt: T(6),
      content: {
        summary: "Swap the KDF and rehash on login.",
        risks: ["touches auth"],
        files: [
          {
            path: "src/auth/hash.ts",
            changeType: "modified",
            hunks: [{ header: "@@ -10,4 +10,6 @@", lines: [
              { kind: "del", content: "const rounds = 10;", oldLine: 10 },
              { kind: "add", content: "const memoryCost = 19456;", newLine: 10 },
              { kind: "ctx", content: "export const hash = …", oldLine: 11, newLine: 11 },
            ] }],
          },
          {
            path: "src/auth/login.ts",
            changeType: "modified",
            hunks: [{ header: "@@ -1,60 +1,60 @@", lines: longHunkLines(60) }],
          },
        ],
        reviewState: { "src/auth/hash.ts": "reviewed" },
      },
    }),
    artifact({
      id: "art_rejected",
      type: "code_change",
      title: "In-memory session cache",
      status: "rejected",
      createdAt: T(7),
      content: {
        filePath: "src/auth/cache.ts",
        changeType: "create",
        before: "",
        after: "export const sessions = new Map<string, Session>();",
        reasoning: "Fastest way to hold sessions.",
      },
    }),
    artifact({
      id: "art_debrief",
      type: "debrief",
      title: "Debrief — argon2id",
      createdAt: T(8),
      content: {
        summary: "We moved password hashing to argon2id and rehash on login.",
        sections: [{ title: "The swap", body: "The KDF call is now argon2id with a memory cost." }],
        decisionsMade: [{ what: "Kept the bcrypt verifier", why: "Old hashes must still verify" }],
        needsYourEyes: [{ what: "The memory cost", why: "It has to fit the container limit" }],
      },
    }),
    artifact({
      id: "art_explainer",
      type: "explainer",
      title: "How login verifies a password",
      createdAt: T(9),
      content: {
        overview: "Login now takes two paths depending on the stored prefix.",
        sections: [{ heading: "The prefix check", body: "A `$2b$` prefix means a legacy bcrypt hash." }],
      },
    }),
    artifact({
      id: "art_reasoning",
      type: "reasoning",
      title: "Reasoning",
      createdAt: T(9),
      content: { action: "Chose argon2id defaults", reasoning: "OWASP's floor", confidence: "medium", concept: { name: "memory-hard KDF", oneLineExplanation: "Cracking costs RAM, not just cycles" } },
    }),
  ];

  const comments: Comment[] = [
    comment({
      id: "c_finding",
      content: "How long does the migration window need to be?",
      intent: "question",
      target: { artifactId: "art_research", findingIndex: 0 },
      createdAt: T(2),
    }),
    comment({
      id: "c_file",
      content: "Is 19456 KiB safe inside the 512 MB container?",
      target: { artifactId: "art_changeset", filePath: "src/auth/hash.ts", lineStart: 10 },
      createdAt: T(6),
    }),
    comment({
      id: "c_orphan",
      content: "General note that belongs to no surviving artifact.",
      target: { artifactId: "art_gone" },
      createdAt: T(9),
    }),
  ];

  return {
    sessionId: "s_share",
    artifacts,
    comments,
    decisions: [
      {
        decisionId: "dec_1",
        artifactId: "art_decision",
        context: "We must pick a scheme before the migration.",
        title: "Which hashing scheme?",
        options: [
          { id: "opt_bcrypt", title: "Stay on bcrypt" },
          { id: "opt_argon", title: "Move to argon2id" },
        ],
        response: { optionId: "opt_argon", reasoning: "I'd rather pay the migration once than explain a dump later." },
        createdAt: T(3),
        resolvedAt: T(4),
      },
    ],
    planReviews: [{ artifactId: "art_plan_v2", verdict: "approved", feedback: "Ship it behind the flag.", resolvedAt: T(6) }],
    sessionMemory: {
      rejectedApproaches: [
        {
          description: "In-memory session cache",
          reason: "It dies with the process and we run three replicas.",
          concept: "in-process state in a replicated service",
          rejectedAt: T(7),
          sourceArtifactId: "art_rejected",
        },
        { description: "Rolling our own KDF", reason: "Never write crypto" },
      ],
    },
    preflightTraces: [
      {
        at: T(8),
        artifactId: "art_blocked",
        toolName: "present_plan",
        decision: "blocked",
        consideredCount: 2,
        nearMisses: [],
        block: { source: "session", concept: "in-process state in a replicated service", reason: "It dies with the process and we run three replicas.", via: "concept" },
      },
      {
        at: T(9),
        artifactId: "art_debrief",
        toolName: "present_debrief",
        decision: "admitted",
        consideredCount: 2,
        nearMisses: [{ concept: "shared mutable cache", source: "session", coverage: 0.6 }],
      },
    ],
    guardrailFires: [
      { at: T(6), hook: "preflight", reason: "guardrail:migrations" },
      { at: "2019-01-01T00:00:00.000Z", hook: "preflight", reason: "guardrail:secrets" },
    ],
  };
}

const OPTS = { version: "0.1.34", generatedAt: "2026-08-19T12:00:00.000Z", projectName: "checkout", projectRoot: "/home/tester/checkout" };

describe("formatSessionHtml — self-containment", () => {
  it("makes no external request: no scripts, no stylesheet links, no remote src", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<iframe/i);
    // Every src= must be local/absent — there are none in this page.
    const srcs = [...html.matchAll(/\ssrc\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
    expect(srcs.filter((s) => /^https?:/i.test(s ?? ""))).toEqual([]);
  });

  it("the only http(s) URL on the page is the footer's <a> anchor", () => {
    const html = formatSessionHtml(richState(), OPTS);
    const hrefs = [...html.matchAll(/<(\w+)[^>]*\shref\s*=\s*"([^"]*)"/gi)];
    const remote = hrefs.filter(([, , url]) => /^https?:/i.test(url ?? ""));
    expect(remote.length).toBeGreaterThan(0);
    for (const [, tag, url] of remote) {
      expect(tag?.toLowerCase()).toBe("a");
      expect(url).toBe("https://github.com/mitchjablonski/deepPairing");
    }
  });

  it("carries the sharing header + footer stamp", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("Project: checkout");
    expect(html).toContain("s_share");
    expect(html).toContain("Exported 2026-08-19");
    expect(html).toContain("deepPairing v0.1.34");
    expect(html).toContain("Generated by deepPairing");
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('name="color-scheme"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("@media print");
  });
});

describe("formatSessionHtml — honesty", () => {
  it("marks rejected work with a struck header and the recorded reason", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("<s>In-memory session cache</s>");
    expect(html).toMatch(/rejected: the human declined this — “It dies with the process/);
    // …and never drops it silently.
    expect(html).toContain("In-memory session cache");
  });

  it("marks a superseded v1 without hiding it", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("superseded: a later version replaced this one.");
    expect(html).toContain("<s>Migration plan</s>");
    expect(html).toContain("v2");
  });

  it("renders the gate beats that are actually recorded — and nothing else", () => {
    const html = formatSessionHtml(richState(), OPTS);
    // A recorded stance (session memory, timestamped).
    expect(html).toContain("Rejected — and remembered: In-memory session cache");
    expect(html).toContain("From here on the agent is blocked from proposing this again.");
    // A persisted BLOCKED preflight trace.
    expect(html).toContain("The gate refused present_plan");
    // An admitted trace's near miss reads as advisory, not as a block.
    expect(html).toMatch(/weighed 2 recorded stances .*let it through/);
    // A guardrail hook ask inside the session window.
    expect(html).toContain("Guardrail ask");
    expect(html).toContain("<strong>migrations</strong>");
    // The 2019 fire is OUTSIDE this session — it must not be claimed.
    expect(html).not.toContain("secrets");
  });

  it("draws the gate marks as inline SVG, never emoji (a stranger's machine may have no emoji font)", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain('<span class="gate-mark"><svg');
    expect(html).not.toContain("⛔");
    expect(html).not.toContain("🛡");
  });

  it("puts untimestamped stances in their own section rather than inventing a time", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("Standing stances");
    expect(html).toContain("Rolling our own KDF");
  });

  it("invents no gate beats for a session that recorded none", () => {
    const bare: HtmlSessionState = { ...richState(), sessionMemory: undefined, preflightTraces: [], guardrailFires: [] };
    const html = formatSessionHtml(bare, OPTS);
    expect(html).not.toContain("Guardrail ask");
    expect(html).not.toContain("The gate refused");
    expect(html).not.toContain("Standing stances");
  });
});

describe("formatSessionHtml — the story", () => {
  it("renders a supplied narrative as markdown at the top", () => {
    const html = formatSessionHtml(richState(), {
      ...OPTS,
      narrative: "# Why we moved off bcrypt\n\nWe had a **cheap** hash and three replicas.\n\n- The dump risk was real\n- The migration is one-way\n\n> \"I'd rather pay once.\"\n",
      audience: "the backend team",
    });
    expect(html).toContain("Why we moved off bcrypt");
    expect(html).toContain("<strong>cheap</strong>");
    expect(html).toContain("<li>The dump risk was real</li>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("Written for the backend team.");
    expect(html).not.toContain("Auto-generated summary");
  });

  it("falls back to an honestly-labelled auto-summary when no narrative is supplied", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("Auto-generated summary — no narrative was written for this export.");
    // The fallback still tells the reader what happened.
    expect(html).toContain("Which hashing scheme?");
    expect(html).toContain("Move to argon2id");
    expect(html).toMatch(/The session runs from 2026-08-10 01:00 UTC to 2026-08-10 09:00 UTC/);
    expect(html).toMatch(/2 approaches were rejected and recorded/);
  });

  it("escapes markup in narrative, titles and comments", () => {
    const state = richState();
    state.artifacts[0]!.title = "<img src=x onerror=alert(1)>";
    const html = formatSessionHtml(state, { ...OPTS, narrative: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("formatSessionHtml — the timeline", () => {
  it("renders the beats in chronological order", () => {
    const html = formatSessionHtml(richState(), OPTS);
    const order = [
      'id="artifact-art_research"',
      'id="artifact-art_spec"',
      'id="artifact-art_decision"',
      "Decided: Move to argon2id",
      'id="artifact-art_changeset"',
      "Rejected — and remembered",
      'id="artifact-art_debrief"',
      'id="artifact-art_explainer"',
    ].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders findings with evidence, decision options with the chosen one marked, and the human's reason", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("Weak hashing");
    expect(html).toContain("src/auth/hash.ts:12-14");
    expect(html).toContain("const rounds = 10;");
    expect(html).toContain("Stay on bcrypt");
    expect(html).toContain("Move to argon2id");
    expect(html).toContain("chosen");
    expect(html).toContain("not taken");
    expect(html).toContain("I&#39;d rather pay the migration once");
    // The debrief's needs-your-eyes lane survives into the page.
    expect(html).toContain("Needs a human's eyes");
    expect(html).toContain("The memory cost");
  });

  it("anchors comment threads where they happened", () => {
    const html = formatSessionHtml(richState(), OPTS);
    // Anchored to a finding on the research card.
    expect(html).toContain("on finding #1");
    expect(html).toContain("How long does the migration window need to be?");
    // Anchored to a file inside the changeset — rendered under that file.
    const fileThread = html.indexOf("On this file");
    const hashFile = html.indexOf("src/auth/hash.ts</code>");
    expect(fileThread).toBeGreaterThan(hashFile);
    expect(html).toContain("Is 19456 KiB safe");
    // A comment whose artifact isn't in the session still appears (never dropped).
    expect(html).toContain("General note that belongs to no surviving artifact.");
  });

  it("relativizes absolute paths against the project root and the home directory", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).not.toContain("/home/tester/checkout");
    expect(html).toContain("src/auth/login.ts");
  });
});

describe("formatSessionHtml — size sanity", () => {
  it("collapses a long diff behind <details> and keeps a short one open", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toMatch(/<details><summary>Show the diff \(60 lines\)<\/summary>/);
    // The 3-line diff is not collapsed.
    const shortIdx = html.indexOf("const memoryCost = 19456;");
    const detailsIdx = html.indexOf("<details><summary>Show the diff");
    expect(shortIdx).toBeGreaterThan(0);
    expect(shortIdx).toBeLessThan(detailsIdx);
  });

  it("truncates an over-long snippet with an explicit marker", () => {
    const state = richState();
    (state.artifacts[0]!.content as any).findings[0].evidence[0].snippet =
      Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n");
    const html = formatSessionHtml(state, OPTS);
    expect(html).toMatch(/… truncated — 50 more lines not shown/);
  });
});

describe("formatSessionHtml — the redact option", () => {
  it("strips diff and snippet bodies but keeps the shape", () => {
    const html = formatSessionHtml(richState(), { ...OPTS, includeCode: false });
    expect(html).not.toContain("const memoryCost = 19456;");
    expect(html).not.toContain("const rounds = 10;");
    expect(html).not.toContain("export const sessions = new Map");
    expect(html).toContain("Diff omitted from this export.");
    expect(html).toContain("Code omitted from this export");
    expect(html).toContain("code omitted");
    // The record itself is intact: file names, findings, decisions.
    expect(html).toContain("src/auth/hash.ts");
    expect(html).toContain("Weak hashing");
    expect(html).toContain("Move to argon2id");
  });

  it("includes code by default", () => {
    const html = formatSessionHtml(richState(), OPTS);
    expect(html).toContain("const memoryCost = 19456;");
    expect(html).not.toContain("Diff omitted from this export.");
  });
});

describe("formatSessionHtml — degenerate input", () => {
  it("renders an empty session without throwing", () => {
    const html = formatSessionHtml(
      { sessionId: "s_empty", artifacts: [], comments: [], decisions: [], planReviews: [] },
      OPTS,
    );
    expect(html).toContain("Session s_empty");
    expect(html).toContain("Nothing was recorded in this session.");
    expect(html).toContain("Generated by deepPairing");
  });

  it("is deterministic for a fixed generatedAt", () => {
    const a = formatSessionHtml(richState(), OPTS);
    const b = formatSessionHtml(richState(), OPTS);
    expect(a).toBe(b);
  });
});

describe("renderMarkdown", () => {
  it("renders the subset an agent narrative uses", () => {
    const html = renderMarkdown("## Heading\n\nSome `code` and **bold**.\n\n1. first\n2. second\n\n```ts\nconst x = 1;\n```\n");
    expect(html).toContain("<h4>Heading</h4>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("const x = 1;");
  });

  it("drops unsafe link protocols but keeps the text", () => {
    const html = renderMarkdown("[click](javascript:alert(1)) and [docs](https://example.com/x)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
    expect(html).toContain('href="https://example.com/x"');
  });

  it("never emits raw markup from the source text", () => {
    expect(renderMarkdown("<b>hi</b>")).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });
});

describe("sanitizePath", () => {
  it("strips the project root", () => {
    expect(sanitizePath("/home/tester/checkout/src/a.ts", "/home/tester/checkout")).toBe("src/a.ts");
  });
  it("collapses a home directory it can't strip", () => {
    expect(sanitizePath("/home/someone/other/a.ts")).toBe("~/other/a.ts");
    expect(sanitizePath("/Users/someone/other/a.ts")).toBe("~/other/a.ts");
  });
  it("leaves a repo-relative path alone", () => {
    expect(sanitizePath("src/a.ts", "/home/tester/checkout")).toBe("src/a.ts");
  });
});
