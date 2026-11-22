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
import type { Artifact } from "@deeppairing/shared";
import { pageArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { PageArtifact } from "../artifacts/PageArtifact";
import { useArtifactStore } from "../../stores/artifact";

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
    expect(win.postMessage).toHaveBeenCalledWith({ dp: "mode", annotate: false }, "*");
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
