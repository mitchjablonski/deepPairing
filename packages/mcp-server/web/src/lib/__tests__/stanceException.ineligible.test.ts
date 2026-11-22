/**
 * #680 slice 3 (review P3-8) — a block the page file watch raised names its
 * source: a file save has no call to allow once.
 */
import { describe, expect, it } from "vitest";
import { ineligibleText } from "../stanceException";

describe("ineligibleText", () => {
  it("explains a file-watch block", () => {
    const t = ineligibleText("file_watch");
    expect(t).toMatch(/file save/);
    expect(t).toMatch(/edit the file again, or call revise_artifact/);
  });
  it("keeps the generic fallback for unknown reasons", () => {
    expect(ineligibleText("something_else")).toBe("This block can't be allowed once.");
  });
});
