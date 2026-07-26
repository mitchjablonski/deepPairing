import { describe, it, expect } from "vitest";
import {
  positionPopover,
  POPOVER_GAP,
  type PopoverRect,
  type PopoverSize,
} from "../popoverPosition";

// A generous well and a small popover: the default room-everywhere geometry.
const WELL: PopoverSize = { width: 800, height: 600 };
const POP: PopoverSize = { width: 288, height: 180 };

describe("positionPopover (#185 region-composer placement)", () => {
  it("places the popover BELOW a rect near the top, top-aligned to the rect's left", () => {
    const rect: PopoverRect = { left: 120, top: 40, width: 160, height: 60 };
    const pos = positionPopover(rect, WELL, POP);
    expect(pos.placement).toBe("below");
    // Directly beneath the rect, gap included — never occluding the selection.
    expect(pos.top).toBe(rect.top + rect.height + POPOVER_GAP);
    expect(pos.left).toBe(rect.left);
    // The popover sits fully below the rect's bottom edge.
    expect(pos.top).toBeGreaterThanOrEqual(rect.top + rect.height);
  });

  it("FLIPS above when there's no vertical room below (rect near the bottom)", () => {
    // Rect low in the well: below would overflow, so it must flip above.
    const rect: PopoverRect = { left: 120, top: 560, width: 160, height: 30 };
    const pos = positionPopover(rect, WELL, POP);
    expect(pos.placement).toBe("above");
    expect(pos.top).toBe(rect.top - POPOVER_GAP - POP.height);
    // Fully above the rect's top edge — the selection stays visible.
    expect(pos.top + POP.height).toBeLessThanOrEqual(rect.top);
  });

  it("CLAMPS horizontally so a rect near the right edge never spills the popover past the well", () => {
    const rect: PopoverRect = { left: 760, top: 40, width: 30, height: 30 };
    const pos = positionPopover(rect, WELL, POP);
    expect(pos.placement).toBe("below");
    // rect.left (760) + popover width (288) would be 1048 > 800 → clamp to
    // well.width - popover.width = 512.
    expect(pos.left).toBe(WELL.width - POP.width);
    expect(pos.left + POP.width).toBeLessThanOrEqual(WELL.width);
  });

  it("goes BESIDE (right) when neither below nor above fits, clear of the rect", () => {
    // A short well where a tall rect leaves no room above OR below the popover.
    const shortWell: PopoverSize = { width: 800, height: 200 };
    const tallPop: PopoverSize = { width: 200, height: 190 };
    const rect: PopoverRect = { left: 100, top: 20, width: 120, height: 160 };
    const pos = positionPopover(rect, shortWell, tallPop);
    expect(pos.placement).toBe("right");
    // To the right of the rect (offset past its right edge → never occludes it).
    expect(pos.left).toBe(rect.left + rect.width + POPOVER_GAP);
    // Vertically clamped into the well.
    expect(pos.top).toBeGreaterThanOrEqual(0);
    expect(pos.top + tallPop.height).toBeLessThanOrEqual(shortWell.height);
  });

  it("goes BESIDE (left) when there's no room below, above, OR to the right", () => {
    const shortWell: PopoverSize = { width: 400, height: 200 };
    const tallPop: PopoverSize = { width: 200, height: 190 };
    // Rect hugs the right edge: right-beside would overflow, so flip to left.
    const rect: PopoverRect = { left: 260, top: 20, width: 120, height: 160 };
    const pos = positionPopover(rect, shortWell, tallPop);
    expect(pos.placement).toBe("left");
    expect(pos.left).toBe(rect.left - POPOVER_GAP - tallPop.width);
    expect(pos.left).toBeGreaterThanOrEqual(0);
  });

  it("TINY well (nothing fits): degrades to a clamped below placement, always in-bounds", () => {
    const tinyWell: PopoverSize = { width: 120, height: 90 };
    const pop: PopoverSize = { width: 288, height: 180 };
    const rect: PopoverRect = { left: 10, top: 10, width: 40, height: 30 };
    const pos = positionPopover(rect, tinyWell, pop);
    expect(pos.placement).toBe("below");
    // Coordinates never go negative even when the popover is bigger than the well.
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.top).toBeGreaterThanOrEqual(0);
  });

  it("all-zero geometry (jsdom): returns a below placement at the origin (no NaN)", () => {
    const pos = positionPopover(
      { left: 0, top: 0, width: 0, height: 0 },
      { width: 0, height: 0 },
      { width: 0, height: 0 },
    );
    expect(pos.placement).toBe("below");
    expect(Number.isNaN(pos.left)).toBe(false);
    expect(Number.isNaN(pos.top)).toBe(false);
  });
});
