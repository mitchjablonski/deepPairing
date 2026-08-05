import { describe, it, expect } from "vitest";
import { RequestSchema, RequestIntentSchema, describeRequestIntent } from "../request.js";
import { CreateRequestBodySchema } from "../request-bodies.js";

describe("G1 (#198b) Request schema", () => {
  it("accepts a well-formed request", () => {
    const r = RequestSchema.parse({
      id: "req_abc",
      text: "the auth middleware",
      intent: "explain",
      createdAt: "2026-08-04T00:00:00.000Z",
    });
    expect(r.servedByArtifactId).toBeUndefined();
  });

  it("carries an optional servedByArtifactId (back-compat: absent loads unchanged)", () => {
    const r = RequestSchema.parse({
      id: "req_abc",
      text: "x",
      intent: "plan",
      createdAt: "2026-08-04T00:00:00.000Z",
      servedByArtifactId: "art_1",
    });
    expect(r.servedByArtifactId).toBe("art_1");
  });

  it("enforces the three intent presets", () => {
    expect(RequestIntentSchema.options).toEqual(["explain", "plan", "status"]);
    expect(RequestSchema.safeParse({ id: "r", text: "x", intent: "wat", createdAt: "2026-08-04T00:00:00.000Z" }).success).toBe(false);
  });

  it("CreateRequestBodySchema requires non-empty text + a valid intent", () => {
    expect(CreateRequestBodySchema.safeParse({ text: "", intent: "explain" }).success).toBe(false);
    expect(CreateRequestBodySchema.safeParse({ text: "x", intent: "nope" }).success).toBe(false);
    expect(CreateRequestBodySchema.safeParse({ text: "x", intent: "status" }).success).toBe(true);
  });

  it("describeRequestIntent names the fulfilling tool per intent", () => {
    expect(describeRequestIntent("explain")).toMatch(/present_explainer/);
    expect(describeRequestIntent("plan")).toMatch(/present_plan/);
    expect(describeRequestIntent("status")).toMatch(/present_debrief/);
  });
});
