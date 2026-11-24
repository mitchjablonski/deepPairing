/**
 * #714 gap 6 — how to write an HTML page that is reviewable by default.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for page-authoring guidance. The
 * standalone guide (`deeppairing guide`, cli/standalone-guide.ts) and the
 * present_page tool description (mcp/server.ts) render it from here; the
 * plugin SKILL (claude-plugin/skills/pairing-protocol/SKILL.md) mirrors it in
 * prose, and page-authoring.test.ts holds every surface to the constraints
 * below. The present-time lint (mcp/page-lint.ts) checks the same rules.
 *
 * Written in second person to the agent. Keep it short: agents skim it.
 */
import { PAGE_HTML_MAX_BYTES } from "@deeppairing/shared";

/** Marks a callout that asks the human to decide something. */
export const PAGE_DECISION_ATTR = "data-dp-decision";
/** Marks a callout that asks the human a question. */
export const PAGE_QUESTION_ATTR = "data-dp-question";

const PAGE_CAP_MIB = PAGE_HTML_MAX_BYTES / (1024 * 1024);

/** The structure that makes a page skimmable and its comments durable. */
export const PAGE_STRUCTURE_RULES = [
  "Open with a TL;DR block: two or three sentences on what the page proposes and what you want from your pair.",
  "Put each part in <section id=\"...\"> with one <h2>. Stable ids keep comment anchors working across revisions.",
  `Mark each thing your pair must decide with ${PAGE_DECISION_ATTR} and each question with ${PAGE_QUESTION_ATTR}, and give both an id.`,
  "Give other key elements (tables, rows, diagrams) stable ids too.",
  "Use a table for any comparison.",
  "Draw diagrams as inline SVG, or paste pre-rendered SVG. Mermaid source is not rendered for you.",
] as const;

/** What the sandbox does to a page. */
export const PAGE_CONSTRAINT_RULES = [
  "No network. Scripts, stylesheets, fonts and images from a URL (CDNs included) are blocked. Inline styles and scripts as <style>/<script>, and images and fonts as data: URIs. Video, audio, iframes and objects won't load at all.",
  "Scripts run only after your pair clicks Run, so the page must read completely without JavaScript.",
  `Stay under the ${PAGE_CAP_MIB} MiB cap.`,
  "Put depth in <details> so the top level stays skimmable.",
] as const;

/** A minimal reviewable page. Indented with spaces; no external assets. */
export const PAGE_SKELETON_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Profile cache</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 50rem; margin: 2rem auto; padding: 0 1rem; }
  #tldr, [${PAGE_DECISION_ATTR}], [${PAGE_QUESTION_ATTR}] { border-left: 4px solid #888; padding: 0.5rem 1rem; }
</style>
</head>
<body>
<header id="tldr">
  <h1>Profile cache</h1>
  <p><strong>TL;DR:</strong> Put Redis in front of the profile service. Reads drop from 400ms to about 15ms.</p>
</header>
<section id="options">
  <h2>Options</h2>
  <table id="options-table">
    <tr><th>Option</th><th>Read latency</th><th>New infrastructure</th></tr>
    <tr id="opt-redis"><td>Redis</td><td>about 15ms</td><td>yes</td></tr>
    <tr id="opt-lru"><td>In-process LRU</td><td>about 2ms</td><td>no</td></tr>
  </table>
</section>
<section id="design">
  <h2>Design</h2>
  <svg id="flow" viewBox="0 0 260 40" role="img" aria-label="API reads Redis, Redis falls back to the profile service">
    <rect x="1" y="5" width="60" height="30" fill="none" stroke="currentColor"/><text x="31" y="25" text-anchor="middle">API</text>
    <rect x="100" y="5" width="60" height="30" fill="none" stroke="currentColor"/><text x="130" y="25" text-anchor="middle">Redis</text>
    <rect x="199" y="5" width="60" height="30" fill="none" stroke="currentColor"/><text x="229" y="25" text-anchor="middle">Profile</text>
  </svg>
  <details id="eviction"><summary>Eviction details</summary><p>LRU eviction, 1 GB limit.</p></details>
</section>
<section id="asks">
  <h2>What I need from you</h2>
  <p id="decide-ttl" ${PAGE_DECISION_ATTR}><strong>Decide:</strong> a 60s TTL, or invalidate on every write?</p>
  <p id="ask-budget" ${PAGE_QUESTION_ATTR}><strong>Question:</strong> is one more Redis instance in budget?</p>
</section>
</body>
</html>`;

/**
 * The page-authoring block for the standalone guide. Plain text, indented to
 * sit under a numbered guide section.
 */
export function renderPageAuthoringGuide(): string {
  const bullets = (rules: readonly string[]) => rules.map((r) => wrap(`- ${r}`, 76, "  ", "    ")).join("\n");
  return `  Structure, so your pair can skim it and comments stay anchored:
${bullets(PAGE_STRUCTURE_RULES)}
  Constraints, because the page renders in a locked-down frame:
${bullets(PAGE_CONSTRAINT_RULES)}
  Present and revise-page return non-blocking "warnings" for external assets,
  a page with no headings, and a long page with no section ids. Fix them in
  the next version. Warnings never refuse a page. A watched file save is
  recorded in the background, so it returns no warnings.
  Minimal skeleton:
${PAGE_SKELETON_HTML.split("\n").map((line) => `    ${line}`).join("\n")}`;
}

/**
 * The same guidance, compressed for the present_page tool description (tool
 * descriptions are paid for on every turn, so this stays one paragraph).
 */
export const PAGE_AUTHORING_TOOL_NOTE =
  "Rendering: the companion shows the page full-width in a sandboxed frame at an opaque origin with NO network (no fetch, no external scripts, stylesheets, fonts or images; inline styles and scripts, and images and fonts as data: URIs; video, audio, iframes and objects won't load). Its scripts run only when your pair clicks Run, so the page must read well without them. " +
  `Make it skimmable: a TL;DR block first, then <section id="..."> with an <h2> each, tables for comparisons, inline SVG diagrams (Mermaid source is not rendered), <details> for depth, stable ids on key elements, and each ask in an element marked ${PAGE_DECISION_ATTR} or ${PAGE_QUESTION_ATTR}. ` +
  "The result (and a page revise_artifact's) lists non-blocking warnings (external assets, no headings, a long page without section ids); they never refuse the page.";

/** Greedy word wrap with a first-line and a continuation indent. */
function wrap(text: string, width: number, first: string, rest: string): string {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(" ")) {
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line);
      line = rest + word;
    } else {
      line += (empty ? "" : " ") + word;
    }
    empty = false;
  }
  lines.push(line);
  return lines.join("\n");
}
