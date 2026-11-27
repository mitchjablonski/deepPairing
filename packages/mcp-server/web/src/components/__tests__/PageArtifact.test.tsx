/**
 * #680 — the page artifact renderer: agent HTML inside PrototypeFrame's
 * isolation (opaque-origin sandbox, injected no-network CSP), readable before
 * Run, scripts click-to-run, with the standard review footer.
 *
 * Slice 2 — annotation: before Run the frame runs ONLY our annotator over the
 * sanitised markup (nonce CSP); after Run the full page plus the annotator;
 * never `allow-same-origin` in either mode. An anchor from the frame opens the
 * composer pre-targeted; submitting stores the comment with its htmlAnchor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Comment } from "@deeppairing/shared";
import { PAGE_RULE_OUT_MESSAGES } from "@deeppairing/shared";
import { pageArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { PageArtifact } from "../artifacts/PageArtifact";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useLedgerStore } from "../../stores/ledger";
import { useConnectionGraceStore } from "../../lib/connectionGrace";
import { usePreferencesStore } from "../../stores/preferences";
import { OFFLINE_ACT_REASON } from "../../hooks/useOfflineReason";
import { PAGE_MERMAID_PREPARE } from "../../lib/pageMermaid";

// The full verb row only renders once the reader reaches the artifact's end.
function stubIO(isIntersecting: boolean) {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: any;
      constructor(cb: any) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting }]); }
      disconnect() {}
      unobserve() {}
    } as any,
  );
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(pageArtifact);
  stubIO(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => vi.unstubAllGlobals());

const frame = () => document.querySelector("iframe");

describe("PageArtifact", () => {
  it("mounts the page in a sandboxed iframe at an opaque origin, before Run", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const iframe = frame();
    expect(iframe).not.toBeNull();
    const sandbox = iframe!.getAttribute("sandbox");
    // Present, and never allow-same-origin (that would hand agent code the
    // daemon's origin). Before Run, scripts are allowed ONLY so the annotator
    // runs: the agent's scripts are stripped and the CSP is nonce-only.
    expect(sandbox).not.toBeNull();
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).toBe("allow-scripts");
    const srcdoc = iframe!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("<h1>Cache invalidation</h1>");
    // The agent markup lives only inside srcdoc, never in the parent document.
    expect(screen.queryByText("Cache invalidation")).not.toBeInTheDocument();
  });

  it("before Run: the agent's script is stripped, only the nonce'd annotator runs", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const srcdoc = frame()!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).not.toContain("document.title = 'cache options'");
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(srcdoc)?.[1];
    expect(nonce).toBeTruthy();
    expect(srcdoc).not.toContain("'unsafe-inline'; form-action");
    // Exactly one script tag: ours, carrying the nonce, ahead of the agent markup.
    const scripts = srcdoc.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual([`<script nonce="${nonce}">`]);
    expect(srcdoc.indexOf("<script")).toBeLessThan(srcdoc.indexOf("<h1>"));
    expect(srcdoc).toContain('dp: "anchor"');
  });

  it("keeps agent scripts click-to-run: Run remounts the frame with allow-scripts only, annotator first", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const sandbox = frame()!.getAttribute("sandbox") ?? "";
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    const srcdoc = frame()!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("document.title = 'cache options'");
    expect(srcdoc).toContain('dp: "anchor"');
    expect(srcdoc.indexOf('dp: "anchor"')).toBeLessThan(srcdoc.indexOf("document.title"));
    // Still no network after Run.
    expect(srcdoc).toContain("default-src 'none'");
  });

  it("never grants allow-same-origin, in either mode", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    for (const f of Array.from(document.querySelectorAll("iframe"))) expect(f.getAttribute("sandbox")).not.toMatch(/allow-same-origin/);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    for (const f of Array.from(document.querySelectorAll("iframe"))) expect(f.getAttribute("sandbox")).not.toMatch(/allow-same-origin/);
  });

  it("offers no Run button for a page without scripts", () => {
    const plain: Artifact = { ...pageArtifact, id: "art_page_plain", content: { title: "Plain", html: "<p>Just text.</p>" } };
    render(<PageArtifact artifact={plain} />);
    expect(frame()).not.toBeNull();
    expect(screen.queryByRole("button", { name: /run page scripts/i })).not.toBeInTheDocument();
  });

  it("shows the summary and the source path above the frame", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.getByText(/three invalidation strategies we discussed/i)).toBeInTheDocument();
    expect(screen.getByText("docs/cache-options.html")).toBeInTheDocument();
  });

  it("renders the standard review footer (Request changes / Reject)", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.getByPlaceholderText(/respond to the agent/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /request changes/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /^reject/i }).length).toBeGreaterThan(0);
  });

  it("accepts a page over the 512 KB prototype cap (page cap is 2 MB)", () => {
    const big: Artifact = {
      ...pageArtifact,
      id: "art_page_big",
      content: { title: "Big", html: "<p>" + "x".repeat(600 * 1024) + "</p>" },
    };
    render(<PageArtifact artifact={big} />);
    expect(screen.queryByText(/too large to render safely/i)).not.toBeInTheDocument();
    expect(frame()).not.toBeNull();
  });
});

// --- #680 slice 2: anchors from the frame -----------------------------------

/** Stand in for the frame's window: the real iframe's contentWindow is
 *  shadowed by a fake we can post "from" and whose postMessage we can read. */
function fakeFrameWindow() {
  const iframe = frame()!;
  const win = { postMessage: vi.fn() };
  Object.defineProperty(iframe, "contentWindow", { value: win, configurable: true });
  return win;
}

/** Pretend focus is (or is not) inside the page frame while a message lands:
 *  a real click into the frame gives the iframe focus in the companion. */
function withActiveElement(el: Element | null, fn: () => void) {
  Object.defineProperty(document, "activeElement", { get: () => el, configurable: true });
  try {
    fn();
  } finally {
    delete (document as any).activeElement;
  }
}

function fromFrame(source: unknown, data: unknown, opts: { frameFocused?: boolean } = {}) {
  const dispatch = () =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource }));
    });
  if (opts.frameFocused === false) dispatch();
  else withActiveElement(frame(), dispatch);
}

/** A frame's pins-status report for the pin list the companion last sent it
 *  (reports echo that list's key; a stale or keyless one is ignored). */
function pinsStatus(win: { postMessage: ReturnType<typeof vi.fn> }, found: boolean[]) {
  const last = () => win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "pins").at(-1) as any;
  if (!last()) fromFrame(win, { dp: "ready" });
  fromFrame(win, { dp: "pins-status", found, key: last().key });
}

const cellAnchor = {
  kind: "cell",
  locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
  quote: "Up to 60s",
  table: { row: "TTL expiry", col: "Staleness" },
};

describe("PageArtifact — annotation (#680 slice 2)", () => {
  it("opens the composer pre-targeted at a valid anchor from its own frame", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    const composer = screen.getByTestId("page-anchor-composer");
    expect(within(composer).getByText("Table cell")).toBeInTheDocument();
    expect(within(composer).getByText(/Up to 60s/)).toBeInTheDocument();
    expect(within(composer).getByText("TTL expiry")).toBeInTheDocument();
    expect(within(composer).getByText("Staleness")).toBeInTheDocument();
    // Opening the composer creates nothing: a comment exists only on submit.
    expect(useArtifactStore.getState().comments[pageArtifact.id] ?? []).toHaveLength(0);
    // The reviewer was in the frame, so the caret follows them to the composer.
    expect(document.activeElement).toBe(within(composer).getByLabelText("Comment on the selected spot"));
  });

  it("drops a frame anchor while a companion BUTTON holds focus", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    const button = document.createElement("button");
    button.textContent = "elsewhere";
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);
    fromFrame(win, { dp: "anchor", anchor: cellAnchor }, { frameFocused: false });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("drops a frame anchor in an exiting (inert) pane, even with the frame focused", () => {
    render(
      <div data-testid="pane">
        <PageArtifact artifact={pageArtifact} />
      </div>,
    );
    const win = fakeFrameWindow();
    screen.getByTestId("pane").setAttribute("inert", "");
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
  });

  it.each([null, "art_somewhere_else"])("drops a frame anchor when selection is %s", (selectedArtifactId) => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    act(() => {
      useArtifactStore.setState({ selectedArtifactId });
    });
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
  });

  it("does not transfer focus when Run replaces the accepting iframe before the effect", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const initialFrame = frame();
    const win = fakeFrameWindow();
    const run = screen.getByRole("button", { name: /run page scripts/i });
    // The parent reports whichever iframe is mounted as focused, including
    // the replacement. Only the original iframe accepted this message.
    const active = vi.spyOn(document, "activeElement", "get").mockImplementation(() => frame());
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, "focus");
    try {
      act(() => {
        run.click();
        window.dispatchEvent(new MessageEvent("message", {
          data: { dp: "anchor", anchor: cellAnchor }, source: win as unknown as MessageEventSource,
        }));
      });
      expect(initialFrame?.isConnected).toBe(false);
      expect(frame()).not.toBeNull();
      expect(screen.getByTestId("page-anchor-composer")).toBeInTheDocument();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      active.mockRestore();
    }
  });

  it("ignores an anchor from any other source, a malformed one, and an over-length one", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame({ postMessage: vi.fn() }, { dp: "anchor", anchor: cellAnchor });
    fromFrame(null, { dp: "anchor", anchor: cellAnchor });
    fromFrame(win, { dp: "anchor", anchor: { ...cellAnchor, kind: "region" } });
    fromFrame(win, { dp: "anchor", anchor: { ...cellAnchor, quote: "x".repeat(281) } });
    fromFrame(win, { dp: "anchor" });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
  });

  it("submitting stores the comment with its htmlAnchor (and the page version)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return {
        ok: true,
        json: async () => ({
          comment: {
            id: "cmt_srv_1",
            sessionId: "sess_1",
            target: body.target,
            parentCommentId: null,
            author: "human",
            content: body.content,
            acknowledged: false,
            createdAt: new Date().toISOString(),
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    const composer = screen.getByTestId("page-anchor-composer");
    await userEvent.type(within(composer).getByLabelText("Comment on the selected spot"), "60s is too stale");
    await userEvent.click(within(composer).getByRole("button", { name: "Send" }));

    const post = fetchMock.mock.calls.find(([u, init]: any[]) => String(u).includes("/api/comments") && init?.method === "POST") as any;
    expect(post).toBeDefined();
    const body = JSON.parse(post[1].body);
    expect(body.content).toBe("60s is too stale");
    expect(body.target.htmlAnchor).toEqual({ ...cellAnchor, version: pageArtifact.version });

    const stored = useArtifactStore.getState().comments[pageArtifact.id] ?? [];
    expect(stored.some((c) => c.target.htmlAnchor?.quote === "Up to 60s")).toBe(true);
    // It now shows as pin #1 in the page's list, and the frame got the pin.
    expect(await screen.findByTestId("page-annotations")).toBeInTheDocument();
    expect(win.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dp: "pins", anchors: [expect.objectContaining({ quote: "Up to 60s" })] }),
      "*",
    );
  });

  it("sends pins on ready, focuses a pin on click, and marks an anchor not found in this version", async () => {
    useArtifactStore.getState().addComment({
      id: "cmt_old",
      sessionId: "sess_1",
      target: { artifactId: pageArtifact.id, htmlAnchor: { kind: "text", locator: "p", quote: "a sentence from v1" } },
      parentCommentId: null,
      author: "human",
      content: "this sentence is wrong",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    });
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "ready" });
    expect(win.postMessage).toHaveBeenCalledWith(
      { dp: "pins", anchors: [{ kind: "text", locator: "p", quote: "a sentence from v1" }], states: ["open"], ids: ["cmt_old"], key: expect.any(String) },
      "*",
    );
    pinsStatus(win, [false]);
    expect(screen.getByTestId("page-anchor-missing")).toHaveTextContent(/not found in this version/i);
    expect(within(screen.getByTestId("page-annotations")).getByText(/a sentence from v1/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("page-annotation"));
    // Narrow (the composer docks below the frame): the pin goes near the frame's bottom, next to the composer.
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "focus", index: 0, block: "end" }, "*");
    // An explicit open from the companion still focuses the composer.
    expect(document.activeElement).toBe(screen.getByLabelText("Comment on the selected spot"));
  });

  it("drops anchors while pointing is off (after Run), and accepts them again when it is back on", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const win = fakeFrameWindow();
    await userEvent.click(screen.getByRole("button", { name: /pointing: on/i }));
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false, scripts: true, kbd: false, dark: false }, "*");
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /pointing: off/i }));
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(screen.getByTestId("page-anchor-composer")).toBeInTheDocument();
  });

  it("never steals focus from a companion control the reviewer is typing in", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    const respond = screen.getByPlaceholderText(/respond to the agent/i);
    await userEvent.click(respond);
    await userEvent.type(respond, "half a thought");
    expect(document.activeElement).toBe(respond);
    fromFrame(win, { dp: "anchor", anchor: cellAnchor }, { frameFocused: false });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(respond);
    expect(useArtifactStore.getState().comments[pageArtifact.id] ?? []).toHaveLength(0);
  });

  it("a retracted page still lists its anchored comments but opens no composer", () => {
    const retracted: Artifact = { ...pageArtifact, id: "art_page_retracted", status: "retracted" };
    useArtifactStore.getState().addArtifact(retracted);
    useArtifactStore.getState().addComment({
      id: "cmt_hist",
      sessionId: "sess_1",
      target: { artifactId: retracted.id, htmlAnchor: { kind: "element", locator: "h1", quote: "Cache invalidation" } },
      parentCommentId: null,
      author: "human",
      content: "historical note",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    });
    render(<PageArtifact artifact={retracted} />);
    expect(within(screen.getByTestId("page-annotations")).getByText(/historical note/)).toBeInTheDocument();
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
  });
});

