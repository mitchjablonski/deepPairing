/**
 * #501 review regressions (Astra P2 ×2, Luna P2 ×2, Claude LOW). Each fails on
 * b4baa19f. Real zustand stores; a fake daemon answers fetch with deferred
 * responses so the races can be ordered exactly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllowOnceDialogHost } from "../AllowOnceDialog";
import { PreflightBlockLog } from "../PreflightBlockLog";
import { useAllowOnceStore } from "../../stores/allowOnce";
import { useToastStore } from "../../stores/toast";
import { usePreflightBlockStore } from "../../stores/preflightBlocks";
import { useConnectionStore } from "../../stores/connection";
import { usePreferencesStore } from "../../stores/preferences";
import { useConnectionGraceStore } from "../../lib/connectionGrace";
import { announceGrantOnce, resetAnnouncedGrantsForTests } from "../../lib/stanceException";

const PREVIEW = {
  blockId: "blk_1", source: "session", eligible: true,
  stance: { description: "global mutable state", concept: "global mutable state" },
  snapshot: { kind: "create", type: "code_change", title: "modify a", content: { filePath: "a.ts", before: "x", after: "y" } },
  preconditions: [],
};
const SERVER_RECEIPT = { id: "sx_srv", grantedVia: "ui", grantedAt: "2001-01-01T00:00:00.000Z", reason: "fine", ceilingAt: "2001-01-04T00:00:00.000Z", state: "allowed" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake daemon whose grant POST resolves only when the test says so. */
function deferredDaemon() {
  let release!: (r: Response) => void;
  const grant = new Promise<Response>((r) => { release = r; });
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/exception") && (init?.method ?? "GET") === "GET") return Promise.resolve(json(PREVIEW));
    if (url.includes("/exception")) { posts.push(url); return grant; }
    return Promise.resolve(json({}));
  }));
  return { posts, release: (body: unknown, status = 201) => release(json(body, status)) };
}
const grantToasts = () => useToastStore.getState().toasts.filter((t) => t.title.startsWith("Allowed once:"));
const block = (over: Record<string, unknown> = {}) => ({ id: "blk_1", serverId: "blk_1", at: "2026-06-01T00:00:00.000Z", source: "session", concept: "global mutable state", via: "surface", eligible: true, ...over });

async function openAndSubmit() {
  act(() => useAllowOnceStore.getState().open({ blockId: "blk_1", concept: "global mutable state" }));
  await screen.findByTestId("allow-once-diff");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "this is fine" } });
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
}

