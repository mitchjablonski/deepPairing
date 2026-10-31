import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { claimSectionKey } from "@deeppairing/shared";
import { debriefArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { DebriefClaims } from "../artifacts/DebriefClaims";
import { DebriefArtifact } from "../artifacts/DebriefArtifact";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useReplayStore } from "../../stores/replay";
import { CLAIM_COPY } from "../../lib/debriefClaims";
import { buildBriefExceptionIndex } from "../../lib/briefExceptions";

/**
 * #572 slice B1 — the debrief's "agent's account" block. Fakes, not mocks:
 * the real stores, fed artifacts the way the WS paths deliver them.
 * Contract: #572 comments 6546521744 + 6546678897 (addendum clauses 2, 3, 6, 7
 * and Sol's display rows of the adversarial matrix).
 */
const now = "2026-10-31T00:00:00.000Z";
const art = (over: Record<string, unknown>): Artifact => ({
  sessionId: "s1", version: 1, parentId: null, status: "draft", agentReasoning: null,
  createdAt: now, updatedAt: now, title: "t", content: {}, ...over,
}) as unknown as Artifact;
const BRIEF = { objective: "Ship auth", requirements: [{ id: "REQ-1", statement: "login" }, { id: "REQ-2", statement: "reset" }] };
const brief = (id: string, over: Record<string, unknown> = {}) => art({ id, type: "spec", title: "Auth brief", status: "approved", content: BRIEF, ...over });
const CHECK = { kind: "check", ran: "pnpm vitest run auth", outcome: "passed", sourceRevision: "abc1234" };
const debrief = (over: { briefRef?: unknown; content?: Record<string, unknown>; [k: string]: unknown } = {}) => {
  const { content, ...rest } = over;
  return art({
    id: "d1", type: "debrief", title: "Debrief", presentedBy: "builder:auth",
    content: { summary: "s", requirementClaims: [{ requirementId: "REQ-1", claim: "met", evidence: [CHECK] }], claimsOriginArtifactId: "d1", ...content },
    briefRef: { artifactId: "b1" },
    ...rest,
  });
};

const setArtifacts = (artifacts: Artifact[]) =>
  useArtifactStore.setState({ artifacts } as unknown as Parameters<typeof useArtifactStore.setState>[0]);
const setConnection = (over: Record<string, unknown> = {}) =>
  useConnectionStore.setState({
    connected: true, hydrated: true, hydratedBinding: null, sessionId: "s1", projectRoot: null,
    snapshotUnavailable: false, sessionConflict: false, staleDaemon: false, ...over,
  } as unknown as Parameters<typeof useConnectionStore.setState>[0]);
const setReplay = (over: Record<string, unknown>) =>
  useReplayStore.setState({ active: false, exiting: false, ...over } as unknown as Parameters<typeof useReplayStore.setState>[0]);

