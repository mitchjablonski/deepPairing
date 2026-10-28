import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { GoverningBriefStrip } from "../GoverningBriefStrip";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { computeAttention } from "../../lib/attention";
import { computePending } from "../../lib/pending";
import { selectGoverningBrief } from "../../lib/governingBrief";

/**
 * #572 slice A2 — the brief's linked exception lists and the strip's count.
 * Fakes, not mocks: the real stores, fed artifacts as the WS paths deliver.
 * Readiness: hidden in replay and replay-exit; "loading" until the current
 * binding hydrates (never a transient exhaustive zero); "unavailable" on a
 * refused snapshot / session conflict.
 */
const now = "2026-10-27T00:00:00.000Z";
const art = (over: Record<string, unknown>): Artifact => ({
  sessionId: "s1", version: 1, parentId: null, status: "draft", agentReasoning: null,
  createdAt: now, updatedAt: now, title: "t", content: {}, ...over,
}) as unknown as Artifact;
const BRIEF_CONTENT = {
  objective: "Ship the auth flow",
  context: "Decide alone: layout\nReview: packet",
  requirements: [{ id: "REQ-1", text: "one" }, { id: "REQ-2", text: "two" }],
  tasks: [{ description: "t0", status: "in_progress" }, { description: "t1", status: "pending" }],
};
const brief = (id: string, over: Record<string, unknown> = {}) =>
  art({ id, type: "spec", title: "Auth brief", status: "approved", content: BRIEF_CONTENT, ...over });
const card = (id: string, briefRef: unknown, over: Record<string, unknown> = {}) =>
  art({ id, type: "decision", title: `Card ${id}`, content: { context: "c", decisionId: `dec_${id}`, options: [] }, ...(briefRef !== undefined ? { briefRef } : {}), ...over });

const setArtifacts = (artifacts: Artifact[]) =>
  useArtifactStore.setState({ artifacts } as unknown as Parameters<typeof useArtifactStore.setState>[0]);
const setConnection = (over: Record<string, unknown> = {}) =>
  useConnectionStore.setState({
    connected: true, hydrated: true, hydratedBinding: null, sessionId: "s1", projectRoot: null,
    snapshotUnavailable: false, sessionConflict: false, staleDaemon: false, ...over,
  } as unknown as Parameters<typeof useConnectionStore.setState>[0]);