beforeEach(() => {
  resetAnnouncedGrantsForTests();
  useAllowOnceStore.setState({ request: null });
  useToastStore.getState().dismissAll();
  usePreflightBlockStore.setState({ blocks: [block()], liveRev: {}, lastSeenAt: null, loaded: true, focusRequest: null } as any);
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [], disconnectedSince: null } as any);
  useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
  usePreferencesStore.setState({ nextUpBar: false });
});
afterEach(() => {
  useConnectionGraceStore.setState({ everConnected: false, graceOver: false, hydrationStalled: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Astra P2 — one 'Allowed once' announcement whichever arrives first", () => {
  it("socket first, HTTP second: one toast", async () => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    act(() => { announceGrantOnce("sx_srv", "global mutable state"); }); // the broadcast's path
    expect(grantToasts()).toHaveLength(1);
    await act(async () => { d.release({ allowance: { id: "sx_srv", state: "allowed" }, receipt: SERVER_RECEIPT, seenAt: "2001-01-01T00:00:00.000Z" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(grantToasts()).toHaveLength(1);
  });

  it("HTTP first, socket second: one toast; a failed HTTP result announces nothing", async () => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    await act(async () => { d.release({ allowance: { id: "sx_h", state: "allowed" }, receipt: { ...SERVER_RECEIPT, id: "sx_h" } }); });
    await waitFor(() => expect(grantToasts()).toHaveLength(1));
    act(() => { announceGrantOnce("sx_h", "global mutable state"); });
    expect(grantToasts()).toHaveLength(1);

    const d2 = deferredDaemon();
    await openAndSubmit();
    await act(async () => { d2.release({ error: "busy" }, 503); });
    await screen.findByText("busy");
    expect(grantToasts()).toHaveLength(1);
  });
});

describe("Claude LOW — only the daemon's receipt values", () => {
  it("HTTP-first applies the server's grantedAt / ceilingAt / seenAt, never client-made ones", async () => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    await act(async () => { d.release({ allowance: { id: "sx_srv", state: "allowed" }, receipt: SERVER_RECEIPT, seenAt: "2001-01-01T00:00:00.000Z" }); });
    await waitFor(() => expect(usePreflightBlockStore.getState().blocks[0]!.allowance).toEqual(SERVER_RECEIPT));
    expect(usePreflightBlockStore.getState().blocks[0]!.seenAt).toBe("2001-01-01T00:00:00.000Z");
    // A later server seenAt wins over the earlier one.
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", SERVER_RECEIPT as any, "2001-01-02T00:00:00.000Z"));
    expect(usePreflightBlockStore.getState().blocks[0]!.seenAt).toBe("2001-01-02T00:00:00.000Z");
  });
});

describe("Astra P2 — load() reconciles durable receipts without clobbering newer live events", () => {
  it("an existing row picks up the durable allowance and seenAt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ blocks: [{ ...block(), allowance: SERVER_RECEIPT, seenAt: "2001-01-01T00:00:00.000Z" }] })));
    await usePreflightBlockStore.getState().load();
    expect(usePreflightBlockStore.getState().blocks[0]).toMatchObject({ allowance: { state: "allowed" }, seenAt: "2001-01-01T00:00:00.000Z" });
  });

  it("a stale response that lands AFTER a live update doesn't overwrite it", async () => {
    let respond!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((r) => { respond = r; })));
    const loading = usePreflightBlockStore.getState().load();
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT, state: "used", artifactId: "art_1" } as any));
    respond(json({ blocks: [{ ...block(), allowance: SERVER_RECEIPT }] }));
    await loading;
    expect(usePreflightBlockStore.getState().blocks[0]!.allowance).toMatchObject({ state: "used" });
  });
});

describe("Luna P2 — a dispatched grant can't be dismissed", () => {
  it("while the POST is pending: 'Allowing…', Cancel disabled, Esc does nothing; then it closes", async () => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    expect(screen.getByRole("button", { name: "Allowing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => { d.release({ allowance: { id: "sx_x", state: "allowed" }, receipt: { ...SERVER_RECEIPT, id: "sx_x" } }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("an obsolete completion never closes a newer dialog for a different block", async () => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    act(() => useAllowOnceStore.getState().open({ blockId: "blk_2", concept: "other stance" }));
    await act(async () => { d.release({ allowance: { id: "sx_y", state: "allowed" }, receipt: { ...SERVER_RECEIPT, id: "sx_y" } }); });
    // The first grant's completion has been fully processed…
    await waitFor(() => expect(grantToasts()).toHaveLength(1));
    // …and the newer dialog is still open.
    expect(useAllowOnceStore.getState().request?.blockId).toBe("blk_2");
    expect(screen.getByRole("heading", { name: "Allow one proposal past 'other stance'" })).toBeInTheDocument();
  });
});

describe("Luna P2 — Retire confirm hands focus back to Retire…", () => {
  it.each(["Escape", "Cancel"])("after %s, focus is on Retire…, not the body", async (how) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));
    render(<PreflightBlockLog />);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retire…" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    if (how === "Escape") await user.keyboard("{Escape}");
    else await user.keyboard("{Enter}");
    expect(screen.queryByTestId("retire-confirm")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire…" })).toHaveFocus();
  });
});

