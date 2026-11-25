/**
 * #680 slice 2 — the parent's filter for messages from the page frame: only
 * from THIS frame's contentWindow, only the expected `dp` type, and only an
 * anchor that parses against the shared schema (every field capped).
 */
import { describe, it, expect } from "vitest";
import {
  acceptAnchorMessage,
  acceptAsksMessage,
  acceptChangesStatus,
  acceptOutlineActive,
  acceptOutlineMessage,
  acceptPinsStatus,
  askAnchor,
  buildChangesMessage,
  isReadyMessage,
  isTogglePointingMessage,
} from "../pageAnchorMessages";

const frame = { name: "page-frame" } as unknown as Window;
const otherFrame = { name: "other-frame" } as unknown as Window;
const anchor = { kind: "cell", locator: "td:nth-of-type(2)", quote: "Up to 60s", table: { row: "TTL expiry", col: "Staleness" } };

describe("acceptAnchorMessage", () => {
  it("accepts a valid anchor from this frame", () => {
    expect(acceptAnchorMessage({ source: frame, data: { dp: "anchor", anchor } }, frame)).toEqual(anchor);
  });

  it("rejects the same message from another source (another frame, the page itself, null)", () => {
    expect(acceptAnchorMessage({ source: otherFrame, data: { dp: "anchor", anchor } }, frame)).toBeNull();
    expect(acceptAnchorMessage({ source: null, data: { dp: "anchor", anchor } }, frame)).toBeNull();
  });

  it("rejects everything when the frame is not mounted", () => {
    expect(acceptAnchorMessage({ source: frame, data: { dp: "anchor", anchor } }, null)).toBeNull();
    expect(acceptAnchorMessage({ source: null, data: { dp: "anchor", anchor } }, undefined)).toBeNull();
  });

  it.each([
    ["a non-object payload", "anchor"],
    ["the wrong dp type", { dp: "pins", anchor }],
    ["no dp field", { anchor }],
    ["a missing anchor", { dp: "anchor" }],
    ["an unknown kind", { dp: "anchor", anchor: { ...anchor, kind: "region" } }],
    ["a non-string quote", { dp: "anchor", anchor: { ...anchor, quote: 42 } }],
    ["an array", [{ dp: "anchor", anchor }]],
  ])("rejects a malformed message: %s", (_label, data) => {
    expect(acceptAnchorMessage({ source: frame, data }, frame)).toBeNull();
  });

  it.each([
    ["locator", { locator: "x".repeat(513) }],
    ["quote", { quote: "x".repeat(281) }],
    ["prefix", { prefix: "x".repeat(33) }],
    ["suffix", { suffix: "x".repeat(33) }],
    ["table header", { table: { col: "x".repeat(201) } }],
  ])("rejects an over-length %s", (_label, patch) => {
    expect(acceptAnchorMessage({ source: frame, data: { dp: "anchor", anchor: { ...anchor, ...patch } } }, frame)).toBeNull();
  });

  it("drops keys the schema doesn't know (never echoes HTML from the frame)", () => {
    const got = acceptAnchorMessage({ source: frame, data: { dp: "anchor", anchor: { ...anchor, html: "<img src=x onerror=alert(1)>" } } }, frame);
    expect(got).not.toBeNull();
    expect(got && "html" in got).toBe(false);
  });
});

describe("acceptPinsStatus / isReadyMessage", () => {
  it("accepts a boolean[] status from this frame only", () => {
    expect(acceptPinsStatus({ source: frame, data: { dp: "pins-status", found: [true, false] } }, frame)).toEqual([true, false]);
    expect(acceptPinsStatus({ source: otherFrame, data: { dp: "pins-status", found: [true] } }, frame)).toBeNull();
    expect(acceptPinsStatus({ source: frame, data: { dp: "pins-status", found: ["yes"] } }, frame)).toBeNull();
    expect(acceptPinsStatus({ source: frame, data: { dp: "pins-status", found: new Array(501).fill(true) } }, frame)).toBeNull();
  });

  it("recognizes ready only from this frame", () => {
    expect(isReadyMessage({ source: frame, data: { dp: "ready" } }, frame)).toBe(true);
    expect(isReadyMessage({ source: otherFrame, data: { dp: "ready" } }, frame)).toBe(false);
  });
});

describe("isTogglePointingMessage (#714)", () => {
  it("accepts the shortcut only from this frame, and only as its own dp type", () => {
    expect(isTogglePointingMessage({ source: frame, data: { dp: "toggle-pointing" } }, frame)).toBe(true);
    expect(isTogglePointingMessage({ source: otherFrame, data: { dp: "toggle-pointing" } }, frame)).toBe(false);
    expect(isTogglePointingMessage({ source: null, data: { dp: "toggle-pointing" } }, frame)).toBe(false);
    expect(isTogglePointingMessage({ source: frame, data: { dp: "toggle-pointing" } }, null)).toBe(false);
    expect(isTogglePointingMessage({ source: frame, data: { dp: "ready" } }, frame)).toBe(false);
    expect(isTogglePointingMessage({ source: frame, data: "toggle-pointing" }, frame)).toBe(false);
  });
});

