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
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact, Comment } from "@deeppairing/shared";
import { PAGE_RULE_OUT_MESSAGES } from "@deeppairing/shared";
import { pageArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { PageArtifact } from "../artifacts/PageArtifact";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { useLedgerStore } from "../../stores/ledger";
import { useConnectionGraceStore } from "../../lib/connectionGrace";

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
      { dp: "pins", anchors: [{ kind: "text", locator: "p", quote: "a sentence from v1" }] },
      "*",
    );
    fromFrame(win, { dp: "pins-status", found: [false] });
    expect(screen.getByTestId("page-anchor-missing")).toHaveTextContent(/not found in this version/i);
    expect(within(screen.getByTestId("page-annotations")).getByText(/a sentence from v1/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("page-annotation"));
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "focus", index: 0 }, "*");
    // An explicit open from the companion still focuses the composer.
    expect(document.activeElement).toBe(screen.getByLabelText("Comment on the selected spot"));
  });

  it("drops anchors while pointing is off (after Run), and accepts them again when it is back on", async () => {
    render(<PageArtifact artifact={pageArtifact} />);
    await userEvent.click(screen.getByRole("button", { name: /run page scripts/i }));
    const win = fakeFrameWindow();
    await userEvent.click(screen.getByRole("button", { name: /pointing: on/i }));
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false, scripts: true }, "*");
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
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false, scripts: false }, "*");
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
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false, scripts: false }, "*");
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
    fromFrame(win, { dp: "pins-status", found: [true] });
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