describe("Fable HIGH — the hero toast follows its receipt and leaves", () => {
  it("after a grant: the card says so, Allow is gone, focus returns to the toast without holding it, and it leaves on the receipt timer", async () => {
    const d = deferredDaemon();
    const { ToastLayer, RECEIPT_TTL_MS } = await import("../ToastLayer");
    render(<><ToastLayer /><AllowOnceDialogHost /></>);
    act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 12_000, hero: { source: "session", concept: "global mutable state", via: "surface", blockId: "blk_1", eligible: true } }); });
    const allow = screen.getByRole("button", { name: "Allow this proposal once" });
    allow.focus();
    fireEvent.click(allow);
    await screen.findByTestId("allow-once-diff");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "this is fine" } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await act(async () => { d.release({ allowance: { id: "sx_t", state: "allowed" }, receipt: { ...SERVER_RECEIPT, id: "sx_t" }, seenAt: "2001-01-01T00:00:00.000Z" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("hero-receipt")).toHaveTextContent("Claude can retry this proposal.");
    expect(screen.queryByRole("button", { name: "Allow this proposal once" })).not.toBeInTheDocument();
    expect(document.activeElement?.getAttribute("data-toast-id")).toBeTruthy(); // the stable anchor
    act(() => { vi.advanceTimersByTime(RECEIPT_TTL_MS + 100); });
    expect(screen.queryByTestId("hero-toast")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a 'changed' receipt shows the changed copy", async () => {
    const { ToastLayer } = await import("../ToastLayer");
    render(<ToastLayer />);
    act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 0, hero: { source: "session", concept: "c", via: "surface", blockId: "blk_1", eligible: true } }); });
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT, state: "changed" } as any));
    expect(screen.getByTestId("hero-toast")).toHaveTextContent("The proposal you allowed changed");
    expect(screen.getByTestId("hero-receipt")).toHaveTextContent("A new block is waiting");
  });

  it("block toasts never stack past three (the gate log keeps the rest); the region is capped to the viewport", async () => {
    const { ToastLayer } = await import("../ToastLayer");
    const { container } = render(<ToastLayer />);
    for (let i = 0; i < 5; i++) {
      act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 0, hero: { source: "session", concept: `c${i}`, via: "surface", blockId: `blk_${i}`, eligible: true } }); });
    }
    expect(screen.getAllByTestId("hero-toast")).toHaveLength(3);
    expect(container.querySelector('[data-testid="toast-region"]')!.className).toMatch(/max-h-\[calc\(100vh-2rem\)\] overflow-hidden/);
  });
});

describe("Fable MED/LOW — footer layout and cursors", () => {
  it("the meta line sits on its own row above the actions; every new action is cursor-pointer", async () => {
    const { ToastLayer } = await import("../ToastLayer");
    render(<ToastLayer />);
    act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 0, hero: { source: "session", concept: "c", via: "surface", blockId: "blk_1", eligible: true } }); });
    const allow = screen.getByRole("button", { name: "Allow this proposal once" });
    const footer = allow.parentElement!.parentElement!;
    expect(footer.className).toMatch(/flex-col/);
    expect(footer.firstElementChild).toHaveTextContent("Your personal taste");
    expect(footer.firstElementChild!.contains(allow)).toBe(false);
    for (const name of ["Allow this proposal once", "More options"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(/cursor-pointer/);
    }
  });
});