const grain = (sectionId: string, label: string) => <span data-testid="grain" data-section={sectionId} data-label={label} />;
const show = (d: Artifact, others: Artifact[] = [brief("b1")]) => {
  setArtifacts([...others, d]);
  return render(<DebriefClaims artifact={d} grain={grain} />);
};
const sections = () => screen.queryAllByTestId("grain").map((g) => g.getAttribute("data-section"));
const FORBIDDEN = /\b(met|done|satisfied|verified|accepted)\b/i;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))));
  useArtifactStore.getState().reset();
  setReplay({});
  setConnection();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("clause 6 — readiness", () => {
  it("hidden in replay and replay-exit recovery", () => {
    setReplay({ active: true });
    show(debrief());
    expect(screen.queryByTestId("debrief-claims")).toBeNull();
    cleanup();
    setReplay({ exiting: true });
    show(debrief());
    expect(screen.queryByTestId("debrief-claims")).toBeNull();
  });

  it("before the current binding hydrates: a loading notice with the raw pin id and no rows", () => {
    setConnection({ hydrated: false });
    show(debrief());
    const block = screen.getByTestId("debrief-claims");
    expect(block).toHaveAttribute("data-state", "loading");
    expect(screen.getByTestId("debrief-claims-raw-pin")).toHaveTextContent("b1");
    expect(screen.queryByTestId("debrief-claim-row")).toBeNull();
    expect(screen.queryByTestId("debrief-claim-none")).toBeNull();
  });

  it("a hydrated flag from ANOTHER binding is not readiness", () => {
    setConnection({ hydratedBinding: "other|binding" });
    show(debrief());
    expect(screen.getByTestId("debrief-claims")).toHaveAttribute("data-state", "loading");
  });

  it("refusal/conflict wins over loading", () => {
    setConnection({ hydrated: false, snapshotUnavailable: true });
    show(debrief());
    expect(screen.getByTestId("debrief-claims")).toHaveAttribute("data-state", "unavailable");
    cleanup();
    setConnection({ hydrated: false, sessionConflict: true });
    show(debrief());
    expect(screen.getByTestId("debrief-claims")).toHaveAttribute("data-state", "unavailable");
  });

  it("a legacy debrief renders no B1 block at all", () => {
    show(art({ id: "d0", type: "debrief", content: { summary: "s" } }));
    expect(screen.queryByTestId("debrief-claims")).toBeNull();
  });
});

describe("ready — the account table", () => {
  it("header names the exact pinned version and status, rows carry agent labels, missing requirements say no claim", () => {
    show(debrief());
    expect(screen.getByTestId("debrief-claims-heading")).toHaveTextContent(`Agent's account against "Auth brief" v1 (approved) — claims, not acceptance`);
    const row = screen.getByTestId("debrief-claim-row");
    expect(row).toHaveTextContent("REQ-1 · agent claims handled");
    const ev = within(row).getByTestId("debrief-claim-evidence");
    expect(ev).toHaveTextContent("[agent-reported · source abc1234]");
    expect(ev).toHaveTextContent("ran pnpm vitest run auth: passed");
    expect(within(row).queryByTestId("debrief-claim-no-check")).toBeNull();
    const none = screen.getByTestId("debrief-claim-none");
    expect(none).toHaveTextContent("REQ-2 · no claim");
    expect(sections()).toEqual([`debrief:claim:REQ-1`, `debrief:claim:REQ-2`, "debrief:claims"]);
  });

  it("unmet / unknown / not-run / partial run keep their distinctions; source-only proof says no check reported", () => {
    show(debrief({ content: { requirementClaims: [
      { requirementId: "REQ-1", claim: "met", evidence: [{ ...CHECK, outcome: "partial", sourceRevision: undefined, runId: "ci-42" }], notRun: "e2e suite not run: no browser" },
      { requirementId: "REQ-2", claim: "unknown", evidence: [{ kind: "source", evidence: { filePath: "auth/reset.ts", lineStart: 3, lineEnd: 9, snippet: "send()", explanation: "the reset path" } }] },
    ] } }));
    const [r1, r2] = screen.getAllByTestId("debrief-claim-row");
    expect(r1).toHaveTextContent("[agent-reported · source version unknown · run ci-42]");
    expect(r1).toHaveTextContent(": partial");
    expect(within(r1!).getByTestId("debrief-claim-not-run")).toHaveTextContent("not run: e2e suite not run: no browser");
    expect(r2).toHaveTextContent("REQ-2 · agent unsure");
    expect(r2).toHaveTextContent("auth/reset.ts:3-9");
    expect(within(r2!).getByTestId("debrief-claim-no-check")).toHaveTextContent("no check reported");
    expect(screen.queryByTestId("debrief-claim-none")).toBeNull();
  });

  it("unknown and ambiguous requirement ids are marked, never positionally matched", () => {
    const b = brief("b1", { content: { objective: "o", requirements: [{ id: "REQ-1" }, { id: "REQ-1" }, { statement: "id-less" }] } });
    show(debrief({ content: { requirementClaims: [
      { requirementId: "REQ-1", claim: "met", evidence: [CHECK] },
      { requirementId: "2", claim: "met", evidence: [CHECK] },
    ] } }), [b]);
    const rows = screen.getAllByTestId("debrief-claim-row");
    expect(rows.map((r) => r.getAttribute("data-match"))).toEqual(["ambiguous", "unknown"]);
    expect(screen.queryByTestId("debrief-claim-none")).toBeNull();
    expect(screen.getByTestId("debrief-claims-idless")).toHaveTextContent("3 requirement rows");
  });
});