// --- #714: the pointing toggle is always reachable ---------------------------

describe("PageArtifact — pointing toggle and shortcut (#714)", () => {
  const plain: Artifact = { ...pageArtifact, id: "art_page_plain_714", content: { title: "Plain", html: "<p>Just text.</p>" } };
  const select = (id: string) => useArtifactStore.setState({ selectedArtifactId: id });

  it("shows the Pointing toggle and the Alt/Option hint on a page with no scripts (no Run button)", () => {
    render(<PageArtifact artifact={plain} />);
    expect(screen.queryByRole("button", { name: /run page scripts/i })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /pointing: on/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("page-pointing-hint")).toHaveTextContent(/Alt\/Option-click/);
  });

  it("shows the toggle before Run on a scripted page, and switching it off reaches the frame and drops anchors", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.getByRole("button", { name: /run page scripts/i })).toBeInTheDocument();
    const win = fakeFrameWindow();
    await userEvent.click(screen.getByRole("button", { name: /pointing: on/i }));
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false, scripts: false, kbd: false, dark: false }, "*");
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
  });

  it("Cmd/Ctrl+I toggles pointing while this page is selected", () => {
    select(plain.id);
    render(<PageArtifact artifact={plain} />);
    const win = fakeFrameWindow();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: /pointing: off/i })).toHaveAttribute("aria-pressed", "false");
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false, scripts: false, kbd: false, dark: false }, "*");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", metaKey: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
  });

  it("the shortcut does nothing when another artifact is selected, or with Shift/Alt held", () => {
    select("some_other_artifact");
    render(<PageArtifact artifact={plain} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
    select(plain.id);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "I", ctrlKey: true, shiftKey: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, altKey: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
  });

  it("the shortcut pressed inside the frame toggles pointing only from its own, focused frame", () => {
    select(plain.id);
    render(<PageArtifact artifact={plain} />);
    const win = fakeFrameWindow();
    fromFrame({ postMessage: vi.fn() }, { dp: "toggle-pointing" });
    fromFrame(win, { dp: "toggle-pointing" }, { frameFocused: false });
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
    fromFrame(win, { dp: "toggle-pointing" });
    expect(screen.getByRole("button", { name: /pointing: off/i })).toBeInTheDocument();
  });

  it("ties the hint to the toggle with aria-describedby", () => {
    render(<PageArtifact artifact={plain} />);
    const toggle = screen.getByRole("button", { name: /pointing: on/i });
    const hint = screen.getByTestId("page-pointing-hint");
    expect(hint.id).not.toBe("");
    expect(toggle).toHaveAttribute("aria-describedby", hint.id);
    expect(hint).toHaveTextContent(/radio\/checkbox tabs/);
  });

  it("REVIEW: after Run a focused frame's toggle-pointing is ignored (agent script shares the frame); button and shortcut still work", async () => {
    select(pageArtifact.id);
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "toggle-pointing" });
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
    // The hint and title say how to switch once scripts run.
    expect(screen.getByTestId("page-pointing-hint")).toHaveTextContent(/use this toggle or press (⌘I|Ctrl\+I) outside the page/);
    expect(screen.getByRole("button", { name: /pointing: on/i }).getAttribute("title")).toMatch(/After Run, use this toggle or press (⌘I|Ctrl\+I) outside the page/);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: /pointing: off/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /pointing: off/i }));
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
  });

  it("REVIEW: the shortcut is left alone while typing in a companion field, and on autorepeat", () => {
    select(plain.id);
    render(<PageArtifact artifact={plain} />);
    for (const tag of ["textarea", "input", "select"]) {
      const field = document.createElement(tag);
      document.body.appendChild(field);
      const ev = new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true });
      act(() => {
        field.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(false);
      field.remove();
    }
    const editableDiv = document.createElement("div");
    editableDiv.contentEditable = "true";
    document.body.appendChild(editableDiv);
    act(() => {
      editableDiv.dispatchEvent(new KeyboardEvent("keydown", { key: "i", metaKey: true, bubbles: true, cancelable: true }));
    });
    editableDiv.remove();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, repeat: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: /pointing: on/i })).toBeInTheDocument();
  });

  it("a read-only page shows no pointing toggle", () => {
    const retracted: Artifact = { ...plain, id: "art_page_plain_ro", status: "retracted" };
    select(retracted.id);
    render(<PageArtifact artifact={retracted} />);
    expect(screen.queryByRole("button", { name: /pointing/i })).not.toBeInTheDocument();
  });
});

describe("PageArtifact — document attributes before Run (#680 slice 2)", () => {
  it("keeps the body class a page stylesheet depends on, and RTL direction, on the wrapper", () => {
    const styled: Artifact = {
      ...pageArtifact,
      id: "art_page_styled",
      content: {
        title: "Styled",
        html: "<html dir=\"rtl\" lang=\"ar\"><head><style>body.theme-dark h1{color:white}</style></head><body class=\"theme-dark\" onload=\"x()\"><h1>عنوان</h1></body></html>",
      },
    };
    render(<PageArtifact artifact={styled} />);
    const srcdoc = frame()!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('<html dir="rtl" lang="ar">');
    expect(srcdoc).toContain('<body class="theme-dark">');
    expect(srcdoc).toContain("body.theme-dark h1");
    expect(srcdoc).not.toContain("x()");
  });
});

describe("PageArtifact — file watch (#680 slice 3)", () => {
  it("says a version was recorded from the file and marks its orphans until the frame reports", () => {
    const v2: Artifact = {
      ...pageArtifact,
      id: "art_page_v2",
      version: 2,
      fileWatch: {
        recorded: {
          at: new Date().toISOString(),
          sourcePath: "docs/cache.html",
          fromArtifactId: pageArtifact.id,
          fromVersion: 1,
          carriedCount: 0,
          orphaned: [{ commentId: "cmt_gone", kind: "text", quote: "a sentence from v1", locator: "p", version: 1 }],
        },
      },
    };
    useArtifactStore.getState().addArtifact(v2);
    useArtifactStore.getState().addComment({
      id: "cmt_gone",
      sessionId: "sess_1",
      target: { artifactId: v2.id, htmlAnchor: { kind: "text", locator: "p", quote: "a sentence from v1", version: 1 } },
      parentCommentId: null,
      author: "human",
      content: "this sentence is wrong",
      acknowledged: false,
      createdAt: new Date().toISOString(),
    });
    render(<PageArtifact artifact={v2} />);
    expect(screen.getByTestId("page-file-recorded")).toHaveTextContent(/recorded automatically from docs\/cache\.html/i);
    expect(screen.getByTestId("page-file-recorded")).toHaveTextContent(/replacing v1/);
    // The orphan stays listed, marked, before the frame says anything.
    expect(screen.getByTestId("page-anchor-missing")).toHaveTextContent(/not found in this version/i);
    expect(within(screen.getByTestId("page-annotations")).getByText(/this sentence is wrong/)).toBeInTheDocument();
    // The frame's live re-find wins once it reports.
    const win = fakeFrameWindow();
    pinsStatus(win, [true]);
    expect(screen.queryByTestId("page-anchor-missing")).not.toBeInTheDocument();
  });

  it("shows a save the watch refused, with the reason", () => {
    const refused: Artifact = {
      ...pageArtifact,
      id: "art_page_refused",
      fileWatch: {
        refused: {
          at: new Date().toISOString(),
          sourcePath: "docs/cache.html",
          cause: "gate",
          message: "the new text matches an approach your pair rejected (\"Deploy: Railway\"): too expensive",
          digest: "d",
        },
      },
    };
    useArtifactStore.getState().addArtifact(refused);
    render(<PageArtifact artifact={refused} />);
    const note = screen.getByTestId("page-file-refused");
    expect(note).toHaveTextContent(/was not recorded/);
    expect(note).toHaveTextContent(/too expensive/);
    expect(note).toHaveTextContent(/still looking at v1/);
  });
});

// --- #680 slice 4: "Rule this out" on the selected spot -------------------------

describe("PageArtifact — rule this out (#680 slice 4)", () => {
  let posts: Array<{ url: string; body: any }>;
  let reply: () => Response;
  /** The fake daemon's live stance list, served at GET /api/memory. */
  let memoryRows: Array<{ description: string; sourceArtifactId?: string }>;
  beforeEach(() => {
    posts = [];
    memoryRows = [];
    reply = () =>
      new Response(
        JSON.stringify({
          status: "recorded",
          description: "Up to 60s",
          alreadyRecorded: false,
          comment: {
            id: "cmt_rule_out",
            sessionId: "sess_1",
            target: { artifactId: pageArtifact.id, htmlAnchor: { ...cellAnchor, version: 1 } },
            parentCommentId: null,
            author: "human",
            content: "sixty seconds of stale sessions",
            ruleOut: { description: "Up to 60s" },
            acknowledged: false,
            createdAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") posts.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (String(url).includes("/rule-out")) return reply();
        if (String(url).endsWith("/api/memory")) {
          return new Response(JSON.stringify({ rejectedApproaches: memoryRows, approvedPatterns: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "sess_1", activeSessions: [{ sessionId: "sess_1", live: true }], disconnectedSince: null } as any);
    useConnectionGraceStore.setState({ everConnected: true, graceOver: false, hydrationStalled: false });
  });

  const ruleOutPosts = () => posts.filter((p) => p.url.includes("/rule-out"));

  it("is offered only once a spot is selected", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.queryByRole("button", { name: "Rule this out" })).not.toBeInTheDocument();
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(within(screen.getByTestId("page-anchor-composer")).getByRole("button", { name: "Rule this out" })).toBeInTheDocument();
  });

  it("is misclick-safe: the first click only opens a confirm step, and confirm needs a reason", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    const composer = screen.getByTestId("page-anchor-composer");
    await userEvent.click(within(composer).getByRole("button", { name: "Rule this out" }));
    expect(ruleOutPosts()).toHaveLength(0);
    const panel = screen.getByTestId("page-rule-out-panel");
    // Shows the exact phrase that will be recorded, and the composer is still there.
    expect(panel).toHaveTextContent("Rule out “Up to 60s”?");
    expect(within(composer).getByLabelText("Comment on the selected spot")).toBeInTheDocument();
    const confirm = within(panel).getByRole("button", { name: "Rule it out" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(panel).getByRole("textbox"), "   ");
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(ruleOutPosts()).toHaveLength(0);
    // Escape (in the reason box) cancels without writing.
    await userEvent.type(within(panel).getByRole("textbox"), "{Escape}");
    expect(screen.queryByTestId("page-rule-out-panel")).not.toBeInTheDocument();
    expect(ruleOutPosts()).toHaveLength(0);
  });

  it("submits the anchor and the human's reason to the rule-out route, then shows it ruled out", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    await userEvent.click(within(screen.getByTestId("page-anchor-composer")).getByRole("button", { name: "Rule this out" }));
    const panel = screen.getByTestId("page-rule-out-panel");
    await userEvent.type(within(panel).getByRole("textbox"), "  sixty seconds of stale sessions ");
    await userEvent.click(within(panel).getByRole("button", { name: "Rule it out" }));

    expect(ruleOutPosts()).toHaveLength(1);
    expect(ruleOutPosts()[0]!.url).toContain(`/api/artifacts/${pageArtifact.id}/rule-out`);
    expect(ruleOutPosts()[0]!.body).toEqual({
      htmlAnchor: { ...cellAnchor, version: pageArtifact.version },
      reason: "sixty seconds of stale sessions",
    });
    // No comment POST and no status change: the page stays under review.
    expect(posts.some((p) => p.url.includes("/api/comments") || p.url.includes("/status"))).toBe(false);
    expect(await screen.findByTestId("page-rule-out-recorded")).toHaveTextContent("Ruled out “Up to 60s”");
    // The returned comment is listed on the page, marked.
    expect(await screen.findByTestId("page-annotation-ruled-out")).toBeInTheDocument();
  });

  it("keeps the panel and the reason when the server refuses, showing why", async () => {
    reply = () =>
      new Response(
        JSON.stringify({ error: "The gate can't find “Up to 60s” within one block of this page, so it would never fire.", code: "rule_out_not_gateable", reason: "not_on_page" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    await userEvent.click(within(screen.getByTestId("page-anchor-composer")).getByRole("button", { name: "Rule this out" }));
    const panel = screen.getByTestId("page-rule-out-panel");
    await userEvent.type(within(panel).getByRole("textbox"), "too stale");
    await userEvent.click(within(panel).getByRole("button", { name: "Rule it out" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/would never fire/);
    expect(within(panel).getByRole("textbox")).toHaveValue("too stale");
    expect(screen.queryByTestId("page-rule-out-recorded")).not.toBeInTheDocument();
  });

  it.each([
    ["no_text", { kind: "element", locator: "img", quote: "" }],
    ["too_short", { kind: "cell", locator: "td", quote: "None" }],
    ["too_generic", { kind: "text", locator: "p", quote: "of the" }],
  ] as const)("says why before submit and stays disabled for a spot it can't rule out (%s)", async (why, anchor) => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor });
    const composer = screen.getByTestId("page-anchor-composer");
    const button = within(composer).getByRole("button", { name: "Rule this out" });
    expect(button).toBeDisabled();
    expect(within(composer).getByTestId("page-rule-out-unavailable")).toHaveTextContent(PAGE_RULE_OUT_MESSAGES[why]);
    await userEvent.click(button);
    expect(screen.queryByTestId("page-rule-out-panel")).not.toBeInTheDocument();
    expect(ruleOutPosts()).toHaveLength(0);
  });
  const ruleOutComment = (id: string): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id, htmlAnchor: { ...cellAnchor, kind: "cell", version: 1 } },
    parentCommentId: null,
    author: "human",
    content: "sixty seconds of stale sessions",
    ruleOut: { description: "Up to 60s" },
    acknowledged: false,
    createdAt: new Date().toISOString(),
  });

  it("shows a spot as ruled out from the LIVE stance list", async () => {
    memoryRows = [{ description: "Up to 60s", sourceArtifactId: pageArtifact.id }];
    useArtifactStore.getState().addComment(ruleOutComment("cmt_ro_live"));
    render(<PageArtifact artifact={pageArtifact} />);
    expect(await screen.findByTestId("page-annotation-ruled-out")).toBeInTheDocument();
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(await screen.findByTestId("page-rule-out-recorded")).toHaveTextContent("Ruled out “Up to 60s”");
    expect(screen.queryByRole("button", { name: "Rule this out" })).not.toBeInTheDocument();
  });

  it("a retired stance stops showing as ruled out, and the spot can be ruled out again", async () => {
    memoryRows = []; // retired in the Ledger: the comment marker remains, the stance doesn't
    useArtifactStore.getState().addComment(ruleOutComment("cmt_ro_retired"));
    render(<PageArtifact artifact={pageArtifact} />);
    expect(await screen.findByTestId("page-annotation-ruled-out-retired")).toBeInTheDocument();
    expect(screen.queryByTestId("page-annotation-ruled-out")).not.toBeInTheDocument();
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    expect(within(screen.getByTestId("page-anchor-composer")).getByRole("button", { name: "Rule this out" })).toBeEnabled();
    expect(screen.queryByTestId("page-rule-out-recorded")).not.toBeInTheDocument();
  });

  it("the confirm copy says it reaches only pages that still contain the text", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    await userEvent.click(within(screen.getByTestId("page-anchor-composer")).getByRole("button", { name: "Rule this out" }));
    expect(screen.getByTestId("page-rule-out-panel")).toHaveTextContent(/won't present a page that still contains this text/);
    expect(screen.getByTestId("page-rule-out-panel")).toHaveTextContent(/only applies to pages/);
    expect(screen.getByTestId("page-rule-out-panel")).toHaveTextContent(/this page's status doesn't change/);
    expect(screen.getByTestId("page-rule-out-panel")).not.toHaveTextContent(/stays under review/);
  });
  it("submit, then retire the stance with the spot still selected: the control is usable again", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "anchor", anchor: cellAnchor });
    await userEvent.click(within(screen.getByTestId("page-anchor-composer")).getByRole("button", { name: "Rule this out" }));
    const panel = screen.getByTestId("page-rule-out-panel");
    await userEvent.type(within(panel).getByRole("textbox"), "too stale");
    await userEvent.click(within(panel).getByRole("button", { name: "Rule it out" }));
    // Optimistic: shown as ruled out at once (the live list hasn't refreshed yet).
    expect(await screen.findByTestId("page-rule-out-recorded")).toBeInTheDocument();

    // Retired in the Ledger: the live list refreshes without the row.
    memoryRows = [];
    act(() => {
      useLedgerStore.setState({ version: useLedgerStore.getState().version + 1 });
    });
    const again = await within(screen.getByTestId("page-anchor-composer")).findByRole("button", { name: "Rule this out" });
    expect(again).toBeEnabled();
    expect(screen.queryByTestId("page-rule-out-recorded")).not.toBeInTheDocument();
  });
});

