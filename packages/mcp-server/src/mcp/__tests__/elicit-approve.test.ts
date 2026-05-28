/**
 * U0.2 — pin the elicitation approve/review decision logic.
 *
 * Field bug context: a user reported their artifact silently flipped to
 * APPROVED while they were trying to type a comment in the companion UI.
 * Root cause: the previous tryElicit used an empty `properties: {}` schema,
 * so the elicitation rendered as a bare "OK" prompt that some Claude Code
 * surfaces auto-accepted on plain Enter. Worse, the previous code treated
 * any `result.action === "accept"` as an approval — even if the content
 * payload was empty or null.
 *
 * Fix: require explicit `approve === true` from the user. Anything else
 * (Enter-through, decline, cancel, malformed result) routes to the
 * companion-UI review path. These tests pin that contract so a future
 * "let's accept the empty case again" regression can't ship silently.
 */
import { describe, it, expect } from "vitest";
import { decideElicitResponse, ELICIT_APPROVE_SCHEMA } from "../server.js";
import { terminalApproveEnabled } from "../tool-helpers.js";

describe("terminalApproveEnabled — terminal quick-approve is opt-in (off by default)", () => {
  it("is OFF when the env var is unset or not a truthy flag", () => {
    expect(terminalApproveEnabled({})).toBe(false);
    expect(terminalApproveEnabled({ DEEPPAIRING_TERMINAL_APPROVE: "" })).toBe(false);
    expect(terminalApproveEnabled({ DEEPPAIRING_TERMINAL_APPROVE: "0" })).toBe(false);
    expect(terminalApproveEnabled({ DEEPPAIRING_TERMINAL_APPROVE: "off" })).toBe(false);
  });
  it("is ON only when explicitly opted in (1/true/yes, case-insensitive)", () => {
    for (const v of ["1", "true", "yes", "YES", "True"]) {
      expect(terminalApproveEnabled({ DEEPPAIRING_TERMINAL_APPROVE: v })).toBe(true);
    }
  });
});

describe("decideElicitResponse (U0.2)", () => {
  it("returns 'approve' only when action=accept AND content.approve === true", () => {
    expect(decideElicitResponse({ action: "accept", content: { approve: true } })).toBe("approve");
  });

  it("returns 'review' when action=accept but content.approve is omitted (no Enter-through approve)", () => {
    expect(decideElicitResponse({ action: "accept", content: {} })).toBe("review");
  });

  it("returns 'review' when action=accept but content.approve === false", () => {
    expect(decideElicitResponse({ action: "accept", content: { approve: false } })).toBe("review");
  });

  it("returns 'review' when content is null/undefined (defensive against malformed clients)", () => {
    expect(decideElicitResponse({ action: "accept", content: null as any })).toBe("review");
    expect(decideElicitResponse({ action: "accept" })).toBe("review");
  });

  it("treats truthy-but-not-true (1, 'true', {}) as NOT approved — strict equality only", () => {
    // Explicitness matters here: the bug we're closing is an over-eager
    // accept. Stay strict and let the user resubmit with a real boolean
    // rather than silently approving on a fuzzy match.
    expect(decideElicitResponse({ action: "accept", content: { approve: 1 } as any })).toBe("review");
    expect(decideElicitResponse({ action: "accept", content: { approve: "true" } as any })).toBe("review");
    expect(decideElicitResponse({ action: "accept", content: { approve: {} } as any })).toBe("review");
  });

  it("returns 'review' on decline / cancel", () => {
    expect(decideElicitResponse({ action: "decline" })).toBe("review");
    expect(decideElicitResponse({ action: "cancel" })).toBe("review");
  });

  it("returns null on null/undefined/unknown action (caller falls back to polling)", () => {
    expect(decideElicitResponse(null)).toBeNull();
    expect(decideElicitResponse(undefined)).toBeNull();
    expect(decideElicitResponse({ action: "weird" })).toBeNull();
    expect(decideElicitResponse({})).toBeNull();
  });
});

describe("ELICIT_APPROVE_SCHEMA shape", () => {
  it("declares an `approve` boolean property with a default of false (pre-U0.2 was empty)", () => {
    // The schema is the safety mechanism: if it ever drifts back to
    // `properties: {}`, the elicitation form has no field for the user to
    // tick, the auto-accept-on-Enter bug returns. Pin both halves.
    expect(ELICIT_APPROVE_SCHEMA.type).toBe("object");
    expect(ELICIT_APPROVE_SCHEMA.properties.approve).toBeDefined();
    expect(ELICIT_APPROVE_SCHEMA.properties.approve.type).toBe("boolean");
    expect(ELICIT_APPROVE_SCHEMA.properties.approve.default).toBe(false);
  });

  it("does NOT mark `approve` as required — the user can decline by submitting empty", () => {
    expect(ELICIT_APPROVE_SCHEMA.required).toEqual([]);
  });
});