describe("clause 3 — pin availability is unique and session-local", () => {
  const unattributedOnly = () => {
    expect(screen.getAllByTestId("debrief-claim-row").every((r) => r.getAttribute("data-match") === "unattributed")).toBe(true);
    expect(screen.queryByTestId("debrief-claim-none")).toBeNull();
  };

  it("missing brief: raw id, version unknown, claim text preserved, no coverage rows", () => {
    show(debrief(), []);
    expect(screen.getByTestId("debrief-claims-pin")).toHaveTextContent("b1: brief unavailable here (version unknown)");
    expect(screen.getByTestId("debrief-claim-evidence")).toHaveTextContent("pnpm vitest run auth");
    unattributedOnly();
  });

  it("a duplicate id across types in the session is unavailable, never first-match", () => {
    show(debrief(), [brief("b1"), art({ id: "b1", type: "decision", title: "imposter" })]);
    expect(screen.getByTestId("debrief-claims-pin")).toHaveTextContent("brief id is not unique in this session (version unknown)");
    expect(screen.queryByText(/Auth brief/)).toBeNull();
    unattributedOnly();
  });

  it("a same-id spec in ANOTHER session is invisible", () => {
    show(debrief(), [brief("b1", { sessionId: "s2" })]);
    expect(screen.getByTestId("debrief-claims-pin")).toHaveTextContent("brief unavailable here");
    unattributedOnly();
  });

  it("a non-spec target is not a brief", () => {
    show(debrief(), [art({ id: "b1", type: "plan", title: "plan" })]);
    expect(screen.getByTestId("debrief-claims-pin")).toHaveTextContent("linked artifact is not a brief");
  });

  it("brief superseded with a reused requirement id: the account stays on v1, never v2's rows", () => {
    const v1 = brief("b1", { status: "superseded" });
    const v2 = brief("b2", { parentId: "b1", version: 2, content: { objective: "o", requirements: [{ id: "REQ-1" }, { id: "REQ-3" }] } });
    show(debrief(), [v1, v2]);
    expect(screen.getByTestId("debrief-claims-heading")).toHaveTextContent(`"Auth brief" v1 (superseded)`);
    expect(screen.getByTestId("debrief-claims-heading")).toHaveAttribute("data-pin-state", "closed");
    expect(screen.queryByText(/REQ-3/)).toBeNull();
    expect(screen.getByTestId("debrief-claim-none")).toHaveTextContent("REQ-2");
  });

  it("an unreadable or grain-carrying stored pin shows raw, unavailable", () => {
    show(debrief({ briefRef: { artifactId: "b1", requirementIds: ["REQ-1"] } }));
    expect(screen.getByTestId("debrief-claims-pin")).toHaveTextContent("b1: brief link unreadable or out of policy (version unknown)");
    unattributedOnly();
  });

  it("artifact evidence drills in only to a unique same-session artifact; no foreign labels", () => {
    const cs = art({ id: "cs1", type: "changeset", title: "Auth changeset" });
    const foreign = art({ id: "cs2", type: "changeset", title: "Foreign title", sessionId: "s2" });
    show(debrief({ content: { requirementClaims: [{ requirementId: "REQ-1", claim: "met", evidence: [{ kind: "artifact", artifactId: "cs1" }, { kind: "artifact", artifactId: "cs2", note: "theirs" }] }] } }), [brief("b1"), cs, foreign]);
    expect(screen.getByTestId("debrief-claim-artifact")).toHaveTextContent("Auth changeset");
    expect(screen.getByTestId("debrief-claim-artifact-unavailable")).toHaveTextContent("cs2 (artifact unavailable here) — theirs");
    expect(screen.queryByText(/Foreign title/)).toBeNull();
    // artifact-only proof: code changed, nothing more
    expect(screen.getByTestId("debrief-claim-no-check")).toBeInTheDocument();
  });
});