describe("PageArtifact — what changed since the previous version (#714 gap 2)", () => {
  const V1_HTML =
    "<h2>Storage</h2><p>We store rows in Postgres.</p>" +
    "<h2>Costs</h2><p>About $40 a month.</p><p>Plus egress.</p><p>Plus support.</p>" +
    "<h2>Rollout</h2><ul><li>Canary 5%</li></ul>";
  const V2_HTML =
    "<h2>Storage</h2><p>We store rows in SQLite.</p>" +
    "<h2>Costs</h2><p data-dp-changed>About $40 a month.</p>" +
    "<h2>Rollout</h2><ul><li>Canary 5%</li><li data-dp-changed>Then 100%</li></ul>" +
    "<h2>Risks</h2><p>Lock contention.</p>";
  const v1: Artifact = { ...pageArtifact, id: "art_pg_v1", version: 1, status: "superseded", content: { title: "Plan", html: V1_HTML, summary: "Old summary" } };
  const v2: Artifact = {
    ...pageArtifact,
    id: "art_pg_v2",
    version: 2,
    parentId: v1.id,
    agentReasoning: "Switched storage to SQLite and added a risks section",
    content: { title: "Plan", html: V2_HTML, summary: "New summary" },
  };
  beforeEach(() => {
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);
  });

  it("v2+: the toggle defaults on, the summary lists sections, and the reason is shown", async () => {
    render(<PageArtifact artifact={v2} />);
    const toggle = screen.getByTestId("page-changes-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Changes since v1: on");
    // The diff lands off the render path.
    expect(await screen.findByTestId("page-change-summary-line")).toHaveTextContent(
      "Changed: Storage, Rollout; Added: Risks; Removed: 2 paragraphs under Costs",
    );
    expect(screen.getByTestId("page-revise-reason")).toHaveTextContent("Why v2: Switched storage to SQLite and added a risks section");
    expect(screen.getByTestId("page-summary-changed")).toBeInTheDocument();
    // Removed blocks can't be marked in the frame: they're listed as text.
    const removed = screen.getByTestId("page-changes-removed");
    expect(within(removed).getByText("Plus egress.")).toBeInTheDocument();
    expect(within(removed).getByText("Plus support.")).toBeInTheDocument();
    // Honest counting: highlights, split into detected changes and author hints.
    expect(screen.getByTestId("page-changes-count")).toHaveTextContent("5 highlights");
    expect(screen.getByTestId("page-changes-breakdown")).toHaveTextContent("(4 changes · 1 author hint)");
  });

  it("v1: no toggle, no changes panel", () => {
    const first: Artifact = { ...pageArtifact, id: "art_pg_first", content: { title: "Plan", html: V1_HTML } };
    render(<PageArtifact artifact={first} />);
    expect(screen.queryByTestId("page-changes-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("page-version-changes")).not.toBeInTheDocument();
  });

  it("sends validated change locators on ready, navigates between highlights, and turns them off", async () => {
    render(<PageArtifact artifact={v2} />);
    await screen.findByTestId("page-changes-count");
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "ready" });
    const sent = win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "changes");
    expect(sent.at(-1)).toEqual({
      dp: "changes",
      show: true,
      marks: [
        { kind: "changed", tag: "p", text: "We store rows in SQLite.", occurrence: 0 },
        { kind: "added", tag: "li", text: "Then 100%", occurrence: 0 },
        { kind: "added", tag: "h2", text: "Risks", occurrence: 0 },
        { kind: "added", tag: "p", text: "Lock contention.", occurrence: 0 },
        { kind: "hinted", tag: "p", text: "About $40 a month.", occurrence: 0 },
      ],
    });
    // The frame says the second one is missing: navigation skips it.
    fromFrame(win, { dp: "changes-status", found: [true, false, true, true, true] });
    expect(screen.getByTestId("page-changes-count")).toHaveTextContent("4 highlights");
    await userEvent.click(screen.getByRole("button", { name: "Next highlight" }));
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-change", index: 0 }, "*");
    await userEvent.click(screen.getByRole("button", { name: "Next highlight" }));
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-change", index: 2 }, "*");
    await userEvent.click(screen.getByRole("button", { name: "Previous highlight" }));
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-change", index: 0 }, "*");

    await userEvent.click(screen.getByTestId("page-changes-toggle"));
    expect(screen.getByTestId("page-changes-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(win.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ dp: "changes", show: false }), "*");
    expect(screen.queryByTestId("page-changes-nav")).not.toBeInTheDocument();
  });

  it("ignores the frame's changes-status once the page's scripts run (the companion's count stands)", async () => {
    const scripted: Artifact = { ...v2, id: "art_pg_v2s", content: { title: "Plan", html: `${V2_HTML}<script>1</script>` } };
    useArtifactStore.getState().addArtifact(scripted);
    render(<PageArtifact artifact={scripted} />);
    await screen.findByTestId("page-changes-count");
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "changes-status", found: [false, false, false, false, false] });
    expect(screen.getByTestId("page-changes-count")).toHaveTextContent("5 highlights");
  });

  it("counts changes it can't outline (loose text in a whole region), so the counter agrees with the summary", async () => {
    const md = (b: string) => `<main><h2>Alpha</h2>text A<h2>Beta</h2>${b}</main><p>Card</p>`;
    const a: Artifact = { ...pageArtifact, id: "art_md1", version: 1, status: "superseded", content: { title: "MD", html: md("text B") } };
    const b: Artifact = { ...pageArtifact, id: "art_md2", version: 2, parentId: a.id, content: { title: "MD", html: md("text B edited") } };
    useArtifactStore.getState().addArtifact(a);
    useArtifactStore.getState().addArtifact(b);
    render(<PageArtifact artifact={b} />);
    expect(await screen.findByTestId("page-change-summary-line")).toHaveTextContent("Changed: Beta");
    expect(screen.getByTestId("page-changes-unhighlightable")).toHaveTextContent("(1 change not highlightable)");
  });

  it("discloses the cap: showing 300 of the true total", async () => {
    const many = (w: string) => Array.from({ length: 320 }, (_, i) => `<p>${w} ${i}</p>`).join("");
    const a: Artifact = { ...pageArtifact, id: "art_cap1", version: 1, status: "superseded", content: { title: "Big", html: many("old") } };
    const b: Artifact = { ...pageArtifact, id: "art_cap2", version: 2, parentId: a.id, content: { title: "Big", html: many("new") } };
    useArtifactStore.getState().addArtifact(a);
    useArtifactStore.getState().addArtifact(b);
    render(<PageArtifact artifact={b} />);
    expect(await screen.findByTestId("page-changes-breakdown")).toHaveTextContent("(320 changes; showing 300 of 320)");
  });

  it("compare with: defaults to the immediate predecessor, offers earlier loaded versions (auto-saves marked)", async () => {
    const recorded = (from: Artifact) => ({
      recorded: { at: new Date().toISOString(), sourcePath: "docs/plan.html", fromArtifactId: from.id, fromVersion: from.version, carriedCount: 0, orphaned: [] },
    });
    const v2a: Artifact = { ...v2, status: "superseded", fileWatch: recorded(v1) };
    const v3: Artifact = {
      ...v2,
      id: "art_pg_v3",
      version: 3,
      parentId: v2.id,
      agentReasoning: "Recorded automatically from docs/plan.html after a save.",
      content: { title: "Plan", html: V2_HTML.replace("Lock contention.", "Lock contention under load.") },
      fileWatch: recorded(v2a),
    };
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2a);
    useArtifactStore.getState().addArtifact(v3);
    render(<PageArtifact artifact={v3} />);
    const panel = screen.getByTestId("page-version-changes");
    // A file-watch version: the watch notice, not its boilerplate reason.
    expect(within(panel).getByTestId("page-file-recorded")).toHaveTextContent(/replacing v2/);
    expect(within(panel).queryByTestId("page-revise-reason")).not.toBeInTheDocument();
    expect(await within(panel).findByTestId("page-change-summary-line")).toHaveTextContent("Changed: Risks");
    const select = screen.getByLabelText("Compare with") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["v2 (auto-save)", "v1"]);
    await userEvent.selectOptions(select, v1.id);
    expect(screen.getByTestId("page-changes-toggle")).toHaveTextContent("Changes since v1");
    expect(await within(panel).findByText(/Changed: Storage, Rollout; Added: Risks/)).toBeInTheDocument();
  });
});