describe("round 3 (Astra P2) — a late HTTP receipt never regresses a newer terminal state", () => {
  it.each(["used", "changed", "revoked", "ended"])("POST pending → socket granted → socket %s → delayed HTTP 201 'allowed': the store stays terminal", async (terminal) => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT } as any, "2001-01-01T00:00:00.000Z"));
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT, state: terminal, ...(terminal === "used" ? { artifactId: "art_1" } : {}) } as any));
    await act(async () => { d.release({ allowance: { id: SERVER_RECEIPT.id, state: "allowed" }, receipt: SERVER_RECEIPT, seenAt: "2001-01-01T00:00:00.000Z" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(usePreflightBlockStore.getState().blocks[0]!.allowance!.state).toBe(terminal);
  });

  it("a reload carrying an older 'allowed' doesn't regress a terminal receipt either, while terminal-to-terminal updates apply", async () => {
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT, state: "ended" } as any));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ blocks: [{ ...block(), allowance: SERVER_RECEIPT }] })));
    usePreflightBlockStore.setState({ liveRev: {} } as any);
    await usePreflightBlockStore.getState().load();
    expect(usePreflightBlockStore.getState().blocks[0]!.allowance!.state).toBe("ended");
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT, state: "used", artifactId: "art_9" } as any));
    expect(usePreflightBlockStore.getState().blocks[0]!.allowance).toMatchObject({ state: "used", artifactId: "art_9" });
  });
});

describe("round 3 (Sol P2) — two grants on the same stance are each spoken (bar ON)", () => {
  it("MutationObserver: exactly one live-region mutation per grant, even with identical words", async () => {
    const { NextUpBar } = await import("../NextUpBar");
    usePreferencesStore.setState({ nextUpBar: true });
    useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false } as any);
    render(<NextUpBar />);
    const region = screen.getByTestId("next-up-announcer");
    const observer = new MutationObserver(() => {});
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    const changed = () => observer.takeRecords().length > 0;
    act(() => { announceGrantOnce("sx_a", "global mutable state"); });
    expect(changed()).toBe(true);
    act(() => { announceGrantOnce("sx_b", "global mutable state"); });
    expect(changed()).toBe(true);
    // …while the SAME allowance (HTTP + socket) still speaks only once.
    act(() => { announceGrantOnce("sx_b", "global mutable state"); });
    expect(changed()).toBe(false);
    expect(region.textContent).toContain("Allowed once: 'global mutable state'. Waiting for Claude to retry.");
    observer.disconnect();
  });
});

describe("round 3 (Fable) — one receipt on screen; the gate log is never covered", () => {
  const pushHero = (blockId = "blk_1") => act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 0, hero: { source: "session", concept: "global mutable state", via: "surface", blockId, eligible: true } }); });

  it("with the block's hero toast up, a grant adds NO second 'Allowed once:' toast; the hero's polite status line (bar off) carries it once", async () => {
    const { ToastLayer } = await import("../ToastLayer");
    render(<ToastLayer />);
    pushHero();
    const status = screen.getByTestId("hero-receipt");
    expect(status).toHaveAttribute("role", "status"); // present BEFORE its text arrives
    expect(status).toHaveTextContent("");
    act(() => { announceGrantOnce("sx_1", "global mutable state", { blockId: "blk_1" }); });
    act(() => usePreflightBlockStore.getState().applyReceipt("blk_1", SERVER_RECEIPT as any, "2001-01-01T00:00:00.000Z"));
    expect(grantToasts()).toHaveLength(0);
    expect(status).toHaveTextContent("Claude can retry this proposal.");
  });

  it("with no hero toast on screen (e.g. a CLI grant later), the info toast is the record", () => {
    act(() => { announceGrantOnce("sx_2", "global mutable state", { blockId: "blk_gone" }); });
    expect(grantToasts()).toHaveLength(1);
  });

  it("bar ON: the hero receipt line is not a second live region", async () => {
    usePreferencesStore.setState({ nextUpBar: true });
    const { ToastLayer } = await import("../ToastLayer");
    render(<ToastLayer />);
    pushHero();
    expect(screen.getByTestId("hero-receipt")).not.toHaveAttribute("role");
  });

  it("while the gate log is open, the block toasts step aside (and return when it closes)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));
    const { ToastLayer } = await import("../ToastLayer");
    render(<><PreflightBlockLog /><ToastLayer /></>);
    pushHero("blk_1"); pushHero("blk_2"); pushHero("blk_3");
    expect(screen.getAllByTestId("hero-toast")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    expect(screen.queryAllByTestId("hero-toast")).toHaveLength(0);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByTestId("hero-toast")).toHaveLength(3);
  });
});