describe("clause 2 — saved diagnostics on reload", () => {
  it("a dropped pin shows as rejected linkage, never a usable pin; claims stay unattributed", () => {
    show(debrief({ briefRef: undefined, content: { briefRefDiagnostic: { attemptedArtifactId: "art_nope", reason: "not_in_session" } } }));
    expect(screen.getByTestId("debrief-claims-heading")).toHaveAttribute("data-pin-state", "rejected");
    expect(screen.getByTestId("debrief-claims-pin")).toHaveTextContent("brief link was rejected when the debrief was presented (art_nope): not an artifact in this session");
    expect(screen.queryByTestId("debrief-claims-open-pin")).toBeNull();
    expect(screen.getByTestId("debrief-claim-row")).toHaveAttribute("data-match", "unattributed");
  });

  it("unreadable saved claims: a diagnostic + raw view, no rows, no coverage, only the block comment target", () => {
    show(debrief({ content: { requirementClaims: [{ requirementId: "REQ-1", claim: "met" }] } }));
    expect(screen.getByTestId("debrief-claims-unreadable")).toHaveAttribute("data-kind", "unreadable");
    expect(screen.getByTestId("debrief-claims-unreadable")).toHaveTextContent('"requirementId": "REQ-1"');
    expect(screen.queryByTestId("debrief-claim-row")).toBeNull();
    expect(screen.queryByTestId("debrief-claim-none")).toBeNull();
    expect(sections()).toEqual(["debrief:claims"]);
  });

  it("duplicate saved claims: a diagnostic, never a first/last winner", () => {
    const c = { requirementId: "REQ-1", claim: "met", evidence: [CHECK] };
    show(debrief({ content: { requirementClaims: [c, { ...c, claim: "unmet" }] } }));
    expect(screen.getByTestId("debrief-claims-unreadable")).toHaveAttribute("data-kind", "duplicate");
    expect(screen.getByTestId("debrief-claims-unreadable")).toHaveTextContent("REQ-1");
    expect(screen.queryByTestId("debrief-claim-row")).toBeNull();
    expect(sections()).toEqual(["debrief:claims"]);
  });
});

describe("clause 4 — original report provenance", () => {
  it("self, carried (with the origin's agent), unavailable and unknown origins", () => {
    show(debrief());
    expect(screen.getByTestId("debrief-claims-origin")).toHaveTextContent("Reported in this version (v1) by builder:auth · agent-reported");
    cleanup();
    const v1 = art({ id: "d0", type: "debrief", presentedBy: "builder:first", status: "superseded", content: { summary: "s" } });
    show(debrief({ version: 2, parentId: "d0", presentedBy: undefined, content: { claimsOriginArtifactId: "d0" } }), [brief("b1"), v1]);
    expect(screen.getByTestId("debrief-claims-origin")).toHaveTextContent("Reported in v1 (d0) by builder:first; carried unchanged onto this v2");
    cleanup();
    show(debrief({ content: { claimsOriginArtifactId: "d_gone" } }));
    expect(screen.getByTestId("debrief-claims-origin")).toHaveTextContent("report origin unavailable here (d_gone)");
    cleanup();
    show(debrief({ content: { claimsOriginArtifactId: undefined } }));
    expect(screen.getByTestId("debrief-claims-origin")).toHaveTextContent("report origin unknown");
  });

  it("no presenter label → agent unknown, never a guessed agent", () => {
    show(debrief({ presentedBy: undefined }));
    expect(screen.getByTestId("debrief-claims-origin")).toHaveTextContent("by agent unknown");
  });
});

