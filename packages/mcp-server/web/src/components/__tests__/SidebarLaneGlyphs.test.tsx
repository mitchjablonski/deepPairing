import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ArtifactPanel } from "../ArtifactPanel";
import { NextUpBar } from "../NextUpBar";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useReplayStore } from "../../stores/replay";
import { computeAttention } from "../../lib/attention";
import { laneMarksFrom, LANE_MARKS } from "../../lib/laneMarks";
import { WAITING_TONE } from "../../lib/waitingTone";

/**
 * #430 PR 4 (docs/design/attention-hierarchy.md §5, §8 PR 4) — sidebar lane
 * glyphs ▲ ● ○ ◌, derived from computeAttention so a sidebar row and the
 * Next-up bar never disagree. Unflagged (like PR 0 and 1d): every glyph carries
 * its own label as accessible name AND tooltip, so it stands without the bar.
 */
let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const art = (id: string, type: string, title: string, status = "draft", content: Record<string, unknown> = {}) =>
  ({ id, sessionId: "s1", type, version: 1, parentId: null, title, status, content, agentReasoning: null, createdAt: at(), updatedAt: at() }) as any;
const decision = (id: string, title: string, stakes = "high") =>
  art(id, "decision", title, "draft", { context: "c", decisionId: `d_${id}`, stakes, options: [] });
const research = (id: string, title: string, status = "draft") => art(id, "research", title, status, { summary: "s", findings: [] });
const explainer = (id: string, title: string) => art(id, "explainer", title, "draft", { title, overview: "o", sections: [] });
const question = (id: string, artifactId: string) => ({
  id, sessionId: "s1", target: { artifactId }, parentCommentId: null, author: "human",
  content: `Question ${id}?`, acknowledged: false, createdAt: at(), intent: "question",
}) as any;

beforeEach(() => {
  t = 0;
  useArtifactStore.getState().reset();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null } as any);
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false } as any);
  usePreferencesStore.setState({ nextUpBar: false, sidebarCollapsed: false } as any);
});

/** The status/lane dot on a sidebar row (expanded rail). */
const rowDot = (title: string) => {
  const row = screen.getAllByText(title).map((el) => el.closest("button[data-artifact-item]")).find(Boolean) as HTMLElement;
  return row.querySelector("span[aria-label][title]") as HTMLElement;
};

const seedAllLanes = () => {
  const s = useArtifactStore.getState();
  s.addArtifact(decision("dec", "Which store backs the cache?"));
  s.addArtifact(research("rev", "Refresh isn't coalesced"));
  s.addArtifact(art("cs", "changeset", "Move refresh into middleware", "draft", { title: "t", files: [] }));
  s.addArtifact(explainer("exp", "How refresh works"));
  s.addArtifact(art("rea", "reasoning", "Single-flight instead of a lock", "draft", { action: "a", reasoning: "r" }));
  s.addArtifact(research("wai", "Backfill plan", "revised"));
  s.addArtifact(research("ok", "Audit done", "approved"));
  s.addArtifact(research("no", "Dropped idea", "rejected"));
  s.addArtifact(research("obs", "Stale finding", "obsolete"));
};

const EXPECTED: [title: string, glyph: string, label: string, colour: string][] = [
  ["Which store backs the cache?", "▲", "Decision, awaiting your pick", "bg-accent-amber"],
  ["Refresh isn't coalesced", "●", "Draft, awaiting review", "bg-accent-amber"],
  ["Move refresh into middleware", "●", "Draft, awaiting review", "bg-accent-amber"],
  ["How refresh works", "○", "New — for you to read", "bg-text-muted"],
  ["Single-flight instead of a lock", "○", "New — for you to read", "bg-text-muted"],
  ["Backfill plan", "◌", "Revision requested — waiting on Claude", WAITING_TONE.dot],
  // In no lane: today's status marks, unchanged.
  ["Audit done", "✓", "Approved", "bg-accent-green"],
  ["Dropped idea", "✗", "Rejected", "bg-accent-red"],
  ["Stale finding", "⊘", "Overcome by new information", "bg-text-muted"],
];