const visible = () => useArtifactStore.getState().artifacts.filter((a) => a.status !== "superseded");
const renderStrip = () => render(<GoverningBriefStrip artifacts={visible()} />);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  useReplayStore.setState({ active: false, exiting: false } as unknown as Parameters<typeof useReplayStore.setState>[0]);
  setConnection();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#572 A2 — linked exception cards on the brief", () => {
  it("lists per requirement, once in the total, with a qualified summary", () => {
    const b = brief("b1");
    setArtifacts([
      b,
      card("d1", { artifactId: "b1", requirementIds: ["REQ-1", "REQ-2"] }, { status: "superseded" }),
      card("d2", { artifactId: "b1", requirementIds: ["REQ-1", "REQ-2"] }, { parentId: "d1", status: "revised" }),
      card("d3", { artifactId: "b1" }, { status: "approved" }),
      card("d4", { artifactId: "b1", requirementIds: ["REQ-9"] }),
    ]);
    render(<SpecArtifact artifact={b} />);
    const section = screen.getByTestId("brief-exceptions");
    expect(within(section).getByTestId("brief-exceptions-summary")).toHaveTextContent("3 linked exception lineages in this view");
    // Exact terminal statuses: revised is its own status (never an open
    // ancestor); approved is a resolved card, its choice unverified.
    expect(within(section).getByTestId("brief-exceptions-buckets")).toHaveTextContent("1 draft · 1 approved · choice unverified · 1 revised");
    expect(section.textContent).not.toMatch(/awaiting selection|saving selection|selected/i);
    const reqGroups = within(section).getAllByTestId("brief-exceptions-requirement");
    expect(reqGroups.map((g) => g.querySelector("summary")!.textContent)).toEqual(["REQ-1 (1)", "REQ-2 (1)"]);
    expect(within(reqGroups[0]!).getAllByTestId("brief-exception-entry").map((e) => e.getAttribute("data-decision-id"))).toEqual(["d2"]);
    expect(within(section).getByTestId("brief-exceptions-brief-level")).toHaveTextContent("Card d3");
    // An unknown grain counts in the total but is unattributed, never under a requirement.
    const un = within(section).getByTestId("brief-exceptions-unattributed");
    expect(un).toHaveTextContent("Card d4");
    expect(un).toHaveTextContent("REQ-9 (unknown)");
    expect(section.textContent).not.toMatch(/requirement(s)? met|satisf|safe to proceed/i);
  });

  it("an old-version pin is labelled \"raised against v1\" on v2 and opens the EXACT v1", () => {
    const v1 = brief("b1", { status: "superseded" });
    const v2 = brief("b2", { parentId: "b1", version: 2 });
    setArtifacts([v1, v2, card("d1", { artifactId: "b1", requirementIds: ["REQ-1"] })]);
    render(<SpecArtifact artifact={v2} />);
    expect(screen.queryAllByTestId("brief-exceptions-requirement")).toEqual([]);
    const hist = screen.getByTestId("brief-exceptions-historical");
    expect(hist.querySelector("summary")).toHaveTextContent("Raised against v1 · REQ-1 (1)");
    expect(within(hist).getByTestId("brief-exception-entry")).toHaveTextContent("raised against v1");
    fireEvent.click(within(hist).getByTestId("brief-exceptions-open-pinned"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("b1"); // not the successor
    fireEvent.click(within(hist).getByTestId("brief-exception-entry"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1");
  });

  it("exact navigation to a superseded card stays on that card", () => {
    const b = brief("b1");
    setArtifacts([b, card("d1", { artifactId: "b1" }, { status: "superseded" })]);
    render(<SpecArtifact artifact={b} />);
    fireEvent.click(screen.getByTestId("brief-exception-entry"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("d1");
  });

  it("unavailable / unreadable refs are never counted; the empty text is qualified", () => {
    const b = brief("b1");
    setArtifacts([b, card("d1", { artifactId: "b_gone" }), card("d2", { artifactId: "b1", requirementIds: "REQ-1" })]);
    render(<SpecArtifact artifact={b} />);
    expect(screen.getByTestId("brief-exceptions-summary")).toHaveTextContent("No linked exception cards in this view · 1 unreadable link not counted");
    expect(screen.queryAllByTestId("brief-exception-entry")).toEqual([]);
    expect(screen.getByTestId("brief-exceptions-unreadable")).toHaveTextContent("d2");
  });

  it("another session's cards with the same ids are excluded, and a session switch recounts", () => {
    const b = brief("b1");
    setArtifacts([b, card("d1", { artifactId: "b1" }), card("d9", { artifactId: "b1" }, { sessionId: "s2" })]);
    const r = render(<SpecArtifact artifact={b} />);
    expect(screen.getAllByTestId("brief-exception-entry").map((e) => e.getAttribute("data-decision-id"))).toEqual(["d1"]);
    r.unmount();
    // Switch: the store resets and the new session's frame arrives.
    act(() => { useArtifactStore.getState().reset(); setConnection({ sessionId: "s2" }); });
    const b2 = brief("b1", { sessionId: "s2" });
    act(() => setArtifacts([b2, card("d9", { artifactId: "b1" }, { sessionId: "s2" })]));
    render(<SpecArtifact artifact={b2} />);
    expect(screen.getAllByTestId("brief-exception-entry").map((e) => e.getAttribute("data-decision-id"))).toEqual(["d9"]);
  });

  it("agent text is rendered as text", () => {
    const b = brief("b1");
    setArtifacts([b, card("d1", { artifactId: "b1" }, { title: "<img src=x onerror=alert(1)>" })]);
    const { container } = render(<SpecArtifact artifact={b} />);
    expect(screen.getByTestId("brief-exception-entry")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("#572 A2 — hydration and replay", () => {
  it("hydration order: loading (never a zero) until the binding hydrates, then the counts", () => {
    setConnection({ hydrated: false });
    const b = brief("b1");
    setArtifacts([b]);
    render(<><SpecArtifact artifact={b} /><GoverningBriefStrip artifacts={visible()} /></>);
    expect(screen.getByTestId("brief-exceptions")).toHaveAttribute("data-state", "loading");
    expect(screen.getByTestId("governing-brief-exceptions")).toHaveTextContent("Linked exceptions loading…");
    expect(document.body.textContent).not.toContain("No linked exception cards");
    // The card arrives in the snapshot, then hydration is recorded.
    act(() => setArtifacts([b, card("d1", { artifactId: "b1", requirementIds: ["REQ-1"] })]));
    expect(document.body.textContent).not.toContain("linked exception lineage");
    act(() => setConnection({ hydrated: true }));
    expect(screen.getByTestId("brief-exceptions-summary")).toHaveTextContent("1 linked exception lineage in this view");
    expect(screen.getByTestId("governing-brief-exceptions")).toHaveTextContent("1 linked exception lineage in this view · 1 draft");
  });

  it("hydration evidence for ANOTHER binding is not readiness", () => {
    setConnection({ hydrated: true, hydratedBinding: "s0@/elsewhere", sessionId: "s1", projectRoot: "/here" });
    const b = brief("b1");
    setArtifacts([b]);
    render(<SpecArtifact artifact={b} />);
    expect(screen.getByTestId("brief-exceptions")).toHaveAttribute("data-state", "loading");
  });

  it("a refused snapshot or session conflict says unavailable, not zero", () => {
    for (const flag of ["snapshotUnavailable", "sessionConflict"]) {
      setConnection({ [flag]: true });
      const b = brief("b1");
      setArtifacts([b]);
      render(<SpecArtifact artifact={b} />);
      expect(screen.getByTestId("brief-exceptions")).toHaveAttribute("data-state", "unavailable");
      cleanup();
      setConnection();
    }
  });

  it("hidden during replay and replay-exit recovery; the strip itself is unchanged", () => {
    const b = brief("b1");
    setArtifacts([b, card("d1", { artifactId: "b1" })]);
    for (const replay of [{ active: true, exiting: false }, { active: false, exiting: true }]) {
      useReplayStore.setState(replay as unknown as Parameters<typeof useReplayStore.setState>[0]);
      render(<><SpecArtifact artifact={b} /><GoverningBriefStrip artifacts={visible()} /></>);
      expect(screen.queryByTestId("brief-exceptions")).toBeNull();
      expect(screen.queryByTestId("governing-brief-exceptions")).toBeNull();
      expect(screen.getByTestId("governing-brief-title")).toHaveTextContent("Auth brief");
      cleanup();
    }
  });
});

describe("#572 A2 — the governing-brief strip", () => {
  it("shows the SAME distinct-lineage count as the brief, with selection unchanged", () => {
    const b = brief("b1");
    const arts = [
      b,
      card("d1", { artifactId: "b1", requirementIds: ["REQ-1"] }, { status: "superseded" }),
      card("d2", { artifactId: "b1", requirementIds: ["REQ-1"] }, { parentId: "d1", status: "rejected" }),
      card("d3", { artifactId: "b1", requirementIds: ["REQ-1", "REQ-2"] }),
    ];
    setArtifacts(arts);
    const selectedBefore = selectGoverningBrief(visible(), arts);
    render(<><SpecArtifact artifact={b} /><GoverningBriefStrip artifacts={visible()} /></>);
    expect(screen.getByTestId("brief-exceptions-summary")).toHaveTextContent("2 linked exception lineages in this view");
    expect(screen.getByTestId("governing-brief-exceptions")).toHaveTextContent("2 linked exception lineages in this view · 1 draft");
    expect(selectGoverningBrief(visible(), useArtifactStore.getState().artifacts)).toEqual(selectedBefore);
    fireEvent.click(screen.getByTestId("governing-brief-open"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("b1");
  });

  it("an empty strip count is qualified, never \"no exceptions\"", () => {
    setArtifacts([brief("b1")]);
    renderStrip();
    expect(screen.getByTestId("governing-brief-exceptions")).toHaveTextContent("No linked exception cards in this view");
  });

  it("deriving and rendering the counts changes no attention lane, pending count, unread or resolution state", () => {
    const run = (linked: boolean) => {
      useArtifactStore.getState().reset();
      const b = brief("b1");
      const ref = linked ? { artifactId: "b1", requirementIds: ["REQ-1"] } : undefined;
      setArtifacts([b, card("d1", ref), card("d2", ref, { status: "approved" }), art({ id: "r1", type: "research", content: { summary: "s", findings: [] } })]);
      useArtifactStore.setState({ unreadIds: ["d1", "r1"] } as unknown as Parameters<typeof useArtifactStore.setState>[0]);
      const before = useArtifactStore.getState();
      render(<><SpecArtifact artifact={b} /><GoverningBriefStrip artifacts={visible()} /></>);
      const st = useArtifactStore.getState();
      const out = {
        lanes: Object.fromEntries(Object.entries(computeAttention({ artifacts: st.artifacts, comments: st.comments }).lanes).map(([k, v]) => [k, (v as unknown[]).length])),
        pending: computePending(st.artifacts).total,
        unread: [...st.unreadIds],
        resolved: st.resolvedDecisions,
        acknowledged: st.acknowledgedDecisions,
        selected: st.selectedArtifactId,
        sameArtifacts: st.artifacts === before.artifacts,
      };
      cleanup();
      return out;
    };
    const linked = run(true);
    const unlinked = run(false);
    expect(linked).toEqual(unlinked);
    expect(linked.sameArtifacts).toBe(true);
    expect(linked.unread).toEqual(["d1", "r1"]);
  });
});
