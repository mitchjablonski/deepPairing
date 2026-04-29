import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { commentAnchorKey, scrollToAnchor, dispatchScrollToAnchor, ANCHOR_SCROLL_EVENT } from "../comment-anchor";

describe("commentAnchorKey", () => {
  it("returns null when target is missing", () => {
    expect(commentAnchorKey(undefined)).toBeNull();
    expect(commentAnchorKey({})).toBeNull();
  });

  it("encodes line anchors with filePath and line number", () => {
    expect(commentAnchorKey({ filePath: "src/auth.ts", lineStart: 23 })).toBe("line:src/auth.ts:23");
  });

  it("encodes line anchors with empty filePath when none is supplied", () => {
    expect(commentAnchorKey({ lineStart: 7 })).toBe("line::7");
  });

  it("encodes finding anchors", () => {
    expect(commentAnchorKey({ findingIndex: 2 })).toBe("finding:2");
  });

  it("encodes finding+evidence anchors when both are present", () => {
    expect(commentAnchorKey({ findingIndex: 2, evidenceIndex: 1 })).toBe("finding:2:1");
  });

  it("encodes step anchors", () => {
    expect(commentAnchorKey({ stepIndex: 0 })).toBe("step:0");
  });

  it("prefers line over finding/step when multiple are set (line is the most specific)", () => {
    expect(
      commentAnchorKey({
        lineStart: 5,
        findingIndex: 1,
        stepIndex: 0,
        filePath: "x.ts",
      }),
    ).toBe("line:x.ts:5");
  });
});

describe("scrollToAnchor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns false when no element matches the artifact + anchor pair", () => {
    expect(scrollToAnchor("art_missing", "line::1")).toBe(false);
  });

  it("scrolls into view + flashes the highlight class on the matched element", () => {
    document.body.innerHTML = `
      <div data-artifact-id="art_1">
        <div data-comment-anchor="line:auth.ts:42" id="row">row</div>
      </div>
    `;
    const el = document.getElementById("row")!;
    const scrollSpy = vi.fn();
    el.scrollIntoView = scrollSpy;
    expect(scrollToAnchor("art_1", "line:auth.ts:42")).toBe(true);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(el.classList.contains("dp-anchor-highlight")).toBe(true);
  });

  it("scopes by artifactId so an anchor in another artifact doesn't get hit", () => {
    document.body.innerHTML = `
      <div data-artifact-id="art_other">
        <div data-comment-anchor="line:foo.ts:1" id="wrong">wrong</div>
      </div>
      <div data-artifact-id="art_target">
        <div data-comment-anchor="line:foo.ts:1" id="right">right</div>
      </div>
    `;
    const wrong = document.getElementById("wrong")!;
    const right = document.getElementById("right")!;
    wrong.scrollIntoView = vi.fn();
    right.scrollIntoView = vi.fn();
    expect(scrollToAnchor("art_target", "line:foo.ts:1")).toBe(true);
    expect(right.scrollIntoView).toHaveBeenCalled();
    expect(wrong.scrollIntoView).not.toHaveBeenCalled();
  });

  it("removes the highlight class after the timeout", () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = `
        <div data-artifact-id="a">
          <div data-comment-anchor="step:0" id="r">r</div>
        </div>
      `;
      const el = document.getElementById("r")!;
      el.scrollIntoView = vi.fn();
      scrollToAnchor("a", "step:0");
      expect(el.classList.contains("dp-anchor-highlight")).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(el.classList.contains("dp-anchor-highlight")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dispatchScrollToAnchor", () => {
  let received: any[] = [];
  let listener: (e: Event) => void;

  beforeEach(() => {
    received = [];
    listener = (e: Event) => received.push((e as CustomEvent).detail);
    window.addEventListener(ANCHOR_SCROLL_EVENT, listener);
  });

  afterEach(() => {
    window.removeEventListener(ANCHOR_SCROLL_EVENT, listener);
  });

  it("emits a CustomEvent carrying the artifactId and anchorKey", () => {
    dispatchScrollToAnchor("art_1", "step:3");
    expect(received).toEqual([{ artifactId: "art_1", anchorKey: "step:3" }]);
  });
});
