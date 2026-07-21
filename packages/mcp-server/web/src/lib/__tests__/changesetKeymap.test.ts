import { describe, it, expect } from "vitest";
import { resolveChangesetKey, CHANGESET_KEYMAP } from "../changesetKeymap";

/** Build a minimal KeyboardEvent-shaped object for the pure resolver. */
const ev = (key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

describe("#175 changesetKeymap — the ONE central resolver", () => {
  it("binds a/r/j/k to their intents", () => {
    expect(resolveChangesetKey(ev("a"))).toBe("lookRight");
    expect(resolveChangesetKey(ev("r"))).toBe("needsChanges");
    expect(resolveChangesetKey(ev("j"))).toBe("nextFile");
    expect(resolveChangesetKey(ev("k"))).toBe("prevFile");
  });

  it("⏎ fires the derived action; ⇧⏎ is the approve-all fast path (shift wins)", () => {
    expect(resolveChangesetKey(ev("Enter"))).toBe("fireDerivedAction");
    expect(resolveChangesetKey(ev("Enter", { shiftKey: true }))).toBe("approveAll");
  });

  it("is case-insensitive on the key", () => {
    expect(resolveChangesetKey(ev("A"))).toBe("lookRight");
  });

  it("ignores Ctrl/Meta/Alt chords (they're the browser's) and unbound keys", () => {
    expect(resolveChangesetKey(ev("a", { metaKey: true }))).toBeNull();
    expect(resolveChangesetKey(ev("a", { ctrlKey: true }))).toBeNull();
    expect(resolveChangesetKey(ev("a", { altKey: true }))).toBeNull();
    expect(resolveChangesetKey(ev("n"))).toBeNull(); // global next-pending, NOT a changeset key
    expect(resolveChangesetKey(ev("q"))).toBeNull();
  });

  it("shift on a non-shift binding does not match (a plain 'a' with shift is not lookRight)", () => {
    // Only Enter has a shifted variant; a shifted 'a' has no binding.
    expect(resolveChangesetKey(ev("a", { shiftKey: true }))).toBeNull();
  });

  it("every binding carries a cheat-sheet glyph + description (drives the ? overlay)", () => {
    for (const b of CHANGESET_KEYMAP) {
      expect(b.glyph.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });
});