describe("#430 PR 4 — each lane gets its glyph and label (expanded sidebar)", () => {
  it.each(EXPECTED)("%s → %s %s", (title, glyph, label, colour) => {
    seedAllLanes();
    render(<ArtifactPanel />);
    const dot = rowDot(title);
    expect(dot.textContent).toBe(glyph);
    expect(dot.getAttribute("aria-label")).toBe(label);
    // The tooltip IS the label — the OFF (no bar) legend.
    expect(dot.getAttribute("title")).toBe(label);
    expect(dot.className).toContain(colour);
  });

  it("never colour alone: the two amber lanes differ by shape and label; every lane glyph is distinct", () => {
    const glyphs = Object.values(LANE_MARKS).map((m) => m.glyph);
    expect(new Set(glyphs).size).toBe(4);
    const labels = Object.values(LANE_MARKS).map((m) => m.label);
    expect(new Set(labels).size).toBe(4);
    expect(LANE_MARKS.decide.dot).toBe(LANE_MARKS.review.dot);
    expect(LANE_MARKS.decide.glyph).not.toBe(LANE_MARKS.review.glyph);
  });

  it("the amber and muted dots carry a surface-coloured glyph (white on dark-theme amber was 2.24:1)", () => {
    for (const m of [LANE_MARKS.decide, LANE_MARKS.review, LANE_MARKS.read]) {
      expect(m.dot).toContain("text-surface-primary");
      expect(m.dot).not.toContain("text-white");
    }
    expect(LANE_MARKS.waiting.dot).toContain("text-white"); // 5.63 on blue-strong
  });

  it("a question on an APPROVED artifact does not re-lane its row (questions aren't rows)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(research("ok", "Audit done", "approved"));
    useArtifactStore.setState({ comments: { ok: [question("q1", "ok")] } } as any);
    render(<ArtifactPanel />);
    expect(rowDot("Audit done").textContent).toBe("✓");
  });

  it("the detail header chip wears the same lane glyph as the row", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(decision("dec", "Which store backs the cache?"));
    s.selectArtifact("dec");
    render(<ArtifactPanel />);
    const chip = screen.getAllByText(/Draft, awaiting review/).find((el) => el.className.includes("rounded"))!;
    expect(chip.textContent?.startsWith("▲ ")).toBe(true);
  });
});

describe("#430 PR 4 — collapsed sidebar", () => {
  it.each(EXPECTED)("%s → collapsed button names the lane; badge shows %s", (title, glyph, label) => {
    seedAllLanes();
    usePreferencesStore.setState({ sidebarCollapsed: true } as any);
    render(<ArtifactPanel />);
    const btn = screen.getAllByRole("button").find((b) => (b.getAttribute("aria-label") ?? "").includes(`: ${title} — `))!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")!.endsWith(` — ${label}`)).toBe(true);
    expect(btn.getAttribute("title")).toBe(btn.getAttribute("aria-label"));
    const badge = within(btn).getByLabelText(label);
    expect(badge.textContent).toBe(glyph);
  });
});

describe("#430 PR 4 — parity: the sidebar glyph matches the bar's lane for the same item", () => {
  const renderBoth = () => {
    usePreferencesStore.setState({ nextUpBar: true } as any);
    return render(<><NextUpBar /><ArtifactPanel /></>);
  };

  it("every row equals laneMarksFrom(the bar's own computeAttention input), incl. comments", () => {
    seedAllLanes();
    const comments = { ok: [question("q1", "ok")], dec: [question("q2", "dec")] };
    useArtifactStore.setState({ comments } as any);
    renderBoth();
    const { artifacts } = useArtifactStore.getState();
    const marks = laneMarksFrom(computeAttention({ artifacts, comments }));
    for (const a of artifacts) {
      const dot = rowDot(a.title);
      const m = marks[a.id];
      if (m) {
        expect([a.title, dot.textContent, dot.getAttribute("aria-label")]).toEqual([a.title, m.glyph, m.label]);
      } else {
        expect(Object.values(LANE_MARKS).map((x) => x.glyph)).not.toContain(dot.textContent);
      }
    }
  });

  it("the bar's primary glyph is the next item's row glyph (decision next → ▲; review next → ●)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(research("rev", "Refresh isn't coalesced"));
    s.addArtifact(decision("dec", "Which store backs the cache?"));
    renderBoth();
    const barGlyph = () => screen.getByTestId("next-up-bar").getAttribute("data-line")!.split(" ")[0];
    // Oldest-first: the research draft is next.
    expect(barGlyph()).toBe("●");
    expect(rowDot("Refresh isn't coalesced").textContent).toBe(barGlyph());
    expect(rowDot("Which store backs the cache?").textContent).toBe("▲");
  });

  it("waiting primary: the bar's ◌ is the revised row's ◌", () => {
    useArtifactStore.getState().addArtifact(research("wai", "Backfill plan", "revised"));
    renderBoth();
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")!.startsWith("◌ ")).toBe(true);
    expect(rowDot("Backfill plan").textContent).toBe("◌");
  });

  it("every item in the bar's expanded queue sits in the matching lane in the sidebar", () => {
    seedAllLanes();
    renderBoth();
    fireEvent.click(screen.getByRole("button", { name: "Expand next-up details" }));
    const bar = screen.getByTestId("next-up-bar");
    const section = (heading: RegExp) =>
      within(within(bar).getByText(heading).parentElement!).queryAllByRole("button").map((b) => b.textContent!);
    const decide = section(/^Decide \(/);
    const waiting = section(/^Waiting on Claude \(/);
    const read = section(/^Read \(/);
    expect(decide.length).toBe(3);
    for (const title of decide) expect(["▲", "●"]).toContain(rowDot(title).textContent);
    expect(rowDot("Which store backs the cache?").textContent).toBe("▲");
    expect(waiting).toEqual(["Backfill plan"]);
    expect(rowDot("Backfill plan").textContent).toBe("◌");
    expect(read.sort()).toEqual(["How refresh works", "Single-flight instead of a lock"]);
    for (const title of read) expect(rowDot(title).textContent).toBe("○");
  });
});