describe("version change marks (#714 gap 2)", () => {
  it("buildChangesMessage validates every mark and drops malformed ones", () => {
    const good = { kind: "changed", tag: "p", text: "New tail", occurrence: 0 };
    const msg = buildChangesMessage(
      [good, { kind: "changed", tag: "p><script", text: "x", occurrence: 0 }, { ...good, text: "x".repeat(281) }, { ...good, occurrence: 1.5 }, { ...good, extra: "<b>" }],
      true,
    );
    expect(msg).toEqual({ dp: "changes", marks: [good], show: true });
    expect(buildChangesMessage(Array.from({ length: 400 }, () => good), false).marks).toHaveLength(300);
    expect(buildChangesMessage([{ ...good, kind: "moved" }, { ...good, kind: "hinted" }], true).marks.map((m) => m.kind)).toEqual(["moved", "hinted"]);
  });

  it("acceptChangesStatus takes a boolean list only from this frame", () => {
    expect(acceptChangesStatus({ source: frame, data: { dp: "changes-status", found: [true, false] } }, frame)).toEqual([true, false]);
    expect(acceptChangesStatus({ source: otherFrame, data: { dp: "changes-status", found: [true] } }, frame)).toBeNull();
    expect(acceptChangesStatus({ source: frame, data: { dp: "changes-status", found: ["yes"] } }, frame)).toBeNull();
    expect(acceptChangesStatus({ source: frame, data: { dp: "changes-status", found: new Array(301).fill(true) } }, frame)).toBeNull();
  });
});

describe("outline / asks messages (#714 gaps 4+5)", () => {
  const outline = {
    dp: "outline",
    headings: [
      { level: 1, text: "Profile cache", locator: "h1" },
      { level: 2, text: "Options", locator: "#options > h2:nth-of-type(1)" },
    ],
    pins: [1, -1],
    changes: [0],
  };
  const asks = { dp: "asks", asks: [{ kind: "decision", id: "decide-ttl", text: "Decide: a 60s TTL?", locator: "#decide-ttl" }], pinAsks: [0, -1] };

  it("accepts a valid outline, active index and asks from this frame only", () => {
    expect(acceptOutlineMessage({ source: frame, data: outline }, frame)).toEqual(outline);
    expect(acceptOutlineMessage({ source: otherFrame, data: outline }, frame)).toBeNull();
    expect(acceptOutlineMessage({ source: null, data: outline }, frame)).toBeNull();
    expect(acceptOutlineActive({ source: frame, data: { dp: "outline-active", index: 1 } }, frame)).toBe(1);
    expect(acceptOutlineActive({ source: frame, data: { dp: "outline-active", index: -1 } }, frame)).toBe(-1);
    expect(acceptOutlineActive({ source: otherFrame, data: { dp: "outline-active", index: 1 } }, frame)).toBeNull();
    expect(acceptAsksMessage({ source: frame, data: asks }, frame)).toEqual(asks);
    expect(acceptAsksMessage({ source: otherFrame, data: asks }, frame)).toBeNull();
  });

  it.each([
    ["a level-4 heading", { ...outline, headings: [{ level: 4, text: "x", locator: "h4" }], pins: [], changes: [] }],
    ["an empty heading text", { ...outline, headings: [{ level: 2, text: "", locator: "h2" }], pins: [], changes: [] }],
    ["an over-long heading", { ...outline, headings: [{ level: 2, text: "x".repeat(121), locator: "h2" }], pins: [], changes: [] }],
    ["an over-long locator", { ...outline, headings: [{ level: 2, text: "x", locator: "x".repeat(513) }], pins: [], changes: [] }],
    ["too many headings", { ...outline, headings: Array.from({ length: 201 }, () => ({ level: 2, text: "x", locator: "h2" })), pins: [], changes: [] }],
    ["a section index past the headings", { ...outline, pins: [2] }],
    ["a non-integer section", { ...outline, changes: [0.5] }],
    ["an extra field", { ...outline, html: "<b>x</b>" }],
    ["a heading with markup fields", { ...outline, headings: [{ level: 2, text: "x", locator: "h2", html: "<img>" }], pins: [], changes: [] }],
  ])("rejects a malformed outline: %s", (_label, data) => {
    expect(acceptOutlineMessage({ source: frame, data }, frame)).toBeNull();
  });

  it.each([
    ["an unknown kind", { dp: "asks", asks: [{ ...asks.asks[0], kind: "approve" }], pinAsks: [] }],
    ["an over-long text", { dp: "asks", asks: [{ ...asks.asks[0], text: "x".repeat(201) }], pinAsks: [] }],
    ["an empty id", { dp: "asks", asks: [{ ...asks.asks[0], id: "" }], pinAsks: [] }],
    ["no locator", { dp: "asks", asks: [{ kind: "question", text: "x" }], pinAsks: [] }],
    ["too many asks", { dp: "asks", asks: Array.from({ length: 51 }, () => asks.asks[0]), pinAsks: [] }],
    ["an extra field", { dp: "asks", asks: [{ ...asks.asks[0], commentId: "cmt_1" }], pinAsks: [] }],
    ["no pinAsks", { dp: "asks", asks: asks.asks }],
    ["a pinAsks index past the asks", { ...asks, pinAsks: [1] }],
    ["a pinAsks index below -1", { ...asks, pinAsks: [-2] }],
  ])("rejects malformed asks: %s", (_label, data) => {
    expect(acceptAsksMessage({ source: frame, data }, frame)).toBeNull();
  });

  it("rejects a bad active index", () => {
    for (const index of [200, -2, 1.5, "1", null]) {
      expect(acceptOutlineActive({ source: frame, data: { dp: "outline-active", index } }, frame)).toBeNull();
    }
  });

  it("askAnchor builds the element anchor a click on the ask would post", () => {
    expect(askAnchor(asks.asks[0] as any)).toEqual({ kind: "element", locator: "#decide-ttl", quote: "Decide: a 60s TTL?" });
  });
});