// --- #714 gaps 4+5: outline rail and "Wants from you" ------------------------
describe("PageArtifact — outline and asks (#714 gaps 4+5)", () => {
  const OUTLINE = {
    dp: "outline",
    headings: [
      { level: 1, text: "Cache invalidation", locator: "h1" },
      { level: 2, text: "Options", locator: "#options > h2:nth-of-type(1)" },
      { level: 3, text: "TTL expiry", locator: "#ttl" },
    ],
    pins: [] as number[],
    changes: [] as number[],
  };
  const ASKS = {
    dp: "asks",
    asks: [
      { kind: "decision", id: "decide-ttl", text: "Decide: a 60s TTL, or invalidate on write?", locator: "#decide-ttl" },
      { kind: "question", id: "ask-budget", text: "Is one more Redis instance in budget?", locator: "#ask-budget" },
    ],
    pinAsks: [] as number[],
  };
  const human = (id: string, anchor: Record<string, unknown>, extra: Partial<Comment> = {}): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id, htmlAnchor: anchor as any },
    parentCommentId: null,
    author: "human",
    content: `note ${id}`,
    acknowledged: false,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "")) || 0)).toISOString(),
    ...extra,
  });

  it("renders nothing until the frame reports headings or asks", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.queryByTestId("page-outline-rail")).not.toBeInTheDocument();
    expect(screen.queryByTestId("page-outline-disclosure")).not.toBeInTheDocument();
    expect(screen.queryByTestId("page-asks")).not.toBeInTheDocument();
  });

  it("renders the outline as a rail and a disclosure, as text, and jumps the frame to a heading", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { ...OUTLINE, headings: [...OUTLINE.headings, { level: 2, text: "<img src=x onerror=alert(1)>", locator: "h2" }] });
    const rail = screen.getByTestId("page-outline-rail");
    expect(rail).toHaveAttribute("aria-label", "Page outline");
    const entries = within(rail).getAllByTestId("page-outline-entry");
    expect(entries.map((e) => e.textContent)).toEqual(["Cache invalidation", "Options", "TTL expiry", "<img src=x onerror=alert(1)>"]);
    expect(entries.map((e) => e.getAttribute("data-level"))).toEqual(["1", "2", "3", "2"]);
    // Frame text is never markup.
    expect(rail.querySelector("img")).toBeNull();
    expect(screen.getByTestId("page-outline-disclosure")).toBeInTheDocument();
    await userEvent.click(within(rail).getByRole("button", { name: /Go to Options/ }));
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-heading", index: 1, locator: "#options > h2:nth-of-type(1)" }, "*");
    expect(within(rail).getByRole("button", { name: /Go to Options/ })).toHaveAttribute("aria-current", "location");
    // Keyboard: entries are buttons in tab order; Enter jumps too.
    within(rail).getByRole("button", { name: /Go to TTL expiry/ }).focus();
    await userEvent.keyboard("{Enter}");
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-heading", index: 2, locator: "#ttl" }, "*");
  });

  it("highlights the section the frame reports as current (reading progress)", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, OUTLINE);
    const rail = screen.getByTestId("page-outline-rail");
    expect(within(rail).getByTestId("page-outline-progress")).toHaveTextContent("Top of the page (3 sections)");
    fromFrame(win, { dp: "outline-active", index: 2 });
    expect(within(rail).getByRole("button", { name: /TTL expiry, you are here/ })).toHaveAttribute("aria-current", "location");
    expect(within(rail).getByTestId("page-outline-progress")).toHaveTextContent("Section 3 of 3: TTL expiry");
    // Out of range or from another source: ignored.
    fromFrame(win, { dp: "outline-active", index: 999 });
    fromFrame({ postMessage: vi.fn() }, { dp: "outline-active", index: 0 });
    expect(within(rail).getByTestId("page-outline-progress")).toHaveTextContent("Section 3 of 3");
    // The outline shrinks before the frame re-reports where you are: no crash.
    fromFrame(win, { ...OUTLINE, headings: OUTLINE.headings.slice(0, 1) });
    expect(within(screen.getByTestId("page-outline-rail")).getByTestId("page-outline-progress")).toHaveTextContent("Top of the page (1 section)");
  });

  it("badges open comments per section (resolved and not-found ones excluded) and ignores a stale pin report", () => {
    const comments = [
      human("cmt_1", { kind: "element", locator: "#ttl > p", quote: "a" }),
      human("cmt_2", { kind: "element", locator: "#ttl > p:nth-of-type(2)", quote: "b" }),
      human("cmt_3", { kind: "element", locator: "h1", quote: "Cache invalidation" }, { humanResolvedAt: new Date().toISOString() }),
      human("cmt_4", { kind: "element", locator: "#options", quote: "c" }),
      human("cmt_5", { kind: "text", locator: "p", quote: "gone" }),
    ];
    for (const c of comments) useArtifactStore.getState().addComment(c);
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    pinsStatus(win, [true, true, true, true, false]);
    // A report for a different pin list (4 pins, not 5) is not counted.
    fromFrame(win, { ...OUTLINE, pins: [2, 2, 0, 1] });
    expect(screen.queryAllByTestId("page-outline-comments")).toHaveLength(0);
    fromFrame(win, { ...OUTLINE, pins: [2, 2, 0, 1, 1] });
    const rail = screen.getByTestId("page-outline-rail");
    const badges = within(rail).getAllByTestId("page-outline-entry").map((e) => within(e).queryByTestId("page-outline-comments")?.textContent ?? "");
    // Rolled up: a heading counts its subsections up to the next heading of
    // the same or higher level (own counts are 0 / 1 / 2).
    expect(badges).toEqual(["3", "3", "2"]);
    expect(within(rail).getByRole("button", { name: "Go to Cache invalidation, 3 open comments (0 in this section, 3 in subsections)" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Go to Options, 3 open comments (1 in this section, 2 in subsections)" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Go to TTL expiry, 2 open comments" })).toBeInTheDocument();
  });

  it("rolls change counts up to the next heading of the same or higher level", async () => {
    const v1: Artifact = { ...pageArtifact, id: "art_ru_v1", version: 1, status: "superseded", content: { title: "P", html: "<h2>A</h2><p>a</p><h3>A1</h3><p>b</p><h2>B</h2><p>c</p>" } };
    const v2: Artifact = { ...pageArtifact, id: "art_ru_v2", version: 2, parentId: v1.id, content: { title: "P", html: "<h2>A</h2><p>a!</p><h3>A1</h3><p>b!</p><h2>B</h2><p>c!</p>" } };
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);
    render(<PageArtifact artifact={v2} />);
    await screen.findByTestId("page-changes-count");
    const win = fakeFrameWindow();
    const headings = [
      { level: 2, text: "A", locator: "h2:nth-of-type(1)" },
      { level: 3, text: "A1", locator: "h3" },
      { level: 2, text: "B", locator: "h2:nth-of-type(2)" },
    ];
    fromFrame(win, { dp: "outline", headings, pins: [], changes: [0, 1, 2] });
    const rail = screen.getByTestId("page-outline-rail");
    expect(within(rail).getAllByTestId("page-outline-changes").map((b) => b.textContent)).toEqual(["~2", "~1", "~1"]);
    expect(within(rail).getByRole("button", { name: "Go to A, 2 changed blocks (1 in this section, 1 in subsections)" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Go to B, 1 changed block" })).toBeInTheDocument();
  });

  it("badges changed blocks per section from the version diff (while changes are shown)", async () => {
    const v1: Artifact = { ...pageArtifact, id: "art_ol_v1", version: 1, status: "superseded", content: { title: "P", html: "<h2>A</h2><p>one</p><h2>B</h2><p>two</p>" } };
    const v2: Artifact = { ...pageArtifact, id: "art_ol_v2", version: 2, parentId: v1.id, content: { title: "P", html: "<h2>A</h2><p>one!</p><h2>B</h2><p>two!</p><p>three</p>" } };
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);
    render(<PageArtifact artifact={v2} />);
    await screen.findByTestId("page-changes-count");
    const win = fakeFrameWindow();
    const headings = [{ level: 2, text: "A", locator: "h2:nth-of-type(1)" }, { level: 2, text: "B", locator: "h2:nth-of-type(2)" }];
    fromFrame(win, { dp: "outline", headings, pins: [], changes: [0, 1, 1] });
    const rail = screen.getByTestId("page-outline-rail");
    expect(within(rail).getAllByTestId("page-outline-changes").map((b) => b.textContent)).toEqual(["~1", "~2"]);
    expect(within(rail).getByRole("button", { name: "Go to B, 2 changed blocks" })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("page-changes-toggle"));
    expect(within(rail).queryAllByTestId("page-outline-changes")).toHaveLength(0);
  });

  it("shows 'Wants from you (N)' with kind, text, open/answered state, and Jump scrolls the frame", async () => {
    useArtifactStore.getState().addComment(human("cmt_1", { kind: "text", locator: "#ask-budget > strong:nth-of-type(1)", quote: "budget" }));
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    const key = keyOf(win);
    fromFrame(win, { dp: "pins-status", found: [true], key });
    fromFrame(win, { ...ASKS, pinAsks: [-1], key });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // this version's parse lands
    const strip = screen.getByTestId("page-asks");
    expect(within(strip).getByText("Wants from you (2)")).toBeInTheDocument();
    const items = within(strip).getAllByTestId("page-ask");
    expect(items.map((i) => within(i).getByTestId("page-ask-state").textContent)).toEqual(["Open", "Answered"]);
    expect(within(items[0]!).getByText("Decide")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Question")).toBeInTheDocument();
    expect(within(strip).getByTestId("page-asks-tally")).toHaveTextContent("1 open · 1 answered");
    await userEvent.click(within(items[0]!).getByRole("button", { name: /Show on the page/ }));
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-ask", index: 0, locator: "#decide-ttl" }, "*");
    // Display-only: nothing was created by the report.
    expect(useArtifactStore.getState().comments[pageArtifact.id]).toHaveLength(1);
  });

  it("Reply opens the composer pre-anchored to the ask; submitting marks it answered", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return {
        ok: true,
        json: async () => ({
          comment: {
            id: "cmt_srv_ask", sessionId: "sess_1", target: body.target, parentCommentId: null, author: "human",
            content: body.content, acknowledged: false, createdAt: new Date().toISOString(),
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, ASKS);
    const first = screen.getAllByTestId("page-ask")[0]!;
    await userEvent.click(within(first).getByRole("button", { name: /Reply to/ }));
    expect(win.postMessage).toHaveBeenLastCalledWith({ dp: "focus-ask", index: 0, locator: "#decide-ttl" }, "*");
    const composer = screen.getByTestId("page-anchor-composer");
    expect(within(composer).getByText(/Decide: a 60s TTL, or invalidate on write\?/)).toBeInTheDocument();
    const box = within(composer).getByLabelText("Comment on the selected spot");
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "Invalidate on write");
    await userEvent.click(within(composer).getByRole("button", { name: "Send" }));
    const post = fetchMock.mock.calls.find(([u, init]: any[]) => String(u).includes("/api/comments") && init?.method === "POST") as any;
    expect(JSON.parse(post[1].body).target.htmlAnchor).toEqual({
      kind: "element", locator: "#decide-ttl", quote: "Decide: a 60s TTL, or invalidate on write?", version: pageArtifact.version,
    });
    expect(await within(screen.getAllByTestId("page-ask")[0]!).findByText("Answered")).toBeInTheDocument();
  });

  const states = () => screen.getAllByTestId("page-ask").map((i) => within(i).getByTestId("page-ask-state").textContent);
  /** The key of the pin list the companion last sent this frame (frame
   *  reports echo it); "ready" makes the companion (re)send it. */
  const keyOf = (win: { postMessage: ReturnType<typeof vi.fn> }) => {
    fromFrame(win, { dp: "ready" });
    return win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "pins").at(-1).key as string;
  };

  describe("earlier-version answers: ask continuity", () => {
    const V1 =
      '<div id="db" data-dp-decision>Which database for sessions? <ul><li id="pg">Postgres</li><li>MySQL</li></ul></div>' +
      '<p id="cache" data-dp-question>Isn&rsquo;t the &ldquo;caf&eacute;&rdquo; cache enough?</p>';
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const setup = async (
      v1Html: string | null,
      v2Html: string,
      v2Asks: Array<Record<string, unknown>>,
      comments: Array<[string, Record<string, unknown>]>,
    ) => {
      const v1: Artifact = { ...pageArtifact, id: `art_ac_v1_${Math.random()}`, version: 1, status: "superseded", content: { title: "P", html: v1Html ?? "<p>v1</p>" } };
      const v2: Artifact = { ...pageArtifact, id: `art_ac_v2_${Math.random()}`, version: 2, parentId: v1.id, content: { title: "P", html: v2Html } };
      if (v1Html !== null) useArtifactStore.getState().addArtifact(v1);
      useArtifactStore.getState().addArtifact(v2);
      comments.forEach(([id, anchor]) =>
        useArtifactStore.getState().addComment({ ...human(id, anchor), target: { artifactId: v1.id, htmlAnchor: { ...anchor, version: 1 } as any } }),
      );
      render(<PageArtifact artifact={v2} />);
      const win = fakeFrameWindow();
      const key = keyOf(win);
      fromFrame(win, { dp: "pins-status", found: comments.map(() => true), key });
      // The frame even says every v1 pin sits inside ask 0: never enough for
      // an earlier-version comment.
      fromFrame(win, { dp: "asks", asks: v2Asks, pinAsks: comments.map(() => 0), key });
    };
    const DB = { kind: "decision", id: "db", text: "Which database for sessions? Postgres MySQL", locator: "#db" };
    const CACHE = { kind: "question", id: "cache", text: "Isn\u2019t the \u201Ccaf\u00E9\u201D cache enough?", locator: "#cache" };

    it("the same question kept across a revise stays answered (child option, entity selection) once the parse lands", async () => {
      // v2 spells the apostrophe as the character and adds whitespace: same full text.
      const V2 = V1.replace("&rsquo;", "\u2019").replace("database for", "database \n  for");
      await setup(V1, V2, [DB, CACHE], [
        ["cmt_1", { kind: "element", locator: "#pg", quote: "Postgres" }],
        ["cmt_2", { kind: "text", locator: "#cache", quote: "caf\u00E9" }],
      ]);
      expect(states()).toEqual(["Checking\u2026", "Checking\u2026"]); // parse pending: not counted yet, not "Open" either (#727)
      await flush();
      expect(states()).toEqual(["Answered", "Answered"]);
    });

    it("a reused id for a different question stays open, even with the frame placing the pin inside it (the Postgres probe)", async () => {
      await setup(
        '<div id="q1" data-dp-question>Which DB? <ul><li id="pg">Postgres</li><li>MySQL</li></ul></div>',
        '<div id="q1" data-dp-question>Which Postgres version? <ul><li id="v15">15</li><li>16</li></ul></div>',
        [{ kind: "question", id: "q1", text: "Which Postgres version? 15 16", locator: "#q1" }],
        [["cmt_1", { kind: "element", locator: "#pg", quote: "Postgres" }]],
      );
      await flush();
      expect(states()).toEqual(["Open"]);
    });

    it("a long preamble with only the trailing question changed reopens (the frame's 200-char text is never compared)", async () => {
      const preamble = "Context: " + "we measured the session store under load and ".repeat(8);
      const ask = (q: string) => `<div id="d" data-dp-decision>${preamble}${q}</div>`;
      const frameText = (q: string) => (preamble + q).slice(0, 200); // identical for both questions
      await setup(ask("Which DB?"), ask("Which region?"), [{ kind: "decision", id: "d", text: frameText("Which region?"), locator: "#d" }], [
        ["cmt_1", { kind: "element", locator: "#d", quote: frameText("Which DB?") }],
      ]);
      await flush();
      expect(states()).toEqual(["Open"]);
    });

    it("a reworded question reopens", async () => {
      await setup(V1, V1.replace("Which database for sessions?", "Which database for sessions and caches?"), [DB], [
        ["cmt_1", { kind: "element", locator: "#db", quote: "Which database" }],
      ]);
      await flush();
      expect(states()).toEqual(["Open"]);
    });

    it("an earlier answer isn't vetoed by its pin failing to relocate here: same text, renamed child id (agrees with check_feedback)", async () => {
      const v2Html = V1.replace('id="pg"', 'id="postgres"');
      await setup(V1, v2Html, [DB], [["cmt_1", { kind: "element", locator: "#pg", quote: "Postgres" }]]);
      const win = fakeFrameWindow();
      fromFrame(win, { dp: "pins-status", found: [false], key: keyOf(win) }); // #pg is gone from v2's DOM
      await flush();
      expect(states()).toEqual(["Answered"]);
    });

    it("the old version's HTML not loaded: the comment doesn't count", async () => {
      await setup(null, V1, [DB], [["cmt_1", { kind: "element", locator: "#pg", quote: "Postgres" }]]);
      await flush();
      expect(states()).toEqual(["Open"]);
    });
  });

  it("an earlier version's comment at the same POSITION doesn't answer an id-less ask (probe)", async () => {
    const v1: Artifact = { ...pageArtifact, id: "art_pos_v1", version: 1, status: "superseded", content: { title: "P", html: "<p>v1</p>" } };
    const v2: Artifact = { ...pageArtifact, id: "art_pos_v2", version: 2, parentId: v1.id, content: { title: "P", html: "<p>v2</p>" } };
    useArtifactStore.getState().addArtifact(v1);
    useArtifactStore.getState().addArtifact(v2);
    const anchor = { kind: "element", locator: "body > div:nth-of-type(2)", quote: "An unrelated card", version: 1 };
    useArtifactStore.getState().addComment({ ...human("cmt_1", anchor), target: { artifactId: v1.id, htmlAnchor: anchor as any } });
    render(<PageArtifact artifact={v2} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "asks", asks: [{ kind: "decision", text: "Ship on Friday?", locator: "body > div:nth-of-type(2)" }], pinAsks: [0] });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // v1's parse lands
    expect(states()).toEqual(["Open"]);
  });

  it("resolved comments and comments not found on this version don't answer; a child with its own id does (via the frame)", () => {
    useArtifactStore.getState().addComment(human("cmt_1", { kind: "element", locator: "#decide-ttl", quote: "x" }, { humanResolvedAt: new Date().toISOString() }));
    useArtifactStore.getState().addComment(human("cmt_2", { kind: "element", locator: "#ask-budget", quote: "y" }));
    useArtifactStore.getState().addComment(human("cmt_3", { kind: "element", locator: "#ttl-note", quote: "60s is fine" }));
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    const key = keyOf(win);
    fromFrame(win, { dp: "pins-status", found: [true, false, true], key });
    fromFrame(win, { ...ASKS, key });
    expect(states()).toEqual(["Open", "Open"]);
    // The frame says pin 3 (#ttl-note) sits inside ask 0.
    fromFrame(win, { ...ASKS, pinAsks: [0, 1, 0], key });
    expect(states()).toEqual(["Answered", "Open"]);
    // A report without the pin list's key (or for another list) is not used:
    // nothing reported for the list on screen yet, so not settled (#727).
    fromFrame(win, { ...ASKS, pinAsks: [0, 1, 0] });
    expect(states()).toEqual(["Checking\u2026", "Checking\u2026"]);
    fromFrame(win, { ...ASKS, pinAsks: [0, 1, 0], key: "x0:1" });
    expect(states()).toEqual(["Checking\u2026", "Checking\u2026"]);
  });

  it("ask completion uses the pre-Run pin status, never a live post-Run one (the pin list stays live)", async () => {
    // A current-version comment on a child of ask 0 the frame resolves inside it.
    useArtifactStore.getState().addComment(human("cmt_1", { kind: "element", locator: "#ttl-note", quote: "60s is fine" }));
    render(<PageArtifact artifact={pageArtifact} />);
    let win = fakeFrameWindow();
    const key = keyOf(win);
    fromFrame(win, { dp: "pins-status", found: [true], key });
    fromFrame(win, { ...ASKS, pinAsks: [0], key });
    expect(states()).toEqual(["Answered", "Open"]);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    win = fakeFrameWindow();
    // After Run, page script could post anything: a forged "not found"…
    fromFrame(win, { dp: "pins-status", found: [false], key });
    expect(states()).toEqual(["Answered", "Open"]);
    // …which the pin list does show (it renders live status).
    expect(screen.getByTestId("page-anchor-missing")).toBeInTheDocument();
  });

  it("a report computed for the previous pin list is never attributed to the new one (delete + add in one round trip)", () => {
    useArtifactStore.getState().addComment(human("cmt_1", { kind: "element", locator: "#ttl-note", quote: "60s is fine" }));
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    const oldKey = keyOf(win);
    // Before the frame's report for [cmt_1] arrives, cmt_1 is deleted and
    // cmt_2 (elsewhere on the page) is added: still one pin, a different one.
    act(() => {
      useArtifactStore.setState((st) => ({ comments: { ...st.comments, [pageArtifact.id]: [] } }));
      useArtifactStore.getState().addComment(human("cmt_2", { kind: "element", locator: "#elsewhere", quote: "x" }));
    });
    // The in-flight report for the old list lands now.
    fromFrame(win, { dp: "pins-status", found: [true], key: oldKey });
    fromFrame(win, { ...ASKS, pinAsks: [0], key: oldKey });
    expect(states()).toEqual(["Checking\u2026", "Checking\u2026"]); // never Answered; awaiting the new list's report (#727)
    // The frame's report for the new list (cmt_2 isn't in any ask) agrees.
    const newKey = keyOf(win);
    expect(newKey).not.toBe(oldKey);
    fromFrame(win, { dp: "pins-status", found: [true], key: newKey });
    fromFrame(win, { ...ASKS, pinAsks: [-1], key: newKey });
    expect(states()).toEqual(["Open", "Open"]);
  });

  describe("#727 — neutral checking state before the frame's first report", () => {
    it("an unanswered ask reads Checking\u2026 until the frame reports for the pin list on screen, then Open", () => {
      useArtifactStore.getState().addComment(human("cmt_1", { kind: "element", locator: "#elsewhere", quote: "x" }));
      render(<PageArtifact artifact={pageArtifact} />);
      const win = fakeFrameWindow();
      const key = keyOf(win);
      fromFrame(win, { ...ASKS, pinAsks: [-1], key });
      expect(states()).toEqual(["Checking\u2026", "Checking\u2026"]);
      expect(screen.getAllByTestId("page-ask").map((i) => i.getAttribute("data-state"))).toEqual(["checking", "checking"]);
      expect(screen.getByTestId("page-asks-tally")).toHaveTextContent("2 checking · 0 answered");
      expect(screen.getByTestId("page-asks")).toHaveAccessibleName("Wants from you: 2 asks, 2 checking");
      fromFrame(win, { dp: "pins-status", found: [true], key });
      expect(states()).toEqual(["Open", "Open"]);
      expect(screen.getByTestId("page-asks-tally")).toHaveTextContent("2 open · 0 answered");
    });

    it("an answer already known shows Answered while the rest are checking", () => {
      useArtifactStore.getState().addComment(human("cmt_1", { kind: "text", locator: "#ask-budget > strong:nth-of-type(1)", quote: "budget" }));
      render(<PageArtifact artifact={pageArtifact} />);
      const win = fakeFrameWindow();
      fromFrame(win, { ...ASKS, key: keyOf(win) });
      expect(states()).toEqual(["Checking\u2026", "Answered"]);
      expect(screen.getByTestId("page-asks-tally")).toHaveTextContent("1 checking · 1 answered");
    });

    it("no comments: nothing can answer an ask, so it is Open at once", () => {
      render(<PageArtifact artifact={pageArtifact} />);
      const win = fakeFrameWindow();
      fromFrame(win, ASKS);
      expect(states()).toEqual(["Open", "Open"]);
    });

    it("read-only still settles from the frame's report and offers no Reply", () => {
      useArtifactStore.getState().addComment(human("cmt_1", { kind: "element", locator: "#elsewhere", quote: "x" }));
      render(<PageArtifact artifact={{ ...pageArtifact, status: "superseded" }} />);
      const win = fakeFrameWindow();
      const key = keyOf(win);
      fromFrame(win, { ...ASKS, pinAsks: [-1], key });
      expect(states()).toEqual(["Checking\u2026", "Checking\u2026"]);
      fromFrame(win, { dp: "pins-status", found: [true], key });
      expect(states()).toEqual(["Open", "Open"]);
      expect(screen.queryByRole("button", { name: /Reply to/ })).toBeNull();
    });

    it("after Run the frozen reports aren't awaited: a comment added then doesn't leave asks checking", async () => {
      const page: Artifact = { ...pageArtifact, id: "art_page_727run", content: { title: "P", html: '<p id="decide-ttl" data-dp-decision>Decide?</p><script>1</script>' } };
      useArtifactStore.getState().addArtifact(page);
      render(<PageArtifact artifact={page} />);
      let win = fakeFrameWindow();
      fromFrame(win, { ...ASKS, key: keyOf(win) });
      expect(states()).toEqual(["Open", "Open"]);
      await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
      win = fakeFrameWindow();
      act(() => {
        useArtifactStore.getState().addComment({ ...human("cmt_r", { kind: "element", locator: "#elsewhere", quote: "x" }), target: { artifactId: page.id, htmlAnchor: { kind: "element", locator: "#elsewhere", quote: "x", version: page.version } as any } });
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // this version's parse lands
      expect(states()).toEqual(["Open", "Open"]);
    });
  });

  it("after Run, a new comment on a child with its own id inside an ask answers it (child ids from this version's parse)", async () => {
    const page: Artifact = {
      ...pageArtifact,
      id: "art_page_child",
      content: { title: "P", html: '<p id="decide-ttl" data-dp-decision>Decide: a 60s TTL, or invalidate on write? <em id="ttl-note">60s</em></p><script>1</script>' },
    };
    useArtifactStore.getState().addArtifact(page);
    render(<PageArtifact artifact={page} />);
    let win = fakeFrameWindow();
    fromFrame(win, { ...ASKS, key: keyOf(win) });
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    win = fakeFrameWindow();
    act(() => {
      useArtifactStore.getState().addComment({
        ...human("cmt_1", { kind: "element", locator: "#ttl-note", quote: "60s" }),
        target: { artifactId: page.id, htmlAnchor: { kind: "element", locator: "#ttl-note", quote: "60s" } as any },
      });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(states()).toEqual(["Answered", "Open"]);
  });

  it("ignores outline, reading progress and asks reports while the page's scripts run (pre-Run values stand)", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    let win = fakeFrameWindow();
    fromFrame(win, OUTLINE);
    fromFrame(win, ASKS);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    win = fakeFrameWindow();
    fromFrame(win, { ...OUTLINE, headings: [{ level: 1, text: "Forged", locator: "h1" }] });
    fromFrame(win, { dp: "outline-active", index: 2 });
    fromFrame(win, { dp: "asks", asks: [], pinAsks: [] });
    const rail = screen.getByTestId("page-outline-rail");
    expect(within(rail).getAllByTestId("page-outline-entry").map((e) => e.textContent)).toEqual(["Cache invalidation", "Options", "TTL expiry"]);
    expect(within(rail).getByTestId("page-outline-progress")).toHaveTextContent("Top of the page");
    expect(screen.getAllByTestId("page-ask")).toHaveLength(2);
  });

  it("a read-only page lists asks without Reply; malformed or foreign ask reports are ignored", () => {
    const retracted: Artifact = { ...pageArtifact, id: "art_page_ro", status: "retracted" };
    useArtifactStore.getState().addArtifact(retracted);
    render(<PageArtifact artifact={retracted} />);
    const win = fakeFrameWindow();
    fromFrame({ postMessage: vi.fn() }, ASKS);
    fromFrame(win, { dp: "asks", asks: [{ ...ASKS.asks[0], kind: "approve" }], pinAsks: [] });
    expect(screen.queryByTestId("page-asks")).not.toBeInTheDocument();
    fromFrame(win, ASKS);
    const strip = screen.getByTestId("page-asks");
    expect(within(strip).queryByRole("button", { name: /Reply to/ })).not.toBeInTheDocument();
    expect(within(strip).getAllByRole("button", { name: /Show on the page/ })).toHaveLength(2);
  });
});

// --- #714 gaps 7+8: the review queue and the composer beside its anchor ------

describe("PageArtifact — review queue and composer placement (#714 gaps 7+8)", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 10, n)).toISOString();
  const root = (id: string, n: number, quote: string, extra: Partial<Comment> = {}): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id, htmlAnchor: { kind: "text", locator: "p", quote } },
    parentCommentId: null,
    author: "human",
    content: `comment on ${quote}`,
    acknowledged: false,
    createdAt: at(n),
    ...extra,
  });
  const reply = (id: string, parent: string, n: number, author: "human" | "agent"): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id },
    parentCommentId: parent,
    author,
    content: `${author} reply`,
    acknowledged: false,
    createdAt: at(n),
  });
  /** open (not seen), open (seen by agent, 1 human reply), addressed in a
   *  revision, answered by the agent (1 agent reply), and one whose spot is
   *  gone (orphaned once the frame reports). */
  function seed() {
    const add = useArtifactStore.getState().addComment;
    add(root("c_open", 1, "alpha"));
    add(root("c_seen", 2, "beta", { acknowledged: true }));
    add(reply("r_seen", "c_seen", 3, "human"));
    add(root("c_rev", 4, "gamma", { acknowledged: true, addressedIn: { artifactId: "art_page_v2", version: 2 } }));
    add(root("c_ans", 5, "delta"));
    add(reply("r_ans", "c_ans", 6, "agent"));
    add(root("c_gone", 7, "epsilon"));
  }
  const rows = () => screen.getAllByTestId("page-annotation");
  const ids = () => rows().map((r) => r.getAttribute("data-comment-id"));

  it("filters Open / Addressed / Orphaned with counts, and says each state in its own words", async () => {
    seed();
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    pinsStatus(win, [true, true, true, true, false]);
    const filters = screen.getByTestId("page-queue-filters");
    expect(within(filters).getByTestId("page-queue-filter-open")).toHaveTextContent("Open 2");
    expect(within(filters).getByTestId("page-queue-filter-addressed")).toHaveTextContent("Addressed 2");
    expect(within(filters).getByTestId("page-queue-filter-orphaned")).toHaveTextContent("Orphaned 1");
    expect(within(filters).getByTestId("page-queue-filter-all")).toHaveTextContent("All 5");
    // Open is the default while anything is open.
    expect(within(filters).getByTestId("page-queue-filter-open")).toHaveAttribute("aria-pressed", "true");
    expect(ids()).toEqual(["c_open", "c_seen"]);
    expect(within(rows()[0]!).getByTestId("page-annotation-state")).toHaveTextContent(/^Open$/);
    expect(within(rows()[1]!).getByTestId("page-annotation-state")).toHaveTextContent("Seen by agent");
    expect(within(rows()[1]!).getByTestId("page-annotation-replies")).toHaveTextContent("1 reply");

    await userEvent.click(within(filters).getByTestId("page-queue-filter-addressed"));
    expect(ids()).toEqual(["c_rev", "c_ans"]);
    expect(within(rows()[0]!).getByTestId("page-annotation-state")).toHaveTextContent("Addressed in v2");
    expect(within(rows()[1]!).getByTestId("page-annotation-state")).toHaveTextContent("Answered by the agent");
    expect(within(rows()[1]!).getByTestId("page-annotation-replies")).toHaveTextContent("1 reply");
    // Pin numbers keep the frame's numbering, whatever the filter.
    expect(within(rows()[0]!).getByTestId("page-annotation-pin")).toHaveTextContent("3");

    await userEvent.click(within(filters).getByTestId("page-queue-filter-orphaned"));
    expect(ids()).toEqual(["c_gone"]);
    expect(within(rows()[0]!).getByTestId("page-anchor-missing")).toHaveTextContent("Not found in this version");
  });

  it("sends each pin's colour state and comment id in the pins message (never comment text)", () => {
    seed();
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "ready" });
    const pins = win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "pins").pop() as any;
    expect(pins.states).toEqual(["open", "open", "addressed", "addressed", "open"]);
    expect(pins.ids).toEqual(["c_open", "c_seen", "c_rev", "c_ans", "c_gone"]);
    expect(JSON.stringify(pins)).not.toContain("comment on");
    // A found report doesn't re-send the pins (no feedback loop).
    const before = win.postMessage.mock.calls.filter((c) => (c[0] as any)?.dp === "pins").length;
    pinsStatus(win, [true, true, true, true, false]);
    pinsStatus(win, [true, true, true, true, false]);
    expect(win.postMessage.mock.calls.filter((c) => (c[0] as any)?.dp === "pins").length).toBe(before);
  });

  it("a pin click highlights and reveals its comment (switching filter if needed), and posts nothing", async () => {
    seed();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fetchMock.mockClear();
    fromFrame(win, { dp: "pin-click", id: "c_rev" });
    // c_rev is addressed: the queue switches to Addressed to show it.
    expect(screen.getByTestId("page-queue-filter-addressed")).toHaveAttribute("aria-pressed", "true");
    const row = rows().find((r) => r.getAttribute("data-comment-id") === "c_rev")!;
    expect(row).toHaveAttribute("aria-current", "true");
    expect(scroll).toHaveBeenCalled();
    // The reviewer was in the frame, so focus follows to the row.
    expect(document.activeElement).toBe(row);
    // Display-only: no composer opened, no request made.
    expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    // Unknown ids and malformed reports are ignored.
    fromFrame(win, { dp: "pin-click", id: "c_nope" });
    fromFrame(win, { dp: "pin-click", id: 3 });
    expect(rows().find((r) => r.getAttribute("aria-current") === "true")?.getAttribute("data-comment-id")).toBe("c_rev");
    delete (Element.prototype as any).scrollIntoView;
  });

  it("ignores pin clicks and pin hovers once the page's scripts run", async () => {
    seed();
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "pin-click", id: "c_rev" });
    fromFrame(win, { dp: "pin-hover", id: "c_open", x: 10, y: 10 });
    expect(screen.getByTestId("page-queue-filter-open")).toHaveAttribute("aria-pressed", "true");
    expect(rows().some((r) => r.getAttribute("aria-current") === "true")).toBe(false);
    expect(screen.queryByTestId("page-pin-preview")).not.toBeInTheDocument();
  });

  it("a pin hover shows the comment's snippet as parent-rendered text; leaving clears it", () => {
    seed();
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "pin-hover", id: "c_seen", x: 40, y: 60 });
    const preview = screen.getByTestId("page-pin-preview");
    expect(preview).toHaveTextContent("#2");
    expect(preview).toHaveTextContent("Seen by agent");
    expect(preview).toHaveTextContent("1 reply");
    expect(preview).toHaveTextContent("comment on beta");
    fromFrame(win, { dp: "pin-hover", id: null });
    expect(screen.queryByTestId("page-pin-preview")).not.toBeInTheDocument();
    // Malformed coordinates are ignored.
    fromFrame(win, { dp: "pin-hover", id: "c_seen", x: "40", y: 60 });
    expect(screen.queryByTestId("page-pin-preview")).not.toBeInTheDocument();
  });

  it("ignores a pins-status report for a stale or unkeyed pin list (no positional misattribution)", () => {
    seed();
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "ready" });
    const lastPins = () => win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "pins").at(-1) as any;
    const oldKey = lastPins().key as string;
    const filters = () => screen.getByTestId("page-queue-filters");
    const count = (f: string) => within(filters()).queryByTestId(`page-queue-filter-${f}`)?.textContent ?? "";
    // c_open is deleted while the frame's report for the 5-pin list is in flight.
    act(() => {
      useArtifactStore.setState((st) => ({
        comments: { ...st.comments, [pageArtifact.id]: st.comments[pageArtifact.id]!.filter((c) => c.id !== "c_open") },
      }));
    });
    // That report (c_open missing at index 0) lands now: index 0 is c_seen in
    // the current list, which must NOT turn Orphaned.
    fromFrame(win, { dp: "pins-status", found: [false, true, true, true, true], key: oldKey });
    expect(count("open")).toBe("Open 2");
    expect(count("orphaned")).not.toContain("Orphaned 1");
    // A keyless report is unbound too.
    fromFrame(win, { dp: "pins-status", found: [false, true, true, true] });
    expect(count("open")).toBe("Open 2");
    expect(count("orphaned")).not.toContain("Orphaned 1");
    // The report for the current list is used.
    const newKey = lastPins().key as string;
    expect(newKey).not.toBe(oldKey);
    fromFrame(win, { dp: "pins-status", found: [true, true, true, false], key: newKey });
    expect(count("open")).toBe("Open 1");
    expect(count("orphaned")).toBe("Orphaned 1");
  });

  it("outline badges count only comments still open in the queue", () => {
    seed();
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    pinsStatus(win, [true, true, true, true, false]);
    fromFrame(win, {
      dp: "outline",
      headings: [{ level: 1, text: "Only section", locator: "h1" }],
      pins: [0, 0, 0, 0, -1],
      changes: [],
    });
    expect(within(screen.getByTestId("page-outline-rail")).getByTestId("page-outline-comments")).toHaveTextContent("2");
  });

  describe("composer placement", () => {
    /** A controllable layout: every box reports `size`; ResizeObserver
     *  callbacks fire on demand. */
    function stubLayout(width: number, height: number) {
      const size = { width, height };
      const callbacks: Array<() => void> = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          cb: () => void;
          constructor(cb: () => void) { this.cb = cb; callbacks.push(cb); }
          observe() {}
          disconnect() {}
          unobserve() {}
        },
      );
      const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, width: size.width, height: size.height, toJSON: () => ({}) }) as DOMRect,
      );
      return {
        spy,
        resize(w: number) {
          size.width = w;
          act(() => { for (const cb of callbacks) cb(); });
        },
      };
    }

    it("wide panel: the composer and the queue sit in the right-hand review rail", () => {
      const { spy } = stubLayout(1400, 800);
      try {
        seed();
        render(<PageArtifact artifact={pageArtifact} />);
        const win = fakeFrameWindow();
        fromFrame(win, { dp: "anchor", anchor: cellAnchor });
        const column = screen.getByTestId("page-review-column");
        expect(column).toHaveAttribute("data-placement", "rail");
        const composer = within(column).getByTestId("page-anchor-composer");
        expect(composer).toHaveAttribute("data-placement", "rail");
        expect(within(column).getByTestId("page-annotations")).toHaveAttribute("data-variant", "rail");
        expect(screen.getByTestId("page-review-grid").style.gridTemplateColumns).toBe("minmax(0,1fr) 18rem");
        expect(document.activeElement).toBe(within(composer).getByLabelText("Comment on the selected spot", { selector: "textarea" }));
        // Wide: the frame isn't asked to scroll for a spot the reviewer just clicked.
        expect(win.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ dp: "focus" }), "*");
      } finally {
        spy.mockRestore();
      }
    });

    it("narrow panel: the composer docks below the frame, never over it, and the frame scrolls the spot near its bottom", () => {
      const { spy } = stubLayout(600, 600);
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      try {
        render(<PageArtifact artifact={pageArtifact} />);
        const win = fakeFrameWindow();
        fromFrame(win, { dp: "anchor", anchor: cellAnchor });
        const composer = screen.getByTestId("page-anchor-composer");
        expect(composer).toHaveAttribute("data-placement", "below");
        // Not inside the frame's box, not absolutely positioned anywhere: a
        // normal block in the review row under the frame.
        expect(screen.getByTestId("page-frame-box").contains(composer)).toBe(false);
        expect(screen.getByTestId("page-review-column")).toContainElement(composer);
        expect(screen.getByTestId("page-review-column").className).toContain("col-span-full");
        for (let el: HTMLElement | null = composer; el; el = el.parentElement) {
          expect(el.className).not.toMatch(/\b(absolute|fixed)\b/);
          expect(el.style.position).not.toMatch(/absolute|fixed/);
        }
        expect(screen.queryByTestId("page-composer-floating")).not.toBeInTheDocument();
        // The frame is asked to put the spot near its bottom edge (next to the composer); the composer is
        // brought into view with the least scroll; focus is in the textarea
        // on the FIRST open.
        expect(win.postMessage).toHaveBeenCalledWith({ dp: "focus", anchor: cellAnchor, block: "end" }, "*");
        expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
        expect(document.activeElement).toBe(within(composer).getByLabelText("Comment on the selected spot", { selector: "textarea" }));
      } finally {
        spy.mockRestore();
        delete (Element.prototype as any).scrollIntoView;
      }
    });

    it("the composer is one stable mount: focus and text survive a narrow/wide switch", async () => {
      const layout = stubLayout(600, 600);
      try {
        render(<PageArtifact artifact={pageArtifact} />);
        const win = fakeFrameWindow();
        fromFrame(win, { dp: "anchor", anchor: cellAnchor });
        const textarea = screen.getByLabelText("Comment on the selected spot", { selector: "textarea" });
        expect(document.activeElement).toBe(textarea);
        await userEvent.type(textarea, "half typed");
        layout.resize(1400);
        expect(screen.getByTestId("page-review-column")).toHaveAttribute("data-placement", "rail");
        expect(screen.getByLabelText("Comment on the selected spot", { selector: "textarea" })).toBe(textarea);
        expect(document.activeElement).toBe(textarea);
        layout.resize(600);
        expect(screen.getByTestId("page-review-column")).toHaveAttribute("data-placement", "below");
        expect(document.activeElement).toBe(textarea);
        expect(textarea).toHaveValue("half typed");
      } finally {
        layout.spy.mockRestore();
      }
    });

    it("clamps the pin preview by its real max width so it stays inside the frame", () => {
      const { spy } = stubLayout(600, 600);
      try {
        seed();
        render(<PageArtifact artifact={pageArtifact} />);
        const win = fakeFrameWindow();
        fromFrame(win, { dp: "pin-hover", id: "c_open", x: 550, y: 40 });
        const preview = screen.getByTestId("page-pin-preview");
        expect(preview.style.left).toBe("280px");
        expect(preview.style.maxWidth).toBe("320px");
      } finally {
        spy.mockRestore();
      }
    });

    it("Escape inside Rule this out's confirm step cancels only that step, not the composer", async () => {
      render(<PageArtifact artifact={pageArtifact} />);
      const win = fakeFrameWindow();
      fromFrame(win, { dp: "anchor", anchor: cellAnchor });
      await userEvent.click(screen.getByRole("button", { name: "Rule this out" }));
      const panel = screen.getByTestId("page-rule-out-panel");
      within(panel).getByRole("button", { name: "Rule it out" }).focus();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("page-rule-out-panel")).not.toBeInTheDocument();
      expect(screen.getByTestId("page-anchor-composer")).toBeInTheDocument();
    });

    it("with no layout measured, the composer falls back to just under the frame", () => {
      render(<PageArtifact artifact={pageArtifact} />);
      const win = fakeFrameWindow();
      fromFrame(win, { dp: "anchor", anchor: cellAnchor });
      expect(screen.getByTestId("page-anchor-composer")).toHaveAttribute("data-placement", "below");
    });

    it("Escape closes the composer and hands focus back to the frame; Close does the same", async () => {
      render(<PageArtifact artifact={pageArtifact} />);
      const win = fakeFrameWindow();
      fromFrame(win, { dp: "anchor", anchor: cellAnchor });
      const textarea = screen.getByLabelText("Comment on the selected spot", { selector: "textarea" });
      expect(document.activeElement).toBe(textarea);
      await userEvent.type(textarea, "keep me");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(frame());
      // The text is kept as this spot's draft.
      fromFrame(win, { dp: "anchor", anchor: cellAnchor });
      expect(screen.getByLabelText("Comment on the selected spot", { selector: "textarea" })).toHaveValue("keep me");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByTestId("page-anchor-composer")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(frame());
    });
  });
});

