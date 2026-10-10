/**
 * #470 slice 2 — §10 "Web": the Allow-once dialog (semantics, focus, keys,
 * errors, preview), placement and hit targets, the Retire confirm, the
 * single announcer, receipt states, the "changed" linkage, the #430 fit, and
 * offline gating. A small fake daemon answers fetch (the existing web-test
 * pattern); stores are the real zustand stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StanceAllowanceReceipt } from "@deeppairing/shared";
import { AllowOnceDialogHost } from "../AllowOnceDialog";
import { ToastLayer } from "../ToastLayer";
import { PreflightBlockLog } from "../PreflightBlockLog";
import { NextUpBar } from "../NextUpBar";
import { AllowedOnceBadge, AllowedOnceSection, LedgerAllowances } from "../AllowedOnce";
import { useAllowOnceStore } from "../../stores/allowOnce";
import { useToastStore } from "../../stores/toast";
import { usePreflightBlockStore, unreadBlockCount, type PreflightBlockRecord } from "../../stores/preflightBlocks";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { useAnnounceStore } from "../../stores/announce";
import { useReplayStore } from "../../stores/replay";
import { useConnectionGraceStore } from "../../lib/connectionGrace";
import { OFFLINE_ACT_REASON } from "../../hooks/useOfflineReason";
import { hasUnsavedText } from "../../lib/unsavedText";
import { REASON_HINT, SCOPE_SENTENCE, receiptLabel, resetAnnouncedGrantsForTests } from "../../lib/stanceException";

const CODE_PREVIEW = {
  blockId: "blk_1", source: "session", toolName: "present_code_change", eligible: true,
  stance: { description: "global mutable state", concept: "global mutable state" },
  snapshot: { kind: "create", type: "code_change", title: "modify src/config.ts",
    content: { filePath: "src/config.ts", changeType: "modify", before: "let config = {};", after: "export function loadConfig() {}", reasoning: "Remove global mutable state" } },
  preconditions: [{ kind: "code_change_prior", filePath: "src/config.ts", priorCodeChangeId: "art_prior", priorAfterHash: "h" }],
};
const DECISION_PREVIEW = {
  ...CODE_PREVIEW, toolName: "present_options", preconditions: [],
  snapshot: { kind: "create", type: "decision", title: "Config owner", content: { context: "Who owns config?", options: [
    { id: "a", title: "Inject", description: "pass it", pros: ["testable"], cons: ["churn"] },
    { id: "b", title: "Keep", description: "as is", pros: ["no churn"], cons: ["hard to test"] },
  ] } },
};

interface Call { url: string; method: string; body?: unknown }
function fakeDaemon(opts: { preview?: unknown; grantStatus?: number; grantError?: string } = {}) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined });
    if (url.includes("/exception") && method === "GET") return opts.preview === null ? json({ error: "x" }, 404) : json(opts.preview ?? CODE_PREVIEW);
    if (url.includes("/exception") && method === "POST") {
      const status = opts.grantStatus ?? 201;
      return status < 300 ? json({ allowance: { id: "sx_1", state: "allowed" } }, status) : json({ error: opts.grantError ?? "nope" }, status);
    }
    if (url.includes("/revoke")) return json({ allowance: { id: "sx_1", state: "revoked" } });
    if (url.includes("/api/philosophy/override")) return json({ status: "overridden", retired: 1 });
    return json({});
  }));
  return calls;
}
const grants = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.includes("/exception"));

let t = 0;
const at = () => `2026-06-01T00:${String(t++).padStart(2, "0")}:00.000Z`;
const block = (over: Partial<PreflightBlockRecord> = {}): PreflightBlockRecord => ({
  id: `b${t}`, serverId: `blk_${t}`, at: at(), source: "session", concept: "global mutable state",
  proposal: "Remove global mutable state", via: "surface", eligible: true, ...over,
});
const receipt = (over: Partial<StanceAllowanceReceipt> = {}): StanceAllowanceReceipt => ({
  id: "sx_1", grantedVia: "ui", grantedAt: "2026-06-01T01:00:00.000Z", reason: "false positive", ceilingAt: "2026-06-04T01:00:00.000Z", state: "allowed", ...over,
});

function openDialog(opener?: HTMLElement) {
  act(() => useAllowOnceStore.getState().open({ blockId: "blk_1", concept: "global mutable state", returnFocusTo: opener }));
}

beforeEach(() => {
  resetAnnouncedGrantsForTests();
  t = 0;
  useAllowOnceStore.setState({ request: null });
  useToastStore.getState().dismissAll();
  usePreflightBlockStore.setState({ blocks: [], lastSeenAt: null, loaded: true, focusRequest: null } as any);
  useArtifactStore.getState().reset();
  useReplayStore.setState({ active: false } as any);
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false, disconnectedSince: null } as any);
  usePreferencesStore.setState({ nextUpBar: false });
  useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
});
afterEach(() => {
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("§10 Web — dialog semantics", () => {
  it("role=dialog, aria-modal, labelled by the heading that names the stance, described by the scope sentence", async () => {
    fakeDaemon();
    render(<AllowOnceDialogHost />);
    openDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)).toHaveTextContent("Allow one proposal past 'global mutable state'");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)).toHaveTextContent(SCOPE_SENTENCE);
    await screen.findByTestId("allow-once-diff");
  });
});

describe("§10 Web — focus", () => {
  it("initial focus is the HEADING; Tab / Shift-Tab cycle preview → reason → Allow once → Cancel inside; close returns focus to the opener", async () => {
    fakeDaemon();
    render(<><button>opener</button><AllowOnceDialogHost /></>);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    openDialog(opener);
    expect(screen.getByRole("heading", { name: /Allow one proposal past/ })).toHaveFocus();
    await screen.findByTestId("allow-once-diff");
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByTestId("allow-once-preview")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox")).toHaveFocus();
    await user.type(screen.getByRole("textbox"), "valid reason");
    await user.tab();
    expect(screen.getByRole("button", { name: "Allow once" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab(); // the trap wraps
    expect(screen.getByTestId("allow-once-preview")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("§10 Web — keys", () => {
  it("Enter with a valid reason confirms (one POST, the trimmed reason)", async () => {
    const calls = fakeDaemon();
    render(<AllowOnceDialogHost />);
    openDialog();
    await screen.findByTestId("allow-once-diff");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "  this removes it  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(grants(calls)).toHaveLength(1));
    expect(grants(calls)[0]!.body).toEqual({ reason: "this removes it" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each(["", "ab", "     "])("Enter with reason %j does nothing, and the hint is announced", async (value) => {
    const calls = fakeDaemon();
    render(<AllowOnceDialogHost />);
    openDialog();
    await screen.findByTestId("allow-once-diff");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(grants(calls)).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useAnnounceStore.getState().message).toBe(REASON_HINT);
    expect(box).toHaveAttribute("aria-invalid", "true");
  });

  it("Esc cancels and sends no request", async () => {
    const calls = fakeDaemon();
    render(<AllowOnceDialogHost />);
    openDialog();
    await screen.findByTestId("allow-once-diff");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "valid reason" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(grants(calls)).toHaveLength(0);
  });
});

describe("§10 Web — errors", () => {
  it.each([[503, "busy"], [409, "That stance is no longer on file"]])("a %s keeps the dialog open with the message in role=alert", async (status, message) => {
    fakeDaemon({ grantStatus: status, grantError: message });
    render(<AllowOnceDialogHost />);
    openDialog();
    await screen.findByTestId("allow-once-diff");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "valid reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(screen.getByTestId("allow-once-error")).toHaveTextContent(message));
    expect(screen.getByTestId("allow-once-error")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("§10 Web — preview", () => {
  it("a code_change renders the diff and the `before` precondition line", async () => {
    fakeDaemon();
    render(<AllowOnceDialogHost />);
    openDialog();
    const diff = await screen.findByTestId("allow-once-diff");
    expect(diff).toHaveTextContent("- let config = {};");
    expect(diff).toHaveTextContent("+ export function loadConfig() {}");
    expect(screen.getByTestId("allow-once-precondition")).toHaveTextContent("`before` comes from art_prior (your last change to src/config.ts)");
    expect(screen.getByText(/if art_prior changes first, this allowance won't apply/)).toBeInTheDocument();
  });

  it("a decision renders every option with its pros and cons", async () => {
    fakeDaemon({ preview: DECISION_PREVIEW });
    render(<AllowOnceDialogHost />);
    openDialog();
    const d = await screen.findByTestId("allow-once-decision");
    expect(d).toHaveTextContent("Pros: testable");
    expect(d).toHaveTextContent("Cons: hard to test");
  });

  it("a block the daemon no longer holds can't be allowed (no enabled confirm)", async () => {
    fakeDaemon({ preview: null });
    render(<AllowOnceDialogHost />);
    openDialog();
    await screen.findByText(/session has ended/);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  });
});

describe("§10 Web — placement, targets and auto-dismiss", () => {
  it("the gate-log entry carries the primary Allow once and a secondary 32px Retire…; the toast's auto-dismiss pauses on hover and while its dialog is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeDaemon();
    usePreflightBlockStore.setState({ blocks: [block({ serverId: "blk_1" })] } as any);
    render(<><PreflightBlockLog /><ToastLayer /><AllowOnceDialogHost /></>);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    const allow = screen.getByRole("button", { name: "Allow once" });
    const retire = screen.getByRole("button", { name: "Retire…" });
    for (const b of [allow, retire]) expect(b.className).toMatch(/min-h-\[32px\] min-w-\[32px\]/);

    let id = "";
    act(() => { id = useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 1000, hero: { source: "session", concept: "global mutable state", via: "surface", blockId: "blk_1", eligible: true } }); });
    const card = screen.getByRole("button", { name: "Allow this proposal once" }).closest(".pointer-events-auto")!;
    fireEvent.mouseEnter(card);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(useToastStore.getState().toasts.some((x) => x.id === id)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Allow this proposal once" }));
    fireEvent.mouseLeave(card);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(useToastStore.getState().toasts.some((x) => x.id === id)).toBe(true); // dialog still open
    act(() => useAllowOnceStore.getState().close());
    // Focus returned to the toast's own button (it holds while focused); move on.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(useToastStore.getState().toasts.some((x) => x.id === id)).toBe(false);
  });

  it("ineligible block types show no Allow-once button, with an honest line", () => {
    fakeDaemon();
    usePreflightBlockStore.setState({ blocks: [block({ toolName: "present_findings", eligible: false, ineligibleReason: "unsupported_tool" })] } as any);
    render(<PreflightBlockLog />);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    expect(screen.queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    expect(screen.getByTestId("gate-ineligible")).toHaveTextContent("isn't available for this kind of proposal yet");
  });
});

describe("§10 Web — the Retire confirm", () => {
  it("Retire… opens a confirm focused on Cancel; Enter right away and Esc both leave the stance intact; only Retire sends", async () => {
    const calls = fakeDaemon();
    usePreflightBlockStore.setState({ blocks: [block()] } as any);
    render(<PreflightBlockLog />);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retire…" }));
    expect(screen.getByTestId("retire-confirm")).toHaveTextContent("Retire 'global mutable state'? This deletes the stance from this project. It stops blocking everywhere, not just here.");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("retire-confirm")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retire…" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("retire-confirm")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Recent gate blocks" })).toBeInTheDocument(); // Esc didn't close the log
    expect(calls.filter((c) => c.url.includes("/api/philosophy/override"))).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Retire…" }));
    await user.click(screen.getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/api/philosophy/override"))).toHaveLength(1));
  });
});

describe("§10 Web — announcements through next-up-announcer", () => {
  it("with the bar on: grant, allowed → used and → changed are spoken by the ONE announcer; the toasts stay quiet", async () => {
    fakeDaemon();
    usePreferencesStore.setState({ nextUpBar: true });
    usePreflightBlockStore.setState({ blocks: [block({ serverId: "blk_1" })] } as any);
    render(<><NextUpBar /><ToastLayer /><AllowOnceDialogHost /></>);
    const announcer = screen.getByTestId("next-up-announcer");
    openDialog();
    await screen.findByTestId("allow-once-diff");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "valid reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(announcer).toHaveTextContent("Allowed once: 'global mutable state'. Waiting for Claude to retry."));
    const { notifyStanceMoment } = await import("../../lib/stanceException");
    act(() => notifyStanceMoment("Claude used your allowance: modify src/config.ts."));
    expect(announcer).toHaveTextContent("Claude used your allowance: modify src/config.ts.");
    act(() => notifyStanceMoment("The proposal you allowed changed. A new block is waiting."));
    expect(announcer).toHaveTextContent("The proposal you allowed changed. A new block is waiting.");
    // No second live region: the stance toasts carry no live role.
    expect(screen.queryAllByRole("status").filter((n) => n !== announcer)).toHaveLength(0);
  });
});

describe("§10 Web — states and the changed linkage", () => {
  it.each([
    ["allowed", "Allowed once (UI) · waiting for Claude to retry"],
    ["used", "Allowed once (UI) · used"],
    ["changed", "Allowed once · changed"],
    ["revoked", "Allowed once · revoked"],
    ["ended", "Allowed once · ended (not used)"],
    ["expired", "Allowed once · expired (not used)"],
  ] as const)("%s renders", (state, text) => {
    fakeDaemon();
    usePreflightBlockStore.setState({ blocks: [block({ allowance: receipt({ state }) })] } as any);
    render(<PreflightBlockLog />);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    expect(screen.getByTestId("gate-receipt")).toHaveTextContent(text);
    expect(receiptLabel(state, "ui")).toBe(text);
  });

  it("changed: the old entry speaks to you and links to the new block, which links back", async () => {
    fakeDaemon();
    const oldBlock = block({ serverId: "blk_old", allowance: receipt({ state: "changed", supersededByBlockId: "blk_new" }) });
    const newBlock = block({ serverId: "blk_new", supersedesAllowanceId: "sx_1", preconditions: [{ kind: "code_change_prior", filePath: "src/config.ts", priorCodeChangeId: "art_x", priorAfterHash: "h" }] });
    usePreflightBlockStore.setState({ blocks: [newBlock, oldBlock] } as any);
    render(<PreflightBlockLog />);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    expect(screen.getByTestId("gate-changed")).toHaveTextContent("The agent's proposal now depends on a newer art_x. Allow the new block if you still want it.");
    fireEvent.click(screen.getByRole("button", { name: "the new block" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("gate-block-blk_new"));
    expect(screen.getByTestId("gate-replaces")).toHaveTextContent("Replaces the proposal you allowed at");
    fireEvent.click(screen.getByRole("button", { name: "the proposal you allowed" }));
    await waitFor(() => expect(document.activeElement?.id).toBe("gate-block-blk_old"));
    // The changed allowance offers neither Allow nor Revoke again.
    expect(screen.getAllByRole("button", { name: "Allow once" })).toHaveLength(1); // the NEW block only
  });
});

describe("§10 Web — fit with #430", () => {
  it("a grant drops Held by one; a dependency-changed refusal's new block raises it by one; revoke/end/expiry don't put it back", () => {
    const b1 = block({ serverId: "blk_1" });
    usePreflightBlockStore.setState({ blocks: [b1] } as any);
    expect(unreadBlockCount(usePreflightBlockStore.getState())).toBe(1);
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", receipt(), "2026-06-01T02:00:00.000Z"));
    expect(unreadBlockCount(usePreflightBlockStore.getState())).toBe(0);
    for (const state of ["revoked", "ended", "expired"] as const) {
      act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", receipt({ state })));
      expect(unreadBlockCount(usePreflightBlockStore.getState())).toBe(0);
    }
    act(() => usePreflightBlockStore.getState().pushBlock({ source: "session", concept: "global mutable state", via: "surface", serverId: "blk_2", supersedesAllowanceId: "sx_1", at: at() }));
    expect(unreadBlockCount(usePreflightBlockStore.getState())).toBe(1);
  });

  it("Held and its Why render NO Allow or Retire control; a seen (allowed) block leaves Held", () => {
    usePreferencesStore.setState({ nextUpBar: true });
    usePreflightBlockStore.setState({ blocks: [block({ serverId: "blk_h" })] } as any);
    const { unmount } = render(<NextUpBar />);
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).toMatch(/HELD/);
    fireEvent.click(screen.getByRole("button", { name: "Why" }));
    expect(screen.queryByRole("button", { name: /allow/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retire/i })).not.toBeInTheDocument();
    unmount();
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_h", receipt(), "2026-06-01T02:00:00.000Z"));
    render(<NextUpBar />);
    expect(screen.getByTestId("next-up-bar").getAttribute("data-line")).not.toMatch(/HELD/);
  });

  it("the admitted artifact's Decide Why line reads 'Admitted under your allowance …'", () => {
    usePreferencesStore.setState({ nextUpBar: true });
    usePreflightBlockStore.setState({ blocks: [block({ serverId: "blk_u", allowance: receipt({ state: "used", reason: "false positive" }) })] } as any);
    useArtifactStore.setState({ artifacts: [{ id: "art_1", sessionId: "s1", type: "code_change", version: 1, parentId: null, title: "modify src/config.ts", status: "draft",
      content: { filePath: "src/config.ts", before: "", after: "x" }, agentReasoning: null, createdAt: at(), updatedAt: at(),
      admission: { operationId: "op", callFingerprint: "f", effectiveDigest: "d", kind: "create", exceptionIds: ["sx_1"], grantedVia: "ui", followUps: {} } }] } as any);
    render(<NextUpBar />);
    expect(screen.getByTitle("Admitted under your allowance (UI) for 'global mutable state': false positive")).toBeInTheDocument();
  });
});

describe("§10 Web — offline (the #487 pattern)", () => {
  it("Allow once is disabled with the reason; the reason you typed is kept and registered as unsaved text", async () => {
    fakeDaemon();
    usePreflightBlockStore.setState({ blocks: [block({ serverId: "blk_1" })] } as any);
    render(<><PreflightBlockLog /><AllowOnceDialogHost /></>);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await screen.findByTestId("allow-once-diff");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed before the outage" } });
    act(() => useConnectionStore.setState({ connected: false, disconnectedSince: Date.now() } as any));
    const confirm = screen.getAllByRole("button", { name: "Allow once" }).find((b) => b.closest("[role=dialog][aria-modal]"))!;
    expect(confirm).toBeDisabled();
    expect(confirm.getAttribute("title")).toBe(OFFLINE_ACT_REASON);
    expect(screen.getByRole("textbox")).toHaveValue("typed before the outage");
    expect(hasUnsavedText()).toBe(true);
    act(() => useConnectionStore.setState({ connected: true, disconnectedSince: null } as any));
    expect(confirm).not.toBeDisabled();
  });
});

describe("receipts that persist: badge, debrief section, Ledger — never 'verified', never a person", () => {
  it("renders the badge, the system debrief section and the Ledger list with Revoke", async () => {
    const calls = fakeDaemon();
    const admitted = { id: "art_1", sessionId: "s1", type: "code_change", version: 1, parentId: null, title: "modify src/config.ts", status: "draft",
      content: {}, agentReasoning: null, createdAt: at(), updatedAt: at(),
      admission: { operationId: "op", callFingerprint: "f", effectiveDigest: "d", kind: "create", exceptionIds: ["sx_1"], grantedVia: "cli", followUps: {} } } as any;
    useArtifactStore.setState({ artifacts: [admitted] } as any);
    usePreflightBlockStore.setState({ blocks: [block({ allowance: receipt({ grantedVia: "cli" }) })] } as any);
    const { container } = render(<><AllowedOnceBadge artifact={admitted} /><AllowedOnceSection sessionId="s1" /><LedgerAllowances /></>);
    expect(screen.getByTestId("allowed-once-badge")).toHaveTextContent("Allowed once (CLI)");
    expect(screen.getByTestId("debrief-allowed-once")).toHaveTextContent("modify src/config.ts");
    expect(screen.getByTestId("ledger-allowances")).toHaveTextContent("'global mutable state' · 1 allowance");
    expect(container.textContent).not.toMatch(/verified|authenticated/i);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/revoke"))).toHaveLength(1));
  });
});
