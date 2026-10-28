import type { Artifact } from "@deeppairing/shared";
import type { PreflightBlockRecord } from "../stores/preflightBlocks";
import { isDelegateBriefArtifact, type AttentionItem } from "./attention";

/**
 * #430 slice 1 — THE ONE COPY MODULE for "what needs you". Both needs-you
 * surfaces read it, so they can never say different things about the same item:
 *   - PendingBanner, the default view (Next-up bar OFF), for its lead item;
 *   - the Next-up bar (opt-in), for `next`.
 *
 * Every string is DERIVED from the item and its artifact, never invented
 * (design §4.4). Per item it answers:
 *   - what:       the lane word + title, with HIGH / Risk / Demo tags;
 *   - why:        why it matters, from the artifact's own content;
 *   - ifIgnored:  what waits on it — worded conditionally (an awaiting artifact
 *                 does not by itself prove Claude is stopped right now; Astra's
 *                 scope review, comment 6406948926, condition 2);
 *   - after:      what happens when you respond.
 * Replay / disconnected / exited reach (#457 D3) governs BOTH ifIgnored and
 * after. Pure: no React, no stores (the type import is erased).
 */

/** Whether Claude can act on a response right now (#457 D3). */
export type AgentReach = "live" | "gone" | "disconnected" | "replay";

/** #470 (§4a) — the Decide "Why" line for an artifact admitted under your
 *  allowance. The label names the door (UI/CLI), never a person. */
export function admittedWhy(a: Artifact | undefined, blocks: PreflightBlockRecord[]): string | null {
  const adm = a?.admission;
  if (!adm) return null;
  const via = adm.grantedVia === "cli" ? "CLI" : "UI";
  const receipt = blocks.find((b) => b.allowance && adm.exceptionIds.includes(b.allowance.id));
  const stance = receipt ? ` for '${receipt.concept}'` : "";
  const reason = receipt?.allowance?.reason ? `: ${receipt.allowance.reason}` : "";
  return `Admitted under your allowance (${via})${stance}${reason}`;
}

/** The lane WORD (text, never colour alone). */
export const LANE_WORD: Partial<Record<AttentionItem["kind"], string>> = {
  // Only a terminal-held item reaches the copy line as `next`; an ordinary
  // stance hold is a read-only record (the bar's "■ HELD" token says so).
  decision: "DECIDE",
  "review-blocking": "REVIEW",
  review: "REVIEW",
  flag: "POSSIBLE SECRET",
};

const artifactOf = (item: AttentionItem, artifacts: Artifact[]): Artifact | undefined =>
  item.artifactId ? artifacts.find((x) => x.id === item.artifactId) : undefined;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The brief's headed `Risk class:` value (delegate.md move 2: trivial,
 *  low-risk or escalated) — its first word, only when explicitly present. */
export function briefRiskClass(a: Artifact | undefined): string | null {
  if (!a || !isDelegateBriefArtifact(a)) return null;
  const context = (a.content as { context?: unknown } | null)?.context;
  if (typeof context !== "string") return null;
  const m = /^[ \t]*Risk class:[ \t]*([A-Za-z][\w-]*)/im.exec(context);
  return m?.[1] ? m[1].toLowerCase() : null;
}

function briefTaskCount(a: Artifact | undefined): number {
  const tasks = (a?.content as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) ? tasks.length : 0;
}

/** §4.4 — "why it matters", from the item's own content. Never invented: a
 *  type with no explanatory field gets no why line. */
export function whyFor(item: AttentionItem, artifacts: Artifact[], blocks: PreflightBlockRecord[] = []): string {
  const a = artifactOf(item, artifacts);
  const admitted = admittedWhy(a, blocks);
  if (admitted) return admitted;
  switch (item.kind) {
    case "decision":
      return str((a?.content as { context?: unknown } | undefined)?.context);
    case "review-blocking":
    case "review":
      if (!a) return "";
      // A brief / spec says what it is for; findings and changesets summarise.
      if (a.type === "spec") return str((a.content as { objective?: unknown } | null)?.objective);
      if (a.type === "research" || a.type === "changeset") return str((a.content as { summary?: unknown } | null)?.summary);
      return "";
    case "question": return `You asked: ${item.title}`;
    case "request": return `You asked for: ${item.title}`;
    case "revision": return `You requested changes to ${item.title}`;
    default: return "";
  }
}

/** The held lane's input, from the stance-hold store: UNREAD holds (the same
 *  boundary the ⋯ gate log uses), titled as the bar has always titled them. A
 *  hook `ask` is `terminal` — Claude Code asked at the terminal. */
export function attentionHolds(
  blocks: PreflightBlockRecord[],
  lastSeenAt: string | null | undefined,
): { id: string; title: string; at: string; terminal?: boolean }[] {
  return blocks
    // #470 (§4a) — a block you allowed is seen (daemon-written seenAt).
    .filter((b) => !b.seenAt && (!lastSeenAt || b.at > lastSeenAt))
    .map((b) => ({
      id: b.id,
      // #544 — a hook firing names the file Claude Code asked about.
      title: b.lane === "hook" && b.targetPath
        ? `"${b.concept}": Claude Code ${b.decision === "deny" ? "stopped" : "asked about"} ${b.targetPath}${b.agentType ? ` (${b.agentType} subagent)` : b.agentId ? " (subagent)" : ""}`
        : b.proposal ? `"${b.concept}" stopped: ${b.proposal}` : `"${b.concept}"`,
      at: b.at,
      ...(b.lane === "hook" && b.decision === "ask" ? { terminal: true } : {}),
    }));
}

