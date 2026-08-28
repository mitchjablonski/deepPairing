import { describe, it, expect } from "vitest";
import { errorMessage, errorCode, errorName } from "../errors.js";

describe("errorMessage", () => {
  it("reads a string .message off an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads a string .message off a plain object (matches the old err?.message read)", () => {
    expect(errorMessage({ message: "plain" })).toBe("plain");
  });

  it("falls back to String(err) when no message, with no fallback given", () => {
    expect(errorMessage({ code: "ENOENT" })).toBe("[object Object]");
    expect(errorMessage("raw string")).toBe("raw string");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("uses the provided fallback when .message is absent", () => {
    expect(errorMessage({ code: "ENOENT" }, "Save failed")).toBe("Save failed");
    expect(errorMessage(null, "Search failed")).toBe("Search failed");
  });

  it("prefers a present message over the fallback", () => {
    expect(errorMessage(new Error("real"), "fallback")).toBe("real");
  });

  it("preserves an empty-string message (nullish semantics, not falsy)", () => {
    expect(errorMessage({ message: "" }, "fallback")).toBe("");
  });
});

describe("errorCode", () => {
  it("reads a string .code (Node ErrnoException shape)", () => {
    expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
  });

  it("returns undefined when .code is absent or non-string", () => {
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode("nope")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe("errorName", () => {
  it("reads a string .name (e.g. AbortError / TimeoutError)", () => {
    expect(errorName({ name: "AbortError" })).toBe("AbortError");
    expect(errorName(new Error("x"))).toBe("Error"); // Error instances carry name = "Error"
  });

  it("returns undefined when .name is absent", () => {
    expect(errorName({})).toBeUndefined();
    expect(errorName(undefined)).toBeUndefined();
  });
});
