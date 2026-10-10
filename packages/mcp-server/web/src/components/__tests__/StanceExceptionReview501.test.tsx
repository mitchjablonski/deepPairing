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