describe("clause 7 — copy, escaping, comment keys", () => {
  it("authored labels never use met/done/satisfied/verified/accepted", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => { if (typeof v === "string") strings.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
    walk(CLAIM_COPY);
    for (const s of strings) expect(s, s).not.toMatch(FORBIDDEN);
    // …and the rendered block, fed neutral agent text in every state shape.
    show(debrief({ content: { requirementClaims: [
      { requirementId: "REQ-1", claim: "met", evidence: [CHECK, { kind: "observation", text: "login ok" }, { kind: "artifact", artifactId: "missing" }], notRun: "load test", explanation: "ok" },
      { requirementId: "REQ-9", claim: "unmet", explanation: "out of scope" },
    ] } }));
    expect(screen.getByTestId("debrief-claims").textContent).not.toMatch(FORBIDDEN);
  });

  it("agent text is NOT scanned: 'verified' / 'met' / 'accepted' in evidence stay inspectable", () => {
    show(debrief({ content: { requirementClaims: [{ requirementId: "REQ-1", claim: "met", evidence: [{ kind: "observation", text: "QA verified it; criteria met and accepted" }] }] } }));
    expect(screen.getByTestId("debrief-claim-evidence")).toHaveTextContent("QA verified it; criteria met and accepted");
  });

  it("hostile ids and evidence render as text; row comment keys are escaped", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    show(debrief({ content: { requirementClaims: [{ requirementId: evil, claim: "unknown", notRun: "<script>x</script>", evidence: [{ kind: "source", evidence: { snippet: "s", explanation: "e", locator: { kind: "url", value: "javascript:alert(1)", href: "javascript:alert(1)" } } }] }] } }));
    const block = screen.getByTestId("debrief-claims");
    expect(block.querySelector("img, script, a[href]")).toBeNull();
    expect(block).toHaveTextContent(evil);
    expect(sections()).toContain(`debrief:claim:${claimSectionKey(evil)}`);
    expect(claimSectionKey(evil)).not.toMatch(/[<>= ]/);
  });
});

describe("unchanged surfaces", () => {
  it("the A2 exception index ignores a debrief pinned to the brief", () => {
    const b = brief("b1");
    const index = buildBriefExceptionIndex([b, debrief()], "b1", "s1");
    expect(index.total).toBe(0);
    expect(index.entries).toEqual([]);
  });

  it("a legacy debrief renders exactly as before inside DebriefArtifact (no B1 block)", () => {
    vi.stubGlobal("IntersectionObserver", class { cb: any; constructor(cb: any) { this.cb = cb; } observe() { this.cb([{ isIntersecting: true }]); } disconnect() {} unobserve() {} } as any);
    useArtifactStore.getState().addArtifact(debriefArtifact);
    render(<DebriefArtifact artifact={debriefArtifact} />);
    expect(screen.queryByTestId("debrief-claims")).toBeNull();
  });

  it("inside DebriefArtifact the block sits after the summary and keeps the read-only lock", () => {
    vi.stubGlobal("IntersectionObserver", class { cb: any; constructor(cb: any) { this.cb = cb; } observe() { this.cb([{ isIntersecting: true }]); } disconnect() {} unobserve() {} } as any);
    const d = debrief({ status: "retracted" });
    setArtifacts([brief("b1"), d]);
    render(<DebriefArtifact artifact={d} />);
    const block = screen.getByTestId("debrief-claims");
    expect(within(block).queryByRole("button", { name: /Comment on claim/ })).toBeNull();
    expect(screen.getByText("What we built").compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
