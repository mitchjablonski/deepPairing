import type { Artifact, Comment, SessionAnnotation } from "@deeppairing/shared";
import { isNeverApprovedStatus, isNotShippedStatus } from "@deeppairing/shared";
import { buildTimeline } from "../replay/timeline.js";
import type { DecisionRecord, PlanReviewRecord } from "../store/store-interface.js";
import {
  normalizeConceptKey,
  coercePlanContent,
  coerceResearchContent,
  coerceReasoningContent,
  coerceDebriefContent,
  coerceExplainerContent,
  coerceSpecContent,
  coerceChangesetContent,
  isPostableFinding,
} from "@deeppairing/shared";

interface SessionState {
  sessionId: string;
  artifacts: Artifact[];
  comments: Comment[];
  decisions: Array<{
    decisionId: string;
    artifactId: string;
    context: string;
    /** M1.1 — optional short fork-naming title (preferred for headings). */
    title?: string;
    options: any[];
    response?: { optionId: string; reasoning?: string };
    createdAt: string;
    resolvedAt?: string;
  }>;
  planReviews: Array<{
    artifactId: string;
    verdict?: string;
    feedback?: string;
    createdAt?: string;
    resolvedAt?: string;
  }>;
  /** Optional — attached by callers who want annotations in the replay export. */
  annotations?: SessionAnnotation[];
}

type ExportFormat = "full" | "pr-description" | "adr" | "replay" | "pr-comments" | "learnings";

export function formatSessionMarkdown(
  state: SessionState,
  format: ExportFormat = "full",
): string {
  switch (format) {
    case "pr-description":
      return formatPrDescription(state);
    case "adr":
      return formatAdr(state);
    case "replay":
      return formatReplay(state);
    case "pr-comments":
      return formatPrComments(state);
    case "learnings":
      return formatLearnings(state);
    case "full":
    default:
      return formatFull(state);
  }
}

// --- F2 (#196) — export honesty helpers ---
//
// H1: rejected/retracted artifacts must not read as shipped. The EXTERNAL
// formats (pr-description, adr) describe what SHIPPED, so they drop such
// artifacts entirely (a teammate reading the PR would otherwise see the exact
// opposite of what happened — the demo's REJECTED ConfigStore singleton
// appearing under "Key Findings"). The FULL export is the faithful record, so
// it KEEPS them but prepends an explicit "Rejected (not built)" marker.
//
// `superseded` was already filtered everywhere (an older version replaced by a
// newer one); we fold rejected + retracted into the same "not shipped" bucket
// for the external formats.

/**
 * True when the artifact represents work that actually shipped (for the
 * external pr-description / adr formats).
 *
 * R3 — this was a hand-copy that OMITTED `obsolete`, while format-html's copy
 * of the same predicate four files away had it. So work the discussion had
 * overtaken — a valid plan the pair moved past — went into a PR description and
 * an ADR reading exactly like work that landed, on the two formats that leave
 * the building. One predicate now, in @deeppairing/shared, imported by both
 * exporters; see isNotShippedStatus for why it is a different question from
 * isClosedArtifactStatus (which counts `approved` as closed).
 */
function isShippedArtifact(a: Artifact): boolean {
  return !isNotShippedStatus(a.status);
}

/**
 * R3 (adversarial F8) — the inline "not approved" marker for pr-description /
 * adr. isShippedArtifact lets a `draft`/`reviewing`/`revised` artifact through
 * (it isn't rejected, just not signed off), so a draft plan landed in a PR
 * description reading exactly like approved work. These formats describe what
 * shipped; an un-approved artifact is marked here rather than silently
 * presented as consensus. Returns "" for approved/shipped work (byte-identical
 * output for a clean run).
 */
function unapprovedMdMarker(a: Artifact): string {
  if (!isNeverApprovedStatus(a.status)) return "";
  const which =
    a.status === "revised" ? "sent back for changes"
    : a.status === "reviewing" ? "still under review"
    : "still a draft";
  return ` _(not approved — ${which})_`;
}

/** The blockquote marker the FULL export prepends to a rejected/retracted
 *  artifact so the complete record keeps it without ever reading as shipped.
 *  Returns null for everything else (byte-identical output for a clean run). */
function rejectionNote(a: Artifact): string | null {
  if (a.status !== "rejected" && a.status !== "retracted") return null;
  const verb = a.status === "rejected" ? "rejected" : "retracted";
  return `> ⚠️ **Rejected (not built)** — this was proposed then ${verb} during review; kept here for the full record, not part of what shipped.\n`;
}

// F2 (Fix 3, review #232) — the "## Decision(s)" blocks render from
// state.decisions, which the H1 artifact filters don't touch, so a decision
// whose OWNING artifact was later rejected/retracted still read as shipped.
// Gate it via the EXACT decision.artifactId → artifact.id link — no heuristic.
// KNOWN GAP (documented, deferred): a decision record whose artifactId has no
// matching artifact in state (decisions can be logged without a resolvable
// artifact) is NOT gated — we can't prove its status, and inventing a linkage
// is worse than the residual. In practice present_options records both, so the
// common path is covered.
function decisionOwningArtifact(state: SessionState, d: { artifactId?: string }): Artifact | undefined {
  if (!d.artifactId) return undefined;
  return state.artifacts.find((a) => a.id === d.artifactId);
}

function decisionIsRejected(state: SessionState, d: { artifactId?: string }): boolean {
  const a = decisionOwningArtifact(state, d);
  return !!a && (a.status === "rejected" || a.status === "retracted");
}

