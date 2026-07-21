/**
 * #175 — the ONE central keymap for the changeset review surface.
 *
 * Every changeset-review shortcut resolves through this module — NOT scattered
 * `onKeyDown` handlers across the component. That's the whole point: making the
 * bindings rebindable later (an accessibility/conflict/non-QWERTY config screen,
 * explicitly OUT OF SCOPE for now) becomes a data change here, not a refactor.
 * The `?` cheat-sheet also renders from CHANGESET_KEYMAP so the two can't drift.
 *
 * Scope: these keys are live ONLY while a changeset artifact is focused (the
 * component binds a capture-phase listener and stops propagation), so they never
 * clobber App.tsx's global a/r/j/k/n.
 */

/** The reviewer's intents — what a keystroke MEANS, decoupled from the key. */
export type ChangesetIntent =
  | "lookRight" // mark the active file looks-right, then advance to the next file
  | "needsChanges" // flag the active file, focus its reason box
  | "nextFile"
  | "prevFile"
  | "fireDerivedAction" // ⏎ — approve / send-back, whichever the file states derive
  | "approveAll"; // ⇧⏎ — mark every file look-right + approve (the fast path)

/** One binding: how to MATCH a KeyboardEvent + how to DESCRIBE it. */
export interface ChangesetBinding {
  intent: ChangesetIntent;
  /** Lowercased `event.key` this binds to. */
  key: string;
  /** Require the Shift modifier (⇧⏎). Default false. */
  shift?: boolean;
  /** Display glyph for the cheat-sheet (e.g. "a", "⏎", "⇧⏎"). */
  glyph: string;
  /** Human-readable description for the cheat-sheet. */
  description: string;
}

/**
 * The default bindings. A future rebind screen swaps `key`/`shift` here.
 * `fireDerivedAction` and `approveAll` both bind Enter — Shift disambiguates —
 * so resolve MUST check the shifted binding first (see `resolveChangesetKey`).
 */
export const CHANGESET_KEYMAP: ChangesetBinding[] = [
  { intent: "lookRight", key: "a", glyph: "a", description: "Looks right → next file" },
  { intent: "needsChanges", key: "r", glyph: "r", description: "Needs changes (focus the reason)" },
  { intent: "nextFile", key: "j", glyph: "j", description: "Next file" },
  { intent: "prevFile", key: "k", glyph: "k", description: "Previous file" },
  { intent: "approveAll", key: "enter", shift: true, glyph: "⇧⏎", description: "Approve all files (fast path)" },
  { intent: "fireDerivedAction", key: "enter", glyph: "⏎", description: "Approve / send back (the derived action)" },
];

/**
 * Resolve a KeyboardEvent to a changeset intent, or null when nothing binds.
 * Ctrl/Meta/Alt chords are the browser's — never a changeset intent. Shifted
 * bindings win over their unshifted twin (⇧⏎ before ⏎).
 */
export function resolveChangesetKey(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): ChangesetIntent | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  // Prefer the most specific (shift-requiring) binding for this key.
  const candidates = CHANGESET_KEYMAP.filter((b) => b.key === key);
  const shifted = candidates.find((b) => b.shift === true);
  if (shifted && e.shiftKey) return shifted.intent;
  const plain = candidates.find((b) => !b.shift);
  if (plain && !e.shiftKey) return plain.intent;
  return null;
}