describe("PageArtifact — render diagnostics (#714 gap 12)", () => {
  // Every report names the frame document it came from: the id the companion
  // minted for that srcdoc and injected into its annotator (the iframe's
  // data-dp-doc). `doc` reads the CURRENT frame's id at the time it is sent.
  const frameDoc = () => frame()?.getAttribute("data-dp-doc") ?? "none";
  const DIAG = {
    dp: "diagnostics",
    get doc() {
      return frameDoc();
    },
    scriptErrors: { count: 2, samples: ["<img src=x onerror=alert(1)>"], classes: [{ key: "TypeError", count: 2 }] },
    rejections: { count: 0, samples: [], classes: [] },
    resources: [{ key: "img src", count: 3 }],
    blocked: [{ key: "img-src", count: 3 }],
  };
  /** The frame's document announced itself: its ready carries its instance id. */
  const liveFrame = () => {
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "ready", doc: frameDoc() });
    return win;
  };
  const renderFailurePosts = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith("/api/render-failures"));

  it("accepts a report AFTER Run and renders a passive, text-only banner with details; a spoofed source is ignored", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const win = liveFrame();
    // Another window (the page's own child frame, a stray tab): ignored.
    fromFrame({ postMessage: vi.fn() }, DIAG);
    expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
    win.postMessage.mockClear();
    fromFrame(win, DIAG, { frameFocused: false });
    const banner = screen.getByTestId("page-render-issues");
    expect(banner).toHaveAttribute("role", "status");
    expect(screen.getByTestId("page-render-issues-headline")).toHaveTextContent("This page has 2 script errors and 3 images that didn't load.");
    const details = screen.getByTestId("page-render-issues-details");
    expect(details).toHaveTextContent("Script errors (2): <img src=x onerror=alert(1)>");
    expect(details).toHaveTextContent("Didn't load: img src ×3");
    // Frame text is never markup, and the report triggers nothing: no
    // composer, no message back to the frame.
    expect(banner.querySelector("img")).toBeNull();
    expect(screen.queryByTestId("page-anchor-context")).not.toBeInTheDocument();
    expect(win.postMessage).not.toHaveBeenCalled();
    // Its only controls: the details disclosure and dismiss.
    expect(within(banner).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Dismiss render issues"]);
    await userEvent.click(within(banner).getByRole("button", { name: "Dismiss render issues" }));
    expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
    // A different report shows it again.
    fromFrame(win, { ...DIAG, scriptErrors: { count: 3, samples: ["late"], classes: [{ key: "TypeError", count: 3 }] } });
    expect(screen.getByTestId("page-render-issues-headline")).toHaveTextContent("3 script errors");
  });

  it("shows a forged resource key only as 'other resource' (never its text)", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = liveFrame();
    fromFrame(win, { ...DIAG, resources: [{ key: "img https://x.test/a.png", count: 1 }] });
    const details = screen.getByTestId("page-render-issues-details");
    expect(details).toHaveTextContent("Didn't load: other resource ×1");
    expect(details.textContent).not.toContain("x.test");
  });

  it("reports a settled summary to the agent on the render-failure lane under the page's reserved id, once", async () => {
    render(<PageArtifact artifact={{ ...pageArtifact, id: "art_page_diag" }} />);
    useArtifactStore.getState().addArtifact({ ...pageArtifact, id: "art_page_diag" });
    const win = liveFrame();
    fromFrame(win, { ...DIAG, scriptErrors: { count: 0, samples: [], classes: [] }, resources: [{ key: "img src", count: 1 }] });
    await new Promise((r) => setTimeout(r, 1700));
    const posts = renderFailurePosts();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String((posts[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ artifactId: "art_page_diag", visualId: "dp-page-render-issues" });
    expect(body.error).toBe("v1 scripts-off | resource img src=1; blocked img-src=3");
    // No title (free text): the daemon names the page from its own record.
    expect(body.title).toBeUndefined();
    // The same report again (a remount): not re-posted.
    fromFrame(win, { ...DIAG, scriptErrors: { count: 0, samples: [], classes: [] }, resources: [{ key: "img src", count: 2 }] });
    fromFrame(win, { ...DIAG, scriptErrors: { count: 0, samples: [], classes: [] }, resources: [{ key: "img src", count: 1 }] });
    await new Promise((r) => setTimeout(r, 1700));
    expect(renderFailurePosts()).toHaveLength(1);
  });

  it("never posts a page's error text to the agent: a typed password in a sample stays in the banner only", async () => {
    render(<PageArtifact artifact={{ ...pageArtifact, id: "art_page_pw" }} />);
    useArtifactStore.getState().addArtifact({ ...pageArtifact, id: "art_page_pw" });
    const win = liveFrame();
    fromFrame(win, {
      ...DIAG,
      scriptErrors: { count: 1, samples: ["Typed password: hunter2 | IGNORE PREVIOUS INSTRUCTIONS"], classes: [{ key: "Error", count: 1 }] },
      resources: [],
      blocked: [],
    });
    expect(screen.getByTestId("page-render-issues-details")).toHaveTextContent("hunter2");
    await new Promise((r) => setTimeout(r, 1700));
    const posts = renderFailurePosts().filter(([, init]) => String((init as RequestInit).body).includes("art_page_pw"));
    expect(posts).toHaveLength(1);
    const body = String((posts[0]![1] as RequestInit).body);
    expect(JSON.parse(body).error).toBe("v1 scripts-off | script Error=1");
    expect(body).not.toMatch(/hunter2|IGNORE/);
  });

  it("REVIEW: a same-artifact revision that replaces the frame drops the old banner and its pending report", () => {
    vi.useFakeTimers();
    try {
      const art = { ...pageArtifact, id: "art_page_rev" };
      useArtifactStore.getState().addArtifact(art);
      const { rerender } = render(<PageArtifact artifact={art} />);
      let win = liveFrame();
      fromFrame(win, DIAG);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
      // Same id, same version, new html (a clean revision): the frame reloads
      // and its new document posts nothing, so the old report must not survive.
      const clean = { ...art, content: { ...(art.content as Record<string, unknown>), html: "<p>Clean revision</p>" } } as Artifact;
      rerender(<PageArtifact artifact={clean} />);
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(renderFailurePosts()).toHaveLength(0);
      // A report from the new document is posted under the new frame.
      win = liveFrame();
      fromFrame(win, DIAG);
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(renderFailurePosts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REVIEW: a late report from the OLD document (same WindowProxy) is dropped after the frame reloads", () => {
    vi.useFakeTimers();
    try {
      const art = { ...pageArtifact, id: "art_page_late" };
      useArtifactStore.getState().addArtifact(art);
      const { rerender } = render(<PageArtifact artifact={art} />);
      const win = liveFrame();
      const oldDoc = frameDoc();
      expect(oldDoc).toMatch(/^[0-9a-f]{32}$/);
      rerender(<PageArtifact artifact={{ ...art, content: { ...(art.content as Record<string, unknown>), html: "<p>v2</p>" } } as Artifact} />);
      // The companion minted a new id for the new srcdoc.
      expect(frameDoc()).toMatch(/^[0-9a-f]{32}$/);
      expect(frameDoc()).not.toBe(oldDoc);
      // The old document's queued report lands after the reload...
      fromFrame(win, { ...DIAG, doc: oldDoc });
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      // ...and so does its queued READY followed by another report: an old
      // ready can never claim the current document.
      fromFrame(win, { dp: "ready", doc: oldDoc });
      fromFrame(win, { ...DIAG, doc: oldDoc });
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      // A ready naming some other id can't either.
      fromFrame(win, { dp: "ready", doc: "fedcba9876543210fedcba9876543210" });
      fromFrame(win, { ...DIAG, doc: "fedcba9876543210fedcba9876543210" });
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(renderFailurePosts()).toHaveLength(0);
      // A report without a document id is not accepted either.
      const { doc: _doc, ...anonymous } = DIAG;
      fromFrame(win, anonymous);
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      // The new document's own report is accepted.
      fromFrame(win, DIAG);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("REVIEW: a version-only revision (unchanged html, live document) keeps that document's report and posts it under the new version", () => {
    vi.useFakeTimers();
    try {
      const art = { ...pageArtifact, id: "art_page_vonly" };
      useArtifactStore.getState().addArtifact(art);
      const { rerender } = render(<PageArtifact artifact={art} />);
      const win = liveFrame();
      fromFrame(win, DIAG);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
      // The frame does not reload, so its document never re-reports.
      rerender(<PageArtifact artifact={{ ...art, version: 2 }} />);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      const posts = renderFailurePosts();
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body)).error).toMatch(/^v2 /);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("REVIEW: a document the frame swaps in on its own (Mermaid prepare, theme flip)", () => {
    const MERMAID_HTML = '<h1>Flow</h1><pre class="mermaid">flowchart LR\n  A[A]</pre>';
    const mermaidArt = (id: string) =>
      ({ ...pageArtifact, id, content: { ...(pageArtifact.content as Record<string, unknown>), html: MERMAID_HTML } }) as Artifact;
    afterEach(() => {
      // Unmount first: a theme reset with the page still mounted would start a
      // real Mermaid render once the spy is restored.
      cleanup();
      act(() => usePreferencesStore.getState().setTheme("light"));
      vi.mocked(PAGE_MERMAID_PREPARE.run).mockRestore?.();
    });

    it("(a) the first frame lands after the async prepare: a one-off error is accepted, shown and reported", async () => {
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      vi.spyOn(PAGE_MERMAID_PREPARE, "run").mockImplementation(async (h: string) => { await gate; return h; });
      const art = mermaidArt("art_page_prep");
      useArtifactStore.getState().addArtifact(art);
      render(<PageArtifact artifact={art} />);
      // The prepare is in flight: no frame document yet.
      expect(frame()).toBeNull();
      await act(async () => { open(); await gate; });
      expect(frame()?.getAttribute("data-dp-doc")).toMatch(/^[0-9a-f]{32}$/);
      const win = liveFrame();
      fromFrame(win, DIAG);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 1700));
      expect(renderFailurePosts().filter(([, init]) => String((init as RequestInit).body).includes("art_page_prep"))).toHaveLength(1);
    });

    it("(b) a pre-Run theme flip swaps the document: the old banner goes, the new document's report is accepted", async () => {
      act(() => usePreferencesStore.getState().setTheme("light"));
      vi.spyOn(PAGE_MERMAID_PREPARE, "run").mockImplementation(async (h: string, theme: string) => `${h}<!-- ${theme} -->`);
      const art = mermaidArt("art_page_theme");
      useArtifactStore.getState().addArtifact(art);
      render(<PageArtifact artifact={art} />);
      await act(async () => {});
      const firstDoc = frame()!.getAttribute("data-dp-doc");
      expect(firstDoc).toMatch(/^[0-9a-f]{32}$/);
      const win = liveFrame();
      fromFrame(win, DIAG);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
      await act(async () => { usePreferencesStore.getState().setTheme("dark"); });
      await act(async () => {});
      expect(frame()!.getAttribute("data-dp-doc")).not.toBe(firstDoc);
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      // The old document's late report stays out; the new one's is accepted.
      fromFrame(win, { ...DIAG, doc: firstDoc });
      expect(screen.queryByTestId("page-render-issues")).not.toBeInTheDocument();
      fromFrame(win, { dp: "ready", doc: frame()!.getAttribute("data-dp-doc") });
      fromFrame(win, DIAG);
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
    });
  });

  it("REVIEW: count-only snapshots recurring faster than the settle delay still report within the max wait, with the latest count", () => {
    vi.useFakeTimers();
    try {
      const art = { ...pageArtifact, id: "art_page_recur" };
      useArtifactStore.getState().addArtifact(art);
      render(<PageArtifact artifact={art} />);
      const win = liveFrame();
      const snap = (n: number) =>
        fromFrame(win, { ...DIAG, scriptErrors: { count: n, samples: [], classes: [{ key: "TypeError", count: n }] }, resources: [], blocked: [] });
      // A new snapshot every second, forever: a plain trailing debounce never fires.
      for (let n = 1; n <= 5; n++) {
        snap(n);
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }
      const posts = renderFailurePosts();
      expect(posts).toHaveLength(1);
      // Sent at 5s from the first observation, carrying the latest coalesced count.
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body)).error).toBe("v1 scripts-off | script TypeError=5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("offline: the automatic report is held while the tab is disconnected and sent once it reconnects", () => {
    vi.useFakeTimers();
    try {
      const art = { ...pageArtifact, id: "art_page_offline" };
      useArtifactStore.getState().addArtifact(art);
      act(() => {
        useConnectionStore.setState({ connected: false } as any);
        useConnectionGraceStore.setState({ graceOver: true } as any);
      });
      render(<PageArtifact artifact={art} />);
      const win = liveFrame();
      fromFrame(win, DIAG);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(renderFailurePosts()).toHaveLength(0);
      // The banner still shows offline: only the agent-facing post waits.
      expect(screen.getByTestId("page-render-issues")).toBeInTheDocument();
      act(() => {
        useConnectionStore.setState({ connected: true } as any);
      });
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(renderFailurePosts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      // Leave the connection stores as every other test expects them.
      useConnectionStore.setState({ connected: false } as any);
      useConnectionGraceStore.setState({ everConnected: false, graceOver: false } as any);
    }
  });
});

// --- #714 gaps 9+13 and resolve from the queue ------------------------------

describe("PageArtifact — keyboard, touch, polish and resolve (#714 gaps 9+13)", () => {
  const select = () => useArtifactStore.setState({ selectedArtifactId: pageArtifact.id });
  const human = (id: string, extra: Partial<Comment> = {}): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id, htmlAnchor: { kind: "element", locator: "h1", quote: "Cache invalidation" } as any },
    parentCommentId: null,
    author: "human",
    content: `note ${id}`,
    acknowledged: false,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "")) || 0)).toISOString(),
    ...extra,
  });
  const lastMode = (win: { postMessage: ReturnType<typeof vi.fn> }) =>
    win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "mode").at(-1);
  const live = () => screen.getByTestId("page-live-region").textContent ?? "";

  it("the Comment mode toggle sends kbd:true (pointing on) and announces how to use it", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    const toggle = screen.getByTestId("page-kbd-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(lastMode(win)).toMatchObject({ annotate: true, kbd: true });
    expect(live()).toMatch(/Comment mode on/);
    // Pointing off also ends comment mode.
    await userEvent.click(screen.getByRole("button", { name: /pointing: on/i }));
    expect(lastMode(win)).toMatchObject({ annotate: false, kbd: false });
  });

  it("C in the companion toggles comment mode while the page is selected, never while typing", () => {
    select();
    render(<PageArtifact artifact={pageArtifact} />);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })); });
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "true");
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true })); });
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "true");
    input.remove();
  });

  it("announces the frame's keyboard cursor before Run; ignores a malformed or post-Run report", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    let win = fakeFrameWindow();
    fromFrame(win, { dp: "kbd-cursor", index: 2, total: 9, kind: "cell", text: "Up to 60s", pins: [0] });
    expect(live()).toBe("Cell, 3 of 9: Up to 60s. Has comment 1.");
    fromFrame(win, { dp: "kbd-cursor", index: 9, total: 9, kind: "cell", text: "x", pins: [] });
    fromFrame(win, { dp: "kbd-cursor", index: 0, total: 9, kind: "<b>", text: "x", pins: [] });
    fromFrame(win, { dp: "kbd-cursor", index: 0, total: 9, kind: "cell", text: "x", pins: [], extra: 1 });
    expect(live()).toBe("Cell, 3 of 9: Up to 60s. Has comment 1.");
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    win = fakeFrameWindow();
    fromFrame(win, { dp: "kbd-cursor", index: 0, total: 1, kind: "link", text: "forged", pins: [] });
    expect(live()).not.toMatch(/forged/);
  });

  it("kbd-off from the frame turns the mode off once; after Run a forged toggle is ignored", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    let win = fakeFrameWindow();
    await userEvent.click(screen.getByTestId("page-kbd-toggle"));
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "true");
    fromFrame(win, { dp: "kbd-off" });
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(live()).toBe("Comment mode off.");
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    win = fakeFrameWindow();
    fromFrame(win, { dp: "key", key: "toggle-kbd" });
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("frame keys before Run: toggle-kbd and help act only while the frame owns focus and only from this frame", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame({ postMessage() {} }, { dp: "key", key: "help" });
    expect(screen.queryByTestId("page-shortcuts-popover")).not.toBeInTheDocument();
    fromFrame(win, { dp: "key", key: "help" }, { frameFocused: false });
    expect(screen.queryByTestId("page-shortcuts-popover")).not.toBeInTheDocument();
    fromFrame(win, { dp: "key", key: "help" });
    expect(screen.getByTestId("page-shortcuts-popover")).toBeInTheDocument();
    fromFrame(win, { dp: "key", key: "toggle-kbd" });
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("the Shortcuts popover lists the page keys and closes on Escape, returning focus", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const toggle = screen.getByTestId("page-shortcuts-toggle");
    await userEvent.click(toggle);
    const pop = screen.getByRole("dialog", { name: /page review keyboard shortcuts/i });
    expect(within(pop).getByText(/comment on the block/i)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("page-shortcuts-popover")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it("Expand fills the window without remounting the frame; Escape collapses", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const before = frame();
    await userEvent.click(screen.getByTestId("page-expand-toggle"));
    const area = screen.getByTestId("page-review-area");
    expect(area).toHaveAttribute("data-expanded", "true");
    expect(area.className).toMatch(/fixed inset-0/);
    expect(frame()).toBe(before);
    await userEvent.keyboard("{Escape}");
    expect(area).toHaveAttribute("data-expanded", "false");
    expect(frame()).toBe(before);
  });

  it("a page keeps its authored light canvas in dark mode unless it opts into dark", () => {
    const { unmount } = render(<PageArtifact artifact={pageArtifact} />);
    expect(frame()!.className).toMatch(/bg-white/);
    expect(frame()!.className).toMatch(/\[color-scheme:light\]/);
    unmount();
    const darkPage: Artifact = {
      ...pageArtifact,
      id: "art_page_dark",
      content: { title: "Dark", html: "<meta name=\"color-scheme\" content=\"light dark\"><p>Hi</p>" },
    };
    const prev = usePreferencesStore.getState().theme;
    usePreferencesStore.setState({ theme: "dark" });
    try {
      const r = render(<PageArtifact artifact={darkPage} />);
      expect(frame()!.className).toMatch(/\[color-scheme:dark\]/);
      expect(screen.getByTestId("page-theme-note")).toHaveTextContent(/supports dark mode/);
      r.unmount();
      // The same page in the light theme renders light.
      usePreferencesStore.setState({ theme: "light" });
      render(<PageArtifact artifact={darkPage} />);
      expect(frame()!.className).toMatch(/\[color-scheme:light\]/);
      expect(screen.queryByTestId("page-theme-note")).not.toBeInTheDocument();
    } finally {
      usePreferencesStore.setState({ theme: prev });
    }
  });

  it("] and [ step through the visible comments: highlight, focus the row, scroll the pin, announce", () => {
    select();
    useArtifactStore.getState().addComment(human("cmt_1"));
    useArtifactStore.getState().addComment(human("cmt_2"));
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })); });
    const rows = screen.getAllByTestId("page-annotation");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(win.postMessage).toHaveBeenCalledWith(expect.objectContaining({ dp: "focus", index: 0 }), "*");
    expect(live()).toMatch(/^Comment 1, 1 of 2: Open\./);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })); });
    expect(screen.getAllByTestId("page-annotation")[1]).toHaveAttribute("aria-current", "true");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true })); });
    expect(screen.getAllByTestId("page-annotation")[0]).toHaveAttribute("aria-current", "true");
  });

  it("Resolve on a plain comment posts mark-resolved and the row reads Resolved by you; Reopen posts mark-unresolved", async () => {
    useArtifactStore.getState().addComment(human("cmt_1"));
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByTestId("page-annotation-resolve"));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/comments/cmt_1/mark-resolved"))).toBe(true);
    // The row moved to Addressed (filter "Open" was automatic; nothing is open now → All).
    expect(screen.getByText("Resolved by you")).toBeInTheDocument();
    const reopen = screen.getByTestId("page-annotation-reopen");
    expect(reopen).toHaveTextContent("Reopen");
    await userEvent.click(reopen);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/comments/cmt_1/mark-unresolved"))).toBe(true);
    expect(screen.getAllByTestId("page-annotation-state")[0]).toHaveTextContent("Open");
    expect(live()).toMatch(/Comment 1 reopened/);
  });

  it("no Resolve on an Ask, and none on a read-only page", () => {
    useArtifactStore.getState().addComment(human("cmt_1", { intent: "question" }));
    const { unmount } = render(<PageArtifact artifact={pageArtifact} />);
    expect(screen.queryByTestId("page-annotation-resolve")).not.toBeInTheDocument();
    unmount();
    useArtifactStore.getState().addComment(human("cmt_2"));
    const closed: Artifact = { ...pageArtifact, status: "approved" as Artifact["status"] };
    render(<PageArtifact artifact={{ ...closed, status: "retracted" as Artifact["status"] }} />);
    expect(screen.queryByTestId("page-annotation-resolve")).not.toBeInTheDocument();
  });

  it("announces a comment you just posted", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    act(() => { useArtifactStore.getState().addComment(human("cmt_5")); });
    expect(live()).toBe("Comment 1 posted.");
  });
});