describe("round 4 (Luna P2) — exactly one announcement per event, whatever is on screen", () => {
  /** Live regions that currently speak a stance moment. */
  const speakers = (needle: RegExp) =>
    Array.from(document.querySelectorAll('[role="status"],[role="alert"],[aria-live]'))
      .filter((el) => el.getAttribute("aria-live") !== "off" && needle.test(el.textContent ?? ""))
      // a nested live region counts once (the innermost)
      .filter((el, _i, all) => !all.some((o) => o !== el && el.contains(o)));
  const MOMENT = /Allowed once: 'global mutable state'|Claude can retry this proposal|Claude used your allowance|A new block is waiting|proposal you allowed changed/;
  const pushHero = () => act(() => { useToastStore.getState().push({ kind: "preflight-block", title: "x", ttl: 0, hero: { source: "session", concept: "global mutable state", via: "surface", blockId: "blk_1", eligible: true } }); });

  async function mount(bar: boolean) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));
    usePreferencesStore.setState({ nextUpBar: bar });
    const { ToastLayer } = await import("../ToastLayer");
    const { NextUpBar } = await import("../NextUpBar");
    render(<>{bar && <NextUpBar />}<PreflightBlockLog /><ToastLayer /></>);
    pushHero();
  }
  const grant = (id: string) => act(() => {
    announceGrantOnce(id, "global mutable state", { blockId: "blk_1" });
    usePreflightBlockStore.getState().applyReceipt("blk_1", { ...SERVER_RECEIPT, id } as any, "2001-01-01T00:00:00.000Z");
  });

  it("bar OFF + gate log OPEN: the hero isn't rendered, so the fallback toast speaks — once (grant, then used)", async () => {
    await mount(false);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    expect(screen.queryByTestId("hero-toast")).not.toBeInTheDocument();
    grant("sx_g");
    expect(speakers(MOMENT)).toHaveLength(1);
    act(() => useToastStore.getState().dismissAll());
    const { notifyStanceMoment } = await import("../../lib/stanceException");
    act(() => notifyStanceMoment("Claude used your allowance: modify a.", { blockId: "blk_1" }));
    expect(speakers(MOMENT)).toHaveLength(1);
  });

  it("bar OFF + gate log CLOSED: the hero's status line speaks, and no fallback toast doubles it", async () => {
    await mount(false);
    grant("sx_c");
    expect(speakers(MOMENT)).toHaveLength(1);
    expect(grantToasts()).toHaveLength(0);
  });

  it("bar ON (control): only the bar's announcer speaks, log open or closed", async () => {
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: true }], staleDaemon: false, snapshotUnavailable: false, sessionConflict: false } as any);
    await mount(true);
    grant("sx_on1");
    expect(speakers(MOMENT).map((el) => el.getAttribute("data-testid"))).toEqual(["next-up-announcer"]);
    fireEvent.click(screen.getByRole("button", { name: /Show recent gate blocks/ }));
    grant("sx_on2");
    expect(speakers(MOMENT).map((el) => el.getAttribute("data-testid"))).toEqual(["next-up-announcer"]);
  });
});

describe("round 4 (Sol P2) — a terminal allowance is never reported as a fresh grant", () => {
  it("terminal between preview and confirm: the idempotent 200 says what happened, announces nothing, keeps the dialog open", async () => {
    const d = deferredDaemon();
    render(<AllowOnceDialogHost />);
    await openAndSubmit();
    await act(async () => { d.release({ existing: true, allowance: { id: "sx_r", state: "revoked" }, receipt: { ...SERVER_RECEIPT, id: "sx_r", state: "revoked" } }, 200); });
    await screen.findByText(/that allowance is now revoked\. Nothing new was allowed\./);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(grantToasts()).toHaveLength(0);
    expect(usePreflightBlockStore.getState().blocks[0]!.allowance!.state).toBe("revoked");
  });
});
