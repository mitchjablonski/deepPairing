/** #714 gap 4 — outline badge roll-up: a heading's count includes every
 *  deeper heading after it, up to the next heading of the same or higher level. */
import { describe, it, expect } from "vitest";
import { rollUpCounts } from "../artifacts/PageOutline";

describe("rollUpCounts", () => {
  it("sums descendants up to the next same-or-higher heading", () => {
    const levels = [1, 2, 3, 3, 2, 1, 3].map((level) => ({ level }));
    const own = [1, 2, 3, 4, 5, 6, 7];
    expect(rollUpCounts(levels, own).map((c) => c.total)).toEqual([15, 9, 3, 4, 5, 13, 7]);
    expect(rollUpCounts(levels, own).map((c) => c.own)).toEqual(own);
  });

  it("treats missing counts as zero", () => {
    expect(rollUpCounts([{ level: 2 }, { level: 3 }], [])).toEqual([{ total: 0, own: 0 }, { total: 0, own: 0 }]);
  });
});