describe("PageArtifact — #725 review fixes", () => {
  const human = (id: string, anchor: Record<string, unknown>, extra: Partial<Comment> = {}): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id, htmlAnchor: anchor as any },
    parentCommentId: null,
    author: "human",
    content: `note ${id}`,
    acknowledged: false,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "")) || 0)).toISOString(),
    ...extra,
  });
  const live = () => screen.getByTestId("page-live-region").textContent ?? "";

  it("P1 — no Resolve or Reopen on a comment that answers a data-dp-question ask", () => {
    const askPage: Artifact = {
      ...pageArtifact,
      id: "art_page_ask",
      content: { title: "Ask", html: '<div id="q1" data-dp-question>Which DB?</div><p id="other">Other text</p>' },
    };
    useArtifactStore.getState().addArtifact(askPage);
    const on = (id: string, locator: string, quote: string) => ({ ...human(id, { kind: "element", locator, quote }), target: { artifactId: askPage.id, htmlAnchor: { kind: "element", locator, quote } as any } });
    useArtifactStore.getState().addComment(on("cmt_1", "#q1", "Which DB?"));
    useArtifactStore.getState().addComment(on("cmt_2", "#other", "Other text"));
    render(<PageArtifact artifact={askPage} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "asks", asks: [{ kind: "question", id: "q1", text: "Which DB?", locator: "#q1" }], pinAsks: [] });
    const rows = screen.getAllByTestId("page-annotation");
    const rowOf = (id: string) => rows.find((r) => r.getAttribute("data-comment-id") === id)!.closest("li")!;
    expect(within(rowOf("cmt_1")).queryByTestId("page-annotation-resolve")).toBeNull();
    expect(within(rowOf("cmt_1")).queryByTestId("page-annotation-reopen")).toBeNull();
    expect(within(rowOf("cmt_2")).getByTestId("page-annotation-resolve")).toBeInTheDocument();
  });

  it("P2 — after Reopen a comment the agent had seen reads Open, not Seen by agent", async () => {
    useArtifactStore.getState().addComment(human("cmt_1", { kind: "element", locator: "h1", quote: "Cache invalidation" }, {
      acknowledged: true, humanResolvedAt: "2026-01-02T00:00:00.000Z",
    }));
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByTestId("page-annotation-reopen"));
    expect(screen.getAllByTestId("page-annotation-state")[0]).toHaveTextContent(/^Open$/);
  });

  it("P2 — kbd-off while the mode is already off changes nothing and announces nothing", () => {
    render(<PageArtifact artifact={pageArtifact} />);
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "kbd-off" });
    fromFrame(win, { dp: "kbd-off" });
    expect(live()).toBe("");
  });

  it("P3 — comment mode is off and its toggle disabled once the page's scripts run", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByTestId("page-kbd-toggle"));
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const toggle = screen.getByTestId("page-kbd-toggle");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    const win = fakeFrameWindow();
    fromFrame(win, { dp: "ready" });
    const mode = win.postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.dp === "mode").at(-1);
    expect(mode).toMatchObject({ kbd: false, scripts: true });
  });

  it("P3 — C toggles comment mode with Caps Lock on", () => {
    useArtifactStore.setState({ selectedArtifactId: pageArtifact.id });
    render(<PageArtifact artifact={pageArtifact} />);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "C", bubbles: true })); });
    expect(screen.getByTestId("page-kbd-toggle")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("PageArtifact — offline gating of Resolve / Reopen (#725)", () => {
  const human = (id: string, extra: Partial<Comment> = {}): Comment => ({
    id,
    sessionId: "sess_1",
    target: { artifactId: pageArtifact.id, htmlAnchor: { kind: "element", locator: "h1", quote: "Cache invalidation" } as any },
    parentCommentId: null,
    author: "human",
    content: `note ${id}`,
    acknowledged: false,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "")) || 0)).toISOString(),
    ...extra,
  });

  it("offline → Resolve and Reopen are disabled with the offline reason, and nothing is posted", async () => {
    useArtifactStore.getState().addComment(human("cmt_1"));
    useArtifactStore.getState().addComment(human("cmt_2", { humanResolvedAt: "2026-01-02T00:00:00.000Z" }));
    act(() => {
      useConnectionStore.setState({ connected: false } as any);
      useConnectionGraceStore.setState({ everConnected: true, graceOver: true } as any);
    });
    try {
      render(<PageArtifact artifact={pageArtifact} />);
      await userEvent.click(screen.getByTestId("page-queue-filter-all"));
      const resolve = screen.getByTestId("page-annotation-resolve");
      const reopen = screen.getByTestId("page-annotation-reopen");
      for (const b of [resolve, reopen]) {
        expect(b).toBeDisabled();
        expect(b).toHaveAttribute("title", OFFLINE_ACT_REASON);
      }
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      expect(fetchMock.mock.calls.some((c) => /mark-(un)?resolved/.test(String(c[0])))).toBe(false);
    } finally {
      useConnectionStore.setState({ connected: false } as any);
      useConnectionGraceStore.setState({ everConnected: false, graceOver: false } as any);
    }
  });
});