/** "If you leave it": what waits on this item. Conditional wording — the
 *  artifact proves an approval is REQUIRED, not that Claude is stopped now. */
export function ifIgnoredFor(item: AttentionItem, reach: AgentReach): string {
  if (item.kind === "held" && item.terminal) {
    if (reach === "replay") return "History — nothing waits on this now";
    if (reach === "gone") return "Claude has exited";
    // Terminal routing is unchanged: only an answer in the terminal releases it.
    return "Claude Code asked in the terminal — answer it there; nothing here releases it";
  }
  const blocking = item.kind === "decision" || item.kind === "review-blocking";
  if (item.kind !== "review" && !blocking) return "";
  if (reach === "replay") return "History — nothing waits on this now";
  if (reach === "gone") return blocking ? "Claude has exited — this waits for the session to resume" : "Claude has exited";
  const text = item.kind === "decision"
    ? "Your choice is needed before this work proceeds"
    : blocking ? "Approval required before this work proceeds"
    : "Not blocking — Claude can keep working";
  return reach === "disconnected" ? `Last known: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** §4.4 — "what happens after you respond", reusing the app's honest copy.
 *  #457 D3 — never promise what an absent agent will do: replay is read-only,
 *  a disconnected tab can't deliver, and an exited agent acts on resume. */
export function afterFor(item: AttentionItem, artifacts: Artifact[], reach: AgentReach): string {
  const a = artifactOf(item, artifacts);
  const agentGone = reach === "gone";
  if (reach === "replay" && item.kind !== "flag") return "Replay is read-only — nothing you do here reaches Claude";
  // #465 N3 — it is THIS TAB that lost the daemon, not Claude.
  if (reach === "disconnected" && item.kind !== "flag") return "This tab is offline — your response can be sent once it reconnects to deepPairing";
  switch (item.kind) {
    case "decision":
      return agentGone
        ? "Saved — Claude sees your choice when the session resumes"
        : "Claude continues with the option you pick";
    case "review-blocking": {
      if (agentGone) return "Saved — Claude acts on your verdict when the session resumes";
      if (a?.type === "plan") {
        const n = ((a.content as { steps?: unknown[] } | null)?.steps ?? []).length;
        return `Approve → Claude executes ${n} step${n === 1 ? "" : "s"} · Request changes → Claude revises the plan`;
      }
      if (a && isDelegateBriefArtifact(a)) {
        const n = briefTaskCount(a);
        // Conditional (Astra condition 2): approval lets the work proceed; it
        // does not prove Claude will build right now.
        const work = n > 0 ? `the brief's ${n} task${n === 1 ? "" : "s"} can proceed` : "the work can proceed";
        return `Approve → ${work} · Request changes → Claude revises the brief`;
      }
      return "Your verdicts go back as one review; Claude is waiting on it";
    }
    case "review":
      return agentGone
        ? "Saved — Claude sees your verdict when the session resumes"
        : "Your verdict reaches Claude on its next check (usually < 30s)";
    case "flag":
      return "Already stored and will appear in exports — if it's a real credential, rotate it";
    case "held":
      return item.terminal ? "Answer in the terminal — approving here does not release it" : "";
    case "question":
    case "request":
    case "revision":
      return agentGone
        ? "Claude exited — it's answered when the session resumes"
        : "Claude answers on its next check";
    default:
      return "";
  }
}

export interface ItemCopy {
  /** DECIDE / REVIEW / POSSIBLE SECRET; null for the Waiting / held kinds. */
  lane: string | null;
  /** Text tags, in display order: `HIGH`, `Risk: <class>`, `Demo`. */
  tags: string[];
  why: string;
  ifIgnored: string;
  after: string;
}

/** Everything both surfaces show for one item. */
export function copyFor(
  item: AttentionItem,
  artifacts: Artifact[],
  reach: AgentReach,
  blocks: PreflightBlockRecord[] = [],
): ItemCopy {
  const a = artifactOf(item, artifacts);
  const risk = briefRiskClass(a);
  const tags = [
    ...(item.stakes === "high" ? ["HIGH"] : []),
    ...(risk ? [`Risk: ${risk}`] : []),
    ...(item.demo ? ["Demo"] : []),
  ];
  return {
    lane: item.kind === "held" && item.terminal ? "HELD IN TERMINAL" : LANE_WORD[item.kind] ?? null,
    tags,
    why: whyFor(item, artifacts, blocks),
    ifIgnored: ifIgnoredFor(item, reach),
    after: afterFor(item, artifacts, reach),
  };
}

/** The item as one plain sentence — `REVIEW <title> · Risk: escalated ·
 *  <if ignored> · <after>` — the accessible text both surfaces expose (and the
 *  string the parity test compares). The why line is separate (it is long). */
export function copyLineText(title: string, c: ItemCopy): string {
  return [c.lane ? `${c.lane} ${title}` : title, ...c.tags, c.ifIgnored, c.after].filter(Boolean).join(" · ");
}

/** Reach from the signals both surfaces already read. */
export function reachFrom(s: { replay: boolean; tabOffline: boolean; agentGone: boolean }): AgentReach {
  return s.replay ? "replay" : s.tabOffline ? "disconnected" : s.agentGone ? "gone" : "live";
}
