/**
 * R3 — adversarial-review fixes (F1–F10). The privacy gate the first R3 pass
 * failed, plus the size/secret-count/link hardening. Each pin fails on the R3
 * code as it stood before this follow-up, with the exact measured input.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import {
  formatSessionHtml,
  renderMarkdown,
  sanitizePath,
  scrubProse,
  type HtmlSessionState,
} from "../format-html.js";
import {
  scanExportForSecrets,
  secretCountOf,
  secretLabelsOf,
  secretWarningHeader,
} from "../html-export.js";

const OPTS = {
  version: "0.1.35",
  generatedAt: "2026-08-21T12:00:00.000Z",
  projectName: "checkout",
  projectRoot: "/home/tester/checkout",
};

function baseState(over: Partial<HtmlSessionState> = {}): HtmlSessionState {
  return { sessionId: "session_checkout_ab12cd34", artifacts: [], comments: [], decisions: [], planReviews: [], ...over };
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

// ---------------------------------------------------------------------------
// F1 — the NO-narrative title scrubs machine paths
// ---------------------------------------------------------------------------
describe("R3/adv F1 — the fallback title scrubs machine paths", () => {
  // GET /api/export.html passes NO narrative, so on the Export-menu surface
  // sessionTitle always wins. Every earlier title test supplied a narrative,
  // which is why the leak hid. A decision context / spec title with an absolute
  // path must not land in the tab, bookmark, <h1> or print header.
  it("scrubs <title> and <h1> from a decision-context path when no narrative is given", () => {
    const st = baseState({
      artifacts: [artifact({ id: "d1", type: "decision", title: "Queue audit /home/victimuser/x.ts", content: { decisionId: "x", options: [] } })],
      decisions: [{ decisionId: "x", artifactId: "d1", context: "Queue audit /home/victimuser/x.ts", title: "Queue audit /home/victimuser/x.ts", options: [], createdAt: "2026-08-21T09:00:00.000Z" }],
    });
    const html = formatSessionHtml(st, OPTS);
    expect(html).not.toContain("/home/victimuser");
    expect(html).toContain("<title>Queue audit ~/x.ts — deepPairing session</title>");
    expect(html).toContain("<h1>Queue audit ~/x.ts</h1>");
  });

  it("scrubs a Windows home prefix out of the fallback title", () => {
    const st = baseState({ artifacts: [artifact({ id: "s1", type: "spec", title: "Spec C:\\Users\\victimuser\\proj\\x.ts", content: { objective: "o" } })] });
    const html = formatSessionHtml(st, OPTS);
    // The username is gone; the home prefix collapses to ~/ (the remainder of
    // the path is prose, not further rewritten — scrubProse is not sanitizePath).
    expect(html).not.toContain("victimuser");
    expect(html).toContain("~/proj");
  });
});

// ---------------------------------------------------------------------------
// F2 — Windows / UNC shapes, both directions
// ---------------------------------------------------------------------------
describe("R3/adv F2 — Windows/UNC path shapes are scrubbed, both directions", () => {
  const field: ReadonlyArray<readonly [string, string]> = [
    ["C:\\Users\\victimuser\\x.ts", "~/x.ts"],
    ["C:/Users/victimuser/x.ts", "~/x.ts"],
    ["\\\\fileserver\\share\\Users\\victimuser\\x.ts", "~/x.ts"],
    ["\\\\wsl$\\Ubuntu\\home\\victimuser\\x.ts", "~/x.ts"],
    ["/mnt/c/Users/victimuser/x.ts", "~/x.ts"],
    ["/cygdrive/c/Users/victimuser/x.ts", "~/x.ts"],
    // deliberately preserved
    ["/opt/build/home/user/x.ts", "/opt/build/home/user/x.ts"],
    ["app/views/home/partials/index.erb", "app/views/home/partials/index.erb"],
    ["src/Users/profile.ts", "src/Users/profile.ts"],
  ];
  for (const [input, want] of field) {
    it(`sanitizePath: ${JSON.stringify(input)}`, () => {
      expect(sanitizePath(input)).toBe(want);
      expect(sanitizePath(input)).not.toMatch(/victimuser|fileserver/);
    });
  }

  const prose: ReadonlyArray<readonly [string, string]> = [
    ["win C:\\Users\\victimuser\\x.ts end", "win ~/x.ts end"],
    ["unc \\\\fileserver\\share\\Users\\victimuser\\x.ts end", "unc ~/x.ts end"],
    ["wsl \\\\wsl$\\Ubuntu\\home\\victimuser\\x.ts end", "wsl ~/x.ts end"],
    ["mount /mnt/c/Users/victimuser/x.ts end", "mount ~/x.ts end"],
    ["nix /home/victimuser/work/x.ts end", "nix ~/work/x.ts end"],
    // preserved
    ["url https://x.com/home/y/z ok", "url https://x.com/home/y/z ok"],
    ["proto //cdn.com/home/x/y ok", "proto //cdn.com/home/x/y ok"],
    ["rel app/views/home/partials/index.erb ok", "rel app/views/home/partials/index.erb ok"],
    ["deep /opt/build/home/user/x.ts ok", "deep /opt/build/home/user/x.ts ok"],
  ];
  for (const [input, want] of prose) {
    it(`scrubProse: ${JSON.stringify(input)}`, () => {
      expect(scrubProse(input, undefined)).toBe(want);
    });
  }

  // T1 (round-15) — the banked S4 LOW: a bare drive-rooted absolute with NO
  // home/Users segment used to post its drive identity + private layout verbatim
  // to a stranger's PR / into the share page. scrubProse now collapses the drive
  // (or mount) ROOT designator to ~/, keeping the repo-relative-looking tail, and
  // leaves legit relative paths + standard POSIX system paths untouched.
  const driveLeaks: ReadonlyArray<readonly [string, string]> = [
    ["see D:\\projects\\secret\\x.ts end", "see ~/projects\\secret\\x.ts end"],
    ["win C:/work/checkout/src/a.ts here", "win ~/work/checkout/src/a.ts here"],
    ["mount /mnt/d/build/x.ts here", "mount ~/build/x.ts here"],
    ["cyg /cygdrive/e/data/y.ts here", "cyg ~/data/y.ts here"],
    // still handled by the home pass (drive + Users) — no regression
    ["home C:\\Users\\victimuser\\x.ts end", "home ~/x.ts end"],
  ];
  for (const [input, want] of driveLeaks) {
    it(`scrubProse (drive-root collapsed): ${JSON.stringify(input)}`, () => {
      expect(scrubProse(input, undefined)).toBe(want);
      // the drive/mount designator is gone
      expect(scrubProse(input, undefined)).not.toMatch(/[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|\/cygdrive\//i);
    });
  }

  // T1 review F1 — a bare UNC authority (no home segment) leaked the internal
  // hostname + share layout. The host+share root collapses; a legit protocol-
  // relative URL is left alone.
  const uncLeaks: ReadonlyArray<readonly [string, string]> = [
    ["see \\\\srv\\share\\proj\\x.ts end", "see ~/proj\\x.ts end"],
    ["wsl \\\\wsl$\\Ubuntu\\proj\\x.ts end", "wsl ~/proj\\x.ts end"],
    ["fwd //wsl$/Ubuntu/proj/x.ts end", "fwd ~/proj/x.ts end"],
    // UNC + home still handled by the home pass (username gone) — no regression
    ["home \\\\srv\\share\\Users\\bob\\x.ts end", "home ~/x.ts end"],
  ];
  for (const [input, want] of uncLeaks) {
    it(`scrubProse (UNC-root collapsed): ${JSON.stringify(input)}`, () => {
      expect(scrubProse(input, undefined)).toBe(want);
      expect(scrubProse(input, undefined)).not.toMatch(/srv|fileserver/);
    });
  }

  // over-scrub protection — legit relative paths + standard POSIX system paths
  // + protocol-relative URLs + colon-bearing prose are returned byte-identical.
  const drivePreserved: readonly string[] = [
    "rel app/home/x untouched",
    "sys /usr/lib/node/x.ts untouched",
    "sys /opt/build/y.ts untouched",
    "url visit http://x.com/mnt/c/foo ok",
    "proto //cdn.com/home/x/y ok",
    "cdn //cdn.com/assets/app.js ok",
    "time ratio 3:30 done",
    "clock at 12:00 later",
    "plain src/auth/hash.ts kept",
  ];
  for (const input of drivePreserved) {
    it(`scrubProse (drive/UNC-root preserved): ${JSON.stringify(input)}`, () => {
      expect(scrubProse(input, undefined)).toBe(input);
    });
  }

  it("the UNC hostname never survives into a rendered narrative", () => {
    const html = formatSessionHtml(baseState(), {
      ...OPTS,
      projectRoot: undefined,
      narrative: "traced through \\\\fileserver\\share\\Users\\victimuser\\src\\a.ts today",
    });
    expect(html).not.toContain("fileserver");
    expect(html).not.toContain("victimuser");
  });
});

// ---------------------------------------------------------------------------
// F3 — one long line can't blow the page, and the page never lies
// ---------------------------------------------------------------------------
describe("R3/adv F3 — a single long line is clipped, honestly", () => {
  it("clips a single 20 MB diff line instead of shipping it, and says so", () => {
    const bigline = "x".repeat(20 * 1024 * 1024);
    const st = baseState({
      artifacts: [artifact({ id: "c1", type: "changeset", title: "min.js", content: { files: [{ path: "a.min.js", changeType: "modified", hunks: [{ lines: [{ kind: "add", content: bigline, newLine: 1 }] }] }] } })],
    });
    const started = Date.now();
    const html = formatSessionHtml(st, OPTS);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(Buffer.byteLength(html, "utf-8")).toBeLessThan(1024 * 1024);
    expect(html.toLowerCase()).toContain("truncated for size");
    expect(html).not.toContain(bigline);
  });

  it("clips a single 20 MB code snippet the same way", () => {
    const st = baseState({
      artifacts: [artifact({ id: "r1", type: "research", title: "Audit", content: { findings: [{ category: "x", detail: "d", significance: "high", evidence: [{ filePath: "big.ts", snippet: "y".repeat(20 * 1024 * 1024) }] }] } })],
    });
    const html = formatSessionHtml(st, OPTS);
    expect(Buffer.byteLength(html, "utf-8")).toBeLessThan(1024 * 1024);
    expect(html.toLowerCase()).toContain("truncated for size");
  });
});

// ---------------------------------------------------------------------------
// F4 — the secret count is every occurrence; each is findable
// ---------------------------------------------------------------------------
describe("R3/adv F4 — 40 leaks report as 40, each field findable", () => {
  function fortyKeys(): HtmlSessionState {
    const artifacts: Artifact[] = [];
    for (let i = 0; i < 40; i++) {
      artifacts.push(artifact({
        id: `a${i}`, type: "research", title: `finding ${i}`,
        content: { findings: [{ category: "x", detail: "d", significance: "high", evidence: [{ filePath: "f.ts", snippet: `const k = "AKIA${String(i).padStart(4, "0")}ABCDEFGHIJ";` }] }] },
      }));
    }
    return baseState({ artifacts });
  }

  it("counts 40, lists the label once, names each artifact by index + title", () => {
    const matches = scanExportForSecrets(fortyKeys());
    expect(secretCountOf(matches)).toBe(40);
    expect(secretLabelsOf(matches)).toEqual(["AWS access key id"]);
    expect(matches[0].field).toBe('research #1 "finding 0".findings[0].evidence[0].snippet');
    expect(matches[39].field).toBe('research #40 "finding 39".findings[0].evidence[0].snippet');
    expect(secretWarningHeader(matches) ?? "").toContain("40 matches found");
  });

  it("the banner headline uses the occurrence count, not the deduped label count", () => {
    const matches = scanExportForSecrets(fortyKeys());
    const html = formatSessionHtml(fortyKeys(), { ...OPTS, secretLabels: secretLabelsOf(matches), secretCount: secretCountOf(matches) });
    expect(html).toContain("40 credential-shaped values");
    expect(html).not.toContain("1 credential-shaped value ");
  });
});

// ---------------------------------------------------------------------------
// F5 — the link scan can't be made quadratic by an adjacent shape
// ---------------------------------------------------------------------------
describe("R3/adv F5 — '[](' * 400k renders in well under 100ms", () => {
  it("bails on the missing closing paren rather than re-scanning the tail", () => {
    const started = Date.now();
    renderMarkdown("[](".repeat(400_000));
    expect(Date.now() - started).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// F6 — the redacted banner doesn't point at what isn't on the page
// ---------------------------------------------------------------------------
describe("R3/adv F6 — includeCode:false reconciles the banner wording", () => {
  const leaky = (): HtmlSessionState =>
    baseState({ artifacts: [artifact({ id: "a1", type: "research", title: "Audit", content: { findings: [{ category: "x", detail: "d", significance: "high", evidence: [{ filePath: "a.ts", snippet: 'const k = "AKIAIOSFODNN7EXAMPLE";' }] }] } })] });

  it("says code was omitted rather than 'search the page' when code is redacted", () => {
    const redacted = formatSessionHtml(leaky(), { ...OPTS, includeCode: false, secretLabels: ["AWS access key id"], secretCount: 1 });
    expect(redacted).toContain("Code bodies were omitted from this page");
    expect(redacted).not.toContain("search the page for them");
  });
  it("still says 'search the page' when code is included", () => {
    const withCode = formatSessionHtml(leaky(), { ...OPTS, includeCode: true, secretLabels: ["AWS access key id"], secretCount: 1 });
    expect(withCode).toContain("search the page for them");
  });
});

// ---------------------------------------------------------------------------
// F10 — the render fallback can't itself throw, and leaves a tell
// ---------------------------------------------------------------------------
describe("R3/adv F10 — the render fallback is guarded", () => {
  it("renders ordinary prose without the error tell, and always returns a string", () => {
    expect(typeof renderMarkdown("normal paragraph")).toBe("string");
    expect(renderMarkdown("normal paragraph")).not.toContain("data-render-error");
  });
});
