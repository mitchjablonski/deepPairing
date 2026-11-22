/**
 * #680 slice 2 — the parent's filter for messages from the page frame: only
 * from THIS frame's contentWindow, only the expected `dp` type, and only an
 * anchor that parses against the shared schema (every field capped).
 */
import { describe, it, expect } from "vitest";
import { acceptAnchorMessage, acceptPinsStatus, isReadyMessage } from "../pageAnchorMessages";

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