// M1: neutralize pair-voice for the EXTERNAL formats. The debrief/decision
// narrative is written in second-person pair-voice ("You rejected X, so I
// pivoted…") which is right for the human you paired with but wrong for a
// teammate reading a PR or an ADR. This is a light, MECHANICAL transform:
// whole-word pronoun swaps (I → the agent, you → the reviewer, we → the pair)
// plus a sentence-start re-capitalization pass. It is deliberately NOT a
// full rewrite — it can't turn "You rejected X, so I pivoted" into perfect
// passive prose, but it removes every second-person address, which is the
// defect. Full/replay/learnings KEEP the pair voice (the faithful record;
// feedback_artifact_voice applies to those pair-facing surfaces).
//
// Hardening (review #232): contractions are EXPANDED, not glued onto a noun
// phrase ("you'll" → "the reviewer will", never "the reviewer'll"); CODE
// segments (inline `spans` and ```fenced``` blocks) are left byte-for-byte
// intact so an identifier like `you.method()` is never rewritten; and the
// standalone-I rule excludes slash-adjacency so "I/O" survives.
const VOICE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // --- you (contractions first, then possessive, then bare) ---
  [/\byou['’]re\b/gi, "the reviewer is"],
  [/\byou['’]ll\b/gi, "the reviewer will"],
  [/\byou['’]ve\b/gi, "the reviewer has"],
  [/\byou['’]d\b/gi, "the reviewer would"],
  [/\byour\b/gi, "the reviewer's"],
  [/\byou\b/gi, "the reviewer"],
  // --- we ---
  [/\bwe['’]re\b/gi, "the pair is"],
  [/\bwe['’]ll\b/gi, "the pair will"],
  [/\bwe['’]ve\b/gi, "the pair has"],
  [/\bwe['’]d\b/gi, "the pair would"],
  [/\bour\b/gi, "the pair's"],
  [/\bwe\b/gi, "the pair"],
  // --- I (capital only; the standalone rule excludes \w AND / so "I/O",
  //     "I18n" etc. never match) ---
  [/\bI['’]ve\b/g, "the agent has"],
  [/\bI['’]m\b/g, "the agent is"],
  [/\bI['’]ll\b/g, "the agent will"],
  [/\bI['’]d\b/g, "the agent would"],
  [/(?<![\w/])I(?![\w/])/g, "the agent"],
  [/\bmy\b/gi, "the agent's"],
];

/** Fenced ```blocks``` (matched first, non-greedy) and inline `code spans`. */
const CODE_SEGMENT = /```[\s\S]*?```|`[^`]*`/g;

function transformProse(seg: string, atTextStart: boolean): string {
  let out = seg;
  for (const [re, rep] of VOICE_RULES) out = out.replace(re, rep);
  // Re-capitalize sentence starts the lowercase replacements can break. The
  // string-start (`^`) branch applies ONLY to the first prose segment — a
  // segment that begins right after an inline code span is mid-sentence, so
  // forcing a capital on the word after the code would be wrong.
  const boundary = atTextStart
    ? /(^|[.!?]\s+|\n\s*)([a-z])/g
    : /([.!?]\s+|\n\s*)([a-z])/g;
  return out.replace(boundary, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
}

// Exported for the hostile-repro unit tests (review #232) — the transform is
// small but its edge cases are exactly what need pinning.
export function neutralizeVoice(text: string | undefined | null): string {
  if (!text) return text ?? "";
  let result = "";
  let lastIndex = 0;
  let atTextStart = true;
  for (const m of text.matchAll(CODE_SEGMENT)) {
    const idx = m.index ?? 0;
    const prose = text.slice(lastIndex, idx);
    if (prose) {
      result += transformProse(prose, atTextStart);
      atTextStart = false;
    }
    result += m[0]; // code verbatim — never transformed
    atTextStart = false;
    lastIndex = idx + m[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail) result += transformProse(tail, atTextStart);
  return result;
}

// --- PR Description ---

function formatPrDescription(state: SessionState): string {
  const sections: string[] = [];

  sections.push("## Summary\n");

  // #192 — the debrief summary IS the human-readable "what this PR does" the
  // description wants. Lead the Summary with it (narrative + what needs the
  // reviewer's eyes) when a debrief exists; ADR deliberately omits this (see
  // the format-markdown test) because an ADR is a decision record, not a change
  // narrative, and the decision/context blocks already carry its substance.
  // F2 (H1) — a rejected/retracted debrief must not lead a PR description; F2
  // (M1) — the surviving narrative is neutralized out of pair-voice for the
  // teammate reading it.
  const debriefs = state.artifacts.filter((a) => a.type === "debrief" && isShippedArtifact(a));
  for (const d of debriefs) {
    const content = coerceDebriefContent(d.content);
    if (content.summary) sections.push(`${neutralizeVoice(content.summary)}\n`);
    if (content.needsYourEyes?.length) {
      sections.push("**What needs review:**");
      for (const n of content.needsYourEyes) sections.push(`- ${neutralizeVoice(n.what)} — ${neutralizeVoice(n.why)}`);
      sections.push("");
    }
  }

  // Decisions made (Fix 3 — drop any whose owning artifact was rejected/retracted).
  const resolved = state.decisions.filter((d) => d.response && !decisionIsRejected(state, d));
  if (resolved.length > 0) {
    sections.push("### Decisions\n");
    for (const d of resolved) {
      const option = d.options.find((o: any) => o.id === d.response?.optionId);
      // M1.1 — prefer the short fork title; fall back to context (pre-M1).
      sections.push(`- **${d.title?.trim() || d.context}**: ${option?.title ?? d.response?.optionId}`);
      if (d.response?.reasoning) {
        sections.push(`  - *Reasoning*: ${d.response.reasoning}`);
      }
    }
    sections.push("");
  }

  // Plan steps
  const plans = state.artifacts.filter((a) => a.type === "plan" && isShippedArtifact(a));
  for (const plan of plans) {
    const steps = coercePlanContent(plan.content).steps;
    if (steps.length > 0) {
      sections.push(`### Changes (${plan.title})${unapprovedMdMarker(plan)}\n`);
      for (const step of steps) {
        const files = Array.isArray(step.files)
          ? step.files.map((f: any) => typeof f === "string" ? f : f.filePath).join(", ")
          : "";
        sections.push(`- ${step.description}${files ? ` (${files})` : ""}`);
      }
      sections.push("");
    }
  }

  // Key findings
  const research = state.artifacts.filter((a) => a.type === "research" && isShippedArtifact(a));
  if (research.length > 0) {
    const findings = research.flatMap((r) => coerceResearchContent(r.content).findings);
    const highFindings = findings.filter((f: any) => f.significance === "high");
    if (highFindings.length > 0) {
      sections.push("### Key Findings\n");
      for (const f of highFindings) {
        sections.push(`- **${f.title ?? f.category}**: ${f.detail}`);
      }
      sections.push("");
    }
  }

  sections.push("\n---\n*Generated by [deepPairing](https://github.com/deeppairing)*");

  return sections.join("\n");
}

// --- Architecture Decision Record ---

function formatAdr(state: SessionState): string {
  const sections: string[] = [];
  const date = new Date().toISOString().split("T")[0];

  sections.push(`# ADR: ${getSessionTitle(state)}\n`);
  sections.push(`**Date**: ${date}`);
  sections.push(`**Status**: Accepted\n`);

  // Context — from findings
  // F2 (H1) — an ADR records what was DECIDED and shipped; rejected/retracted
  // research is not context, it's a discarded proposal. F2 (M1) — the surviving
  // narrative is neutralized out of pair-voice for an external reader.
  const research = state.artifacts.filter((a) => a.type === "research" && isShippedArtifact(a));
  if (research.length > 0) {
    sections.push("## Context\n");
    for (const r of research) {
      const content = coerceResearchContent(r.content);
      if (content.summary) sections.push(neutralizeVoice(content.summary) + "\n");
      for (const f of content.findings ?? []) {
        sections.push(`### ${f.title ?? f.category}\n`);
        sections.push(neutralizeVoice(f.detail));
        if (f.impact) sections.push(`\n**Impact**: ${neutralizeVoice(f.impact)}`);
        sections.push("");
      }
    }
  }

  // Decision — from resolved decisions (Fix 3 — exclude rejected/retracted).
  const resolved = state.decisions.filter((d) => d.response && !decisionIsRejected(state, d));
  if (resolved.length > 0) {
    sections.push("## Decision\n");
    for (const d of resolved) {
      const chosen = d.options.find((o: any) => o.id === d.response?.optionId);
      const rejected = d.options.filter((o: any) => o.id !== d.response?.optionId);

      sections.push(`**${d.context}**\n`);
      sections.push(`Chosen: **${chosen?.title}** — ${chosen?.description ?? ""}`);
      if (d.response?.reasoning) {
        sections.push(`\nReasoning: ${neutralizeVoice(d.response.reasoning)}`);
      }
      if (rejected.length > 0) {
        sections.push("\nRejected alternatives:");
        for (const r of rejected) {
          sections.push(`- ${r.title}: ${r.description ?? ""}`);
        }
      }
      sections.push("");
    }
  }

  // Consequences — from plan
  const plans = state.artifacts.filter((a) => a.type === "plan" && isShippedArtifact(a));
  if (plans.length > 0) {
    sections.push("## Consequences\n");
    for (const plan of plans) {
      for (const step of coercePlanContent(plan.content).steps) {
        sections.push(`- ${step.description}: ${step.reasoning}`);
      }
    }
    sections.push("");
  }

  return sections.join("\n");
}

// --- #192 (coverage H1) — comprehension-artifact sections ---
//
// The debrief IS the session digest and export `full` IS the session report, so
// the two must connect: pre-#192 formatFull/formatLearnings/formatPrDescription
// filtered hardcoded type lists that omitted debrief + explainer (and the older
// spec + changeset), so the end-of-run comprehension surfaces never reached any
// export. Each helper renders ONLY when its artifact type is present, so a
// session without the new types produces byte-identical output.

/** Push evidence lines (file:line anchor + fenced snippet + explanation) for a
 *  list of EvidenceInput (string | Evidence object) — the same shape debrief and
 *  explainer sections carry. Mirrors formatFull's findings-evidence rendering so
 *  the three surfaces read identically. */
function pushEvidenceLines(sections: string[], evidence: unknown): void {
  if (!Array.isArray(evidence)) return;
  for (const ev of evidence) {
    if (typeof ev === "string") {
      sections.push(`> ${ev}`);
      sections.push("");
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const e = ev as { filePath?: string; lineStart?: number; lineEnd?: number; snippet?: string; language?: string; explanation?: string };
    if (e.filePath) sections.push(`\`${e.filePath}${e.lineStart != null ? `:${e.lineStart}${e.lineEnd != null ? `-${e.lineEnd}` : ""}` : ""}\``);
    if (e.snippet) {
      sections.push("```" + (e.language ?? ""));
      sections.push(e.snippet);
      sections.push("```");
    }
    if (e.explanation) sections.push(`> ${e.explanation}`);
    sections.push("");
  }
}

/** The debrief rendered as markdown — the five lanes (narrative + ordered
 *  sections, decisions made without you, needs-your-eyes, deferred, open
 *  questions). Reusable by formatFull and (its summary) formatPrDescription. */
function formatDebriefSections(state: SessionState): string[] {
  const sections: string[] = [];
  const debriefs = state.artifacts.filter((a) => a.type === "debrief" && a.status !== "superseded");
  for (const d of debriefs) {
    const content = coerceDebriefContent(d.content);
    // F2 (M2) — don't double-prefix "Debrief — Debrief — <title>" when the
    // artifact title already carries the word.
    const t = (d.title ?? "").trim();
    const heading = /^debrief\b/i.test(t) ? t : `Debrief — ${t || "Session"}`;
    sections.push(`## ${heading}\n`);
    const note = rejectionNote(d);
    if (note) sections.push(note);
    if (content.summary) sections.push(`${content.summary}\n`);

    if (content.sections?.length) {
      // F2 (M2) — the group header for the walk lane was "### What changed",
      // which collided with a same-named debrief section. The UI calls this
      // lane THE WALK; "Walkthrough" removes the collision.
      sections.push("### Walkthrough\n");
      for (const s of content.sections) {
        sections.push(`#### ${s.title}\n`);
        if (s.body) sections.push(`${s.body}\n`);
        if (s.concepts?.length) {
          for (const c of s.concepts) {
            sections.push(`- *Concept*: **${c.name}**${c.oneLineExplanation ? ` — ${c.oneLineExplanation}` : ""}`);
          }
          sections.push("");
        }
        pushEvidenceLines(sections, s.evidence);
      }
    }

    if (content.decisionsMade?.length) {
      sections.push("### Decisions I made without you\n");
      for (const dm of content.decisionsMade) {
        sections.push(`- **${dm.what}** — ${dm.why}${dm.alternative ? ` *(considered but not taken: ${dm.alternative})*` : ""}`);
      }
      sections.push("");
    }

    if (content.needsYourEyes?.length) {
      sections.push("### Needs your eyes\n");
      for (const n of content.needsYourEyes) {
        sections.push(`- **${n.what}** — ${n.why}`);
      }
      sections.push("");
    }

    if (content.deferred?.length) {
      sections.push("### Deferred\n");
      for (const df of content.deferred) {
        sections.push(`- **${df.what}** — ${df.why}`);
      }
      sections.push("");
    }

    if (content.openQuestions?.length) {
      sections.push("### Open questions\n");
      for (const q of content.openQuestions) sections.push(`- ${q}`);
      sections.push("");
    }
  }
  return sections;
}

/** The explainer rendered as markdown — the ordered walk-through (overview +
 *  numbered sections, each with its evidence). */
function formatExplainerSections(state: SessionState): string[] {
  const sections: string[] = [];
  const explainers = state.artifacts.filter((a) => a.type === "explainer" && a.status !== "superseded");
  for (const ex of explainers) {
    const content = coerceExplainerContent(ex.content);
    sections.push(`## Explainer — ${content.title || ex.title}\n`);
    const note = rejectionNote(ex);
    if (note) sections.push(note);
    if (content.overview) sections.push(`${content.overview}\n`);
    content.sections?.forEach((s, i) => {
      sections.push(`### ${i + 1}. ${s.heading}\n`);
      if (s.body) sections.push(`${s.body}\n`);
      pushEvidenceLines(sections, s.evidence);
    });
  }
  return sections;
}

/** Spec artifacts rendered as markdown — objective + requirements (each with
 *  rationale + acceptance criteria). #192 secondary: the review flagged spec as
 *  a pre-existing formatFull omission alongside debrief/explainer. */
function formatSpecSections(state: SessionState): string[] {
  const sections: string[] = [];
  const specs = state.artifacts.filter((a) => a.type === "spec" && a.status !== "superseded");
  for (const sp of specs) {
    const content = coerceSpecContent(sp.content);
    sections.push(`## Spec — ${sp.title}\n`);
    const note = rejectionNote(sp);
    if (note) sections.push(note);
    if (content.objective) sections.push(`**Objective**: ${content.objective}\n`);
    if (content.context) sections.push(`${content.context}\n`);
    if (content.requirements?.length) {
      sections.push("### Requirements\n");
      for (const r of content.requirements) {
        sections.push(`- **${r.id}**${r.priority ? ` _(${r.priority})_` : ""}: ${r.statement}`);
        if (r.rationale) sections.push(`  - *Why*: ${r.rationale}`);
        for (const ac of r.acceptanceCriteria ?? []) sections.push(`  - ✓ ${ac}`);
      }
      sections.push("");
    }
  }
  return sections;
}

/** Changeset artifacts rendered as markdown — per-file unified diffs. #192
 *  secondary: the changeset is the batched code surface; a full report should
 *  carry what actually changed. */
function formatChangesetSections(state: SessionState): string[] {
  const sections: string[] = [];
  const changesets = state.artifacts.filter((a) => a.type === "changeset" && a.status !== "superseded");
  for (const cs of changesets) {
    const content = coerceChangesetContent(cs.content);
    sections.push(`## Changeset — ${cs.title}\n`);
    const note = rejectionNote(cs);
    if (note) sections.push(note);
    if (content.summary) sections.push(`${content.summary}\n`);
    for (const file of content.files ?? []) {
      sections.push(`### \`${file.path}\` (${file.changeType})\n`);
      if (file.hunks?.length) {
        sections.push("```diff");
        for (const hunk of file.hunks) {
          if (hunk.header) sections.push(hunk.header);
          for (const line of hunk.lines ?? []) {
            const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
            sections.push(`${prefix}${line.content}`);
          }
        }
        sections.push("```");
      }
      sections.push("");
    }
  }
  return sections;
}

// --- Full Export ---

function formatFull(state: SessionState): string {
  const sections: string[] = [];

  sections.push(`# deepPairing Session Report\n`);
  sections.push(`**Session**: ${state.sessionId}`);
  sections.push(`**Date**: ${new Date().toISOString().split("T")[0]}\n`);
  sections.push("---\n");

  // Research findings
  const research = state.artifacts.filter((a) => a.type === "research" && a.status !== "superseded");
  if (research.length > 0) {
    sections.push("## Findings\n");
    for (const r of research) {
      const content = coerceResearchContent(r.content);
      // F2 (H1) — the full record KEEPS rejected/retracted research (the whole
      // record is the point here) but marks it so a reader never mistakes a
      // proposed-then-rejected approach for what shipped.
      const note = rejectionNote(r);
      if (note) sections.push(note);
      if (content.summary) sections.push(`${content.summary}\n`);

      for (const f of content.findings ?? []) {
        sections.push(`### ${f.title ?? f.category} (${f.significance})\n`);
        sections.push(f.detail + "\n");

        // Evidence with code. D7 — the typed coercer surfaced what the old
        // `as any` hid: evidence ARRAYS can still contain plain strings
        // (legacy mixed shape); narrow per element instead of assuming objects.
        if (Array.isArray(f.evidence)) {
          for (const ev of f.evidence) {
            if (typeof ev === "string") {
              sections.push(`> ${ev}`);
              sections.push("");
              continue;
            }
            sections.push(`\`${ev.filePath}:${ev.lineStart}-${ev.lineEnd}\``);
            if (ev.snippet) {
              sections.push("```" + (ev.language ?? ""));
              sections.push(ev.snippet);
              sections.push("```");
            }
            if (ev.explanation) sections.push(`> ${ev.explanation}`);
            sections.push("");
          }
        } else if (typeof f.evidence === "string") {
          sections.push(`Evidence: ${f.evidence}\n`);
        }

        if (f.impact) sections.push(`**Impact**: ${f.impact}\n`);
        if (f.recommendation) sections.push(`**Recommendation**: ${f.recommendation}\n`);
      }

      // Comments on this artifact
      const artComments = state.comments.filter((c) => c.target.artifactId === r.id);
      if (artComments.length > 0) {
        sections.push("**Comments:**");
        for (const c of artComments) {
          sections.push(`- *${c.author}*: ${c.content}`);
        }
        sections.push("");
      }
    }
  }

  // Spec (#192) — objective + requirements, when a spec artifact exists.
  sections.push(...formatSpecSections(state));

  // Decisions
  const resolved = state.decisions.filter((d) => d.response);
  if (resolved.length > 0) {
    sections.push("## Decisions\n");
    for (const d of resolved) {
      const chosen = d.options.find((o: any) => o.id === d.response?.optionId);
      sections.push(`### ${d.context}\n`);
      // Fix 3 — the full record keeps a rejected/retracted decision but marks it.
      const dNote = decisionIsRejected(state, d) ? rejectionNote(decisionOwningArtifact(state, d)!) : null;
      if (dNote) sections.push(dNote);
      sections.push(`**Selected**: ${chosen?.title ?? d.response?.optionId}`);
      if (d.response?.reasoning) sections.push(`**Reasoning**: ${d.response.reasoning}`);
      sections.push("\nOptions considered:");
      for (const o of d.options) {
        const marker = o.id === d.response?.optionId ? "✓" : "✗";
        sections.push(`- ${marker} **${o.title}** (${o.effort} effort, ${o.risk} risk): ${o.description ?? ""}`);
      }
      sections.push("");
    }
  }

  // Plans
  const plans = state.artifacts.filter((a) => a.type === "plan" && a.status !== "superseded");
  if (plans.length > 0) {
    sections.push("## Implementation Plan\n");
    for (const plan of plans) {
      sections.push(`### ${plan.title}\n`);
      const rejNote = rejectionNote(plan);
      if (rejNote) sections.push(rejNote);
      const review = state.planReviews.find((p) => p.artifactId === plan.id);
      if (review?.verdict) sections.push(`**Status**: ${review.verdict}\n`);

      for (const [i, step] of coercePlanContent(plan.content).steps.entries()) {
        sections.push(`${i + 1}. **${step.description}** — ${step.reasoning}`);
        if (step.motivatedBy?.length) {
          sections.push(`   *Motivated by*: ${step.motivatedBy.join(", ")}`);
        }
      }
      sections.push("");
    }
  }

  // Changeset (#192) — the batched code surface, per-file unified diffs.
  sections.push(...formatChangesetSections(state));

  // Debrief (#192) — the end-of-run session digest (the five lanes). This IS
  // the report's narrative of what changed and why the agent decided as it did.
  sections.push(...formatDebriefSections(state));

  // Explainer (#192) — read-only walk-through of how something works.
  sections.push(...formatExplainerSections(state));

  // Reasoning log
  const reasoning = state.artifacts.filter((a) => a.type === "reasoning");
  if (reasoning.length > 0) {
    sections.push("<details><summary>Reasoning Log</summary>\n");
    for (const r of reasoning) {
      const content = coerceReasoningContent(r.content);
      sections.push(`- **${content.action}** (${content.confidence}): ${content.reasoning}`);
    }
    sections.push("\n</details>\n");
  }

  sections.push("---\n*Generated by [deepPairing](https://github.com/deeppairing)*");

  return sections.join("\n");
}

function getSessionTitle(state: SessionState): string {
  // Fix 3 (review #232) — never title a session (esp. the ADR heading) after a
  // decision/research that was rejected: that leaks discarded work as the
  // headline of "what shipped". Prefer the first NON-rejected source; fall
  // through to a neutral session id rather than to a rejected one.
  const firstDecision = state.decisions.find((d) => !decisionIsRejected(state, d));
  // M1.1 — prefer the SHORT title over the full-paragraph context so the
  // learnings/ADR heading names the fork instead of dumping the background
  // (the dogfood's title-bloat). Absent title → context, as before.
  if (firstDecision) return firstDecision.title?.trim() || firstDecision.context;
  const firstResearch = state.artifacts.find((a) => a.type === "research" && isShippedArtifact(a));
  if (firstResearch) return firstResearch.title;
  return "Session " + state.sessionId;
}

// --- Replay format (chronological narrative for learning re-reads) ---

function formatReplay(state: SessionState): string {
  const title = getSessionTitle(state);
  const sections: string[] = [];

  sections.push(`# Replay: ${title}\n`);
  sections.push(`*Chronological walkthrough for learning re-read.*\n`);

  const events = buildTimeline({
    artifacts: state.artifacts,
    comments: state.comments,
    decisions: state.decisions as DecisionRecord[],
    planReviews: state.planReviews as PlanReviewRecord[],
  });

  // Group annotations by target event for inline marginalia.
  const annotationsByEvent = new Map<string, SessionAnnotation[]>();
  for (const ann of state.annotations ?? []) {
    const list = annotationsByEvent.get(ann.targetEventId) ?? [];
    list.push(ann);
    annotationsByEvent.set(ann.targetEventId, list);
  }

  if (events.length === 0) {
    sections.push("_No events recorded in this session._");
    return sections.join("\n");
  }

  sections.push("## Timeline\n");
  for (const event of events) {
    const when = formatTime(event.at);
    const icon = replayIcon(event.kind);
    sections.push(`### ${icon} ${when} — ${event.label}`);

    // Kind-specific body
    if (event.kind === "decision_resolved") {
      const p = event.payload ?? {};
      if (p.reasoning) sections.push(`Reasoning: ${p.reasoning}`);
      if (Array.isArray(p.rejectedTitles) && p.rejectedTitles.length > 0) {
        sections.push(`_Rejected:_ ${(p.rejectedTitles as string[]).join(", ")}`);
      }
    } else if (event.kind === "comment_added") {
      const p = event.payload ?? {};
      const who = p.author === "agent" ? "Agent" : p.intent === "question" ? "You asked" : "You";
      sections.push(`${who}: ${p.content}`);
    } else if (event.kind === "plan_reviewed") {
      const p = event.payload ?? {};
      if (p.feedback) sections.push(`Feedback: ${p.feedback}`);
    }

    // Learner annotations attached to this event
    const anns = annotationsByEvent.get(event.id);
    if (anns && anns.length > 0) {
      for (const ann of anns) {
        sections.push(`> 📝 **note:** ${ann.note}${ann.tags?.length ? ` \`[${ann.tags.join(", ")}]\`` : ""}`);
      }
    }
    sections.push("");
  }

  sections.push("---\n*Generated by [deepPairing](https://github.com/deeppairing)*");
  return sections.join("\n");
}

function replayIcon(kind: string): string {
  switch (kind) {
    case "artifact_created": return "➕";
    case "artifact_status_changed": return "🔄";
    case "comment_added": return "💬";
    case "decision_resolved": return "⚖️";
    case "plan_reviewed": return "📋";
    default: return "•";
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return iso;
  }
}

const severityEmoji: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
  info: "⚪",
};

// --- GitHub PR review API payload ---
//
// Shape matches POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews so
// we can shell out to `gh api ... --input -` with this object as stdin.
// https://docs.github.com/en/rest/pulls/reviews

export type GitHubReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export interface GitHubReviewPayload {
  body: string;
  event: GitHubReviewEvent;
  comments: GitHubReviewComment[];
}

/**
 * Build the GitHub "review with inline comments" payload from a session.
 * One comment per distinct evidence location in an approved research
 * artifact; severity chip + explanation + impact + recommendation compose
 * the comment body. A top-level body summarizes the session.
 *
 * Rejected / retracted / superseded research artifacts are omitted — the
 * user didn't want those going to a PR.
 */
export function buildGitHubReviewPayload(
  state: SessionState,
  opts: { event?: GitHubReviewEvent } = {},
): GitHubReviewPayload {
  const comments: GitHubReviewComment[] = [];
  const findingTitles: string[] = [];

  const researchArtifacts = state.artifacts.filter(
    // R3 (adversarial F8) — the shared shipped-status predicate, which drops
    // `obsolete` too. This is the path that POSTS findings to a stranger's PR;
    // the hand-copy here omitted `obsolete`, so overtaken findings could be
    // posted as live review comments. SEAM: R1 also edits this function (session
    // -id scrub) — this hunk is the filter predicate only.
    (a) => a.type === "research" && isShippedArtifact(a),
  );

  for (const artifact of researchArtifacts) {
    const findings = coerceResearchContent(artifact.content).findings;
    if (!Array.isArray(findings)) continue;

    for (const finding of findings) {
      // R1 (#279) — INTERNAL findings never leave the machine. The review-pr
      // ledger sweep turns the human's private cross-project stances into
      // findings ("you rejected this on <date>: '<their words>'"); approving
      // one is permission to show it to THEM, never to publish it on a
      // stranger's PR. One predicate (isPostableFinding), consulted here and
      // in the authorization gate's postable-evidence probe.
      if (!isPostableFinding(finding)) continue;
      const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
      // D7 — the runtime narrowing existed; the predicate is now a TYPE guard
      // so the loop below reads typed evidence instead of any.
      const structured = evidence.filter(
        (e): e is Exclude<typeof e, string> =>
          !!e && typeof e === "object" && !!e.filePath && typeof e.lineStart === "number",
      );
      if (structured.length === 0) continue;

      const sev = finding.severity ?? "info";
      const chip = severityEmoji[sev] ?? "⚪";
      const title = finding.title ? `**${finding.title}**` : `**${finding.category ?? "Finding"}**`;
      if (finding.title) findingTitles.push(finding.title);

      for (const ev of structured) {
        const bodyLines: string[] = [];
        bodyLines.push(`${chip} ${title} — ${sev.toUpperCase()}${finding.category ? ` · ${finding.category}` : ""}`);
        if (finding.detail) {
          bodyLines.push("");
          bodyLines.push(finding.detail);
        }
        if (ev.explanation) {
          bodyLines.push("");
          bodyLines.push(`_${ev.explanation}_`);
        }
        if (finding.impact) {
          bodyLines.push("");
          bodyLines.push(`**Impact:** ${finding.impact}`);
        }
        if (finding.recommendation) {
          bodyLines.push("");
          bodyLines.push(`**Recommendation:** ${finding.recommendation}`);
        }

        comments.push({
          path: ev.filePath,
          // GitHub's review API uses the END line for multi-line comments
          // (set via start_line/line pair in the richer endpoint). For the
          // simple single-line shape, anchor to lineEnd when it exists.
          line: ev.lineEnd ?? ev.lineStart,
          side: "RIGHT",
          body: bodyLines.join("\n"),
        });
      }
    }
  }

  // R1 (#279) — NO SESSION ID IN AN OUTBOUND BODY. A deepPairing sessionId is
  // `session_<the reviewer's local folder name>_<hash>`, and every posted review
  // ended with it — a bare APPROVE put it in the h2 as well, because
  // getSessionTitle falls through to "Session <id>" when a session has no
  // decision or shipped research to name itself after. That published the
  // reviewer's directory layout to a third party's repository for nothing: the
  // id is meaningless to the PR author and identifying to the reviewer.
  //
  // This is the ONLY exporter with an outbound audience, so the scrub is local
  // to it rather than a change to getSessionTitle (the share page and the
  // markdown exports are the human's own record and are R3's surface).
  const derivedTitle = getSessionTitle(state);
  const title = derivedTitle.startsWith("Session ") ? null : derivedTitle;
  const bodyParts: string[] = [
    `## deepPairing notes${title ? ` — ${title}` : ""}`,
    "",
  ];
  if (comments.length === 0) {
    bodyParts.push("_No reviewable findings with structured evidence in this pairing session._");
  } else {
    bodyParts.push(`${comments.length} inline comment${comments.length === 1 ? "" : "s"} from this pairing session.`);
    if (findingTitles.length > 0) {
      bodyParts.push("");
      bodyParts.push("**Findings:**");
      for (const t of findingTitles) bodyParts.push(`- ${t}`);
    }
  }
  bodyParts.push("");
  bodyParts.push(`*Generated with [deepPairing](https://github.com/deeppairing).*`);

  return {
    body: bodyParts.join("\n"),
    event: opts.event ?? "COMMENT",
    comments,
  };
}

// --- PR-comments format (pairing output formatted as inline PR comments) ---
//
// Posts the output of a pairing session onto a PR. NOT a review tool — these
// comments are the artifacts of pairing on the change together. Each surviving
// finding (with structured evidence) becomes a quoted file:line reference +
// severity chip + impact/recommendation. Rejected findings are omitted; the
// pair already decided they weren't load-bearing.

function formatPrComments(state: SessionState): string {
  const sections: string[] = [];
  const title = getSessionTitle(state);
  sections.push(`## deepPairing notes — ${title}`);
  sections.push("");

  // Only include findings that weren't rejected — a reviewer doesn't want
  // to paste their own rejected concerns.
  const researchArtifacts = state.artifacts.filter(
    // R3 (adversarial F8) — shared predicate; drops `obsolete` too (pr-comments
    // is pasted onto a PR, so an overtaken finding must not read as live).
    (a) => a.type === "research" && isShippedArtifact(a),
  );

  const allFindings: Array<{
    artifact: Artifact;
    finding: any;
    index: number;
  }> = [];
  for (const artifact of researchArtifacts) {
    const findings = coerceResearchContent(artifact.content).findings;
    if (!Array.isArray(findings)) continue;
    findings.forEach((f: any, i: number) => {
      allFindings.push({ artifact, finding: f, index: i });
    });
  }

  if (allFindings.length === 0) {
    sections.push("_No findings from this pairing session._");
    sections.push("");
    return sections.join("\n");
  }

  // Group by file (first file mentioned in each finding's evidence). Files
  // that don't resolve (non-structured evidence) go into a "General" bucket.
  const byFile = new Map<string, typeof allFindings>();
  for (const entry of allFindings) {
    const evidence = entry.finding.evidence;
    const firstPath = Array.isArray(evidence) && evidence[0] && typeof evidence[0] === "object"
      ? (evidence[0] as any).filePath
      : undefined;
    const key = firstPath ?? "General";
    const list = byFile.get(key) ?? [];
    list.push(entry);
    byFile.set(key, list);
  }

  for (const [filePath, entries] of byFile.entries()) {
    sections.push(`### ${filePath}`);
    sections.push("");
    for (const { finding } of entries) {
      const sev = finding.severity ?? "info";
      const chip = `${severityEmoji[sev] ?? "⚪"} **${sev.toUpperCase()}**`;
      const category = finding.category ? ` · ${finding.category}` : "";
      const title = finding.title ? ` — ${finding.title}` : "";
      sections.push(`${chip}${category}${title}`);
      sections.push("");

      // File:line anchor + snippet
      const evidenceList = Array.isArray(finding.evidence) ? finding.evidence : [];
      for (const ev of evidenceList) {
        if (typeof ev !== "object" || !ev.filePath) continue;
        const linePart = ev.lineEnd && ev.lineEnd !== ev.lineStart
          ? `L${ev.lineStart}-L${ev.lineEnd}`
          : `L${ev.lineStart}`;
        sections.push(`> \`${ev.filePath}:${linePart}\``);
        if (ev.snippet) {
          const lang = ev.language ?? "";
          sections.push("> ```" + lang);
          for (const line of ev.snippet.split("\n")) {
            sections.push("> " + line);
          }
          sections.push("> ```");
        }
        if (ev.explanation) {
          sections.push(`> ${ev.explanation}`);
        }
      }

      if (finding.detail) {
        sections.push("");
        sections.push(finding.detail);
      }
      if (finding.impact) {
        sections.push("");
        sections.push(`**Impact:** ${finding.impact}`);
      }
      if (finding.recommendation) {
        sections.push("");
        sections.push(`**Recommendation:** ${finding.recommendation}`);
      }
      sections.push("");
      sections.push("---");
      sections.push("");
    }
  }

  sections.push("*Output from a [deepPairing](https://github.com/deeppairing) session — paste into a PR comment.*");
  return sections.join("\n");
}

// --- Learnings format (R3) ---
//
// A teaching artifact: what the pair *learned* during this session, not what
// they built. Two sections:
//   - Concepts named via log_reasoning (with count per concept)
//   - Rejected approaches with reasons — the "you won't re-propose this"
//     moat, made legible for sharing
//
// Distinct from `full` (everything) and `replay` (chronological). This is
// what you paste into a weekly learning channel or a hiring doc.

function formatLearnings(state: SessionState): string {
  const sections: string[] = [];
  const title = getSessionTitle(state);
  sections.push(`# Learnings — ${title}`);
  sections.push("");
  sections.push(
    "*Teaching artifact: concepts named and approaches you won't re-propose.*",
  );
  sections.push("");

  // --- Concepts named via log_reasoning ---
  const reasoningArtifacts = state.artifacts.filter(
    (a) => a.type === "reasoning" && a.status !== "superseded" && a.status !== "retracted",
  );
  const conceptCounts = new Map<string, { name: string; explanation?: string; count: number; actions: string[] }>();
  for (const a of reasoningArtifacts) {
    const content = coerceReasoningContent(a.content);
    const concept = content.concept;
    if (!concept?.name) continue;
    const key = normalizeConceptKey(concept.name);
    if (!key) continue;
    const existing = conceptCounts.get(key);
    const action = content.action || null;
    if (existing) {
      existing.count += 1;
      if (action && !existing.actions.includes(action)) existing.actions.push(action);
    } else {
      conceptCounts.set(key, {
        name: String(concept.name).trim(),
        explanation: concept.oneLineExplanation ? String(concept.oneLineExplanation) : undefined,
        count: 1,
        actions: action ? [action] : [],
      });
    }
  }

  if (conceptCounts.size > 0) {
    sections.push("## Concepts the pair named");
    sections.push("");
    // Sort by count desc, then name asc so recurring patterns lead.
    const sorted = Array.from(conceptCounts.values()).sort(
      (a, b) => (b.count - a.count) || a.name.localeCompare(b.name),
    );
    for (const c of sorted) {
      const countLabel = c.count > 1 ? ` _(×${c.count})_` : "";
      sections.push(`- **${c.name}**${countLabel}`);
      if (c.explanation) sections.push(`  > ${c.explanation}`);
      if (c.actions.length > 0) {
        const shown = c.actions.slice(0, 3);
        for (const act of shown) sections.push(`  - applied to: ${act}`);
      }
    }
    sections.push("");
  }

  // --- Rejected approaches ---
  // We pull these from the state's session metadata when available; otherwise
  // we reconstruct from rejected-status artifacts with a reason.
  const rejectedFromStatus = state.artifacts.filter(
    (a) => a.status === "rejected" && a.type !== "reasoning",
  );
  const rejectedApproaches = (state as any).sessionMemory?.rejectedApproaches as
    | Array<{ description: string; reason?: string; concept?: string }>
    | undefined;

  const seenReasons = new Set<string>();
  const rows: string[] = [];
  if (rejectedApproaches) {
    for (const r of rejectedApproaches) {
      const key = r.description;
      if (seenReasons.has(key)) continue;
      seenReasons.add(key);
      rows.push(
        `- **${r.description}**${r.concept ? ` _(concept: ${r.concept})_` : ""}${
          r.reason ? ` — "${r.reason}"` : ""
        }`,
      );
    }
  } else {
    for (const a of rejectedFromStatus) {
      if (seenReasons.has(a.title)) continue;
      seenReasons.add(a.title);
      rows.push(`- **${a.title}**`);
    }
  }
  if (rows.length > 0) {
    sections.push("## Approaches you won't re-propose");
    sections.push("");
    rows.forEach((r) => sections.push(r));
    sections.push("");
  }

  // --- From the debrief (#192) ---
  // The debrief's decisionsMade (calls the agent made alone + why) is prime
  // learning material — the reasoning you'd otherwise have to reconstruct. Its
  // deferred + openQuestions are the open threads worth carrying forward.
  const debriefs = state.artifacts.filter((a) => a.type === "debrief" && a.status !== "superseded");
  const debriefDecisions = debriefs.flatMap((d) => coerceDebriefContent(d.content).decisionsMade ?? []);
  const debriefDeferred = debriefs.flatMap((d) => coerceDebriefContent(d.content).deferred ?? []);
  const debriefOpen = debriefs.flatMap((d) => coerceDebriefContent(d.content).openQuestions ?? []);
  const hasDebriefLearnings = debriefDecisions.length > 0 || debriefDeferred.length > 0 || debriefOpen.length > 0;
  if (hasDebriefLearnings) {
    sections.push("## From the debrief");
    sections.push("");
    if (debriefDecisions.length > 0) {
      sections.push("### Calls the agent made on its own");
      sections.push("");
      for (const dm of debriefDecisions) {
        sections.push(`- **${dm.what}** — ${dm.why}${dm.alternative ? ` _(considered: ${dm.alternative})_` : ""}`);
      }
      sections.push("");
    }
    if (debriefDeferred.length > 0) {
      sections.push("### Deferred");
      sections.push("");
      for (const df of debriefDeferred) sections.push(`- **${df.what}** — ${df.why}`);
      sections.push("");
    }
    if (debriefOpen.length > 0) {
      sections.push("### Still open");
      sections.push("");
      for (const q of debriefOpen) sections.push(`- ${q}`);
      sections.push("");
    }
  }

  if (conceptCounts.size === 0 && rows.length === 0 && !hasDebriefLearnings) {
    sections.push("_Nothing crystallized yet. Keep pairing — the agent's `log_reasoning.concept` field and your rejection reasons become the material here._");
    sections.push("");
  }

  sections.push(`*Generated from session ${state.sessionId} — [deepPairing](https://github.com/deeppairing).*`);
  return sections.join("\n");
}
