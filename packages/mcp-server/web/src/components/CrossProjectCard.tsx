import { useEffect, useLayoutEffect, useRef } from "react";
import { useCrossProjectStore } from "../stores/crossProject";
import { useToastStore } from "../stores/toast";

/**
 * Q2 — the FIRST-REJECT card.
 *
 * Offered once, right after the human's first "Reject & remember" in this
 * project. That timing is the whole design: they have just typed a
 * cross-project memory key into a field that told them it was one, so the
 * mechanic is freshly in mind and "want this flagged on your other projects
 * too?" is a follow-through, not an interruption. Everywhere else it would be
 * a settings nag.
 *
 * It exists because cross-project publishing was structurally unreachable on
 * the recommended (marketplace) install — see stores/crossProject.ts. The card
 * is the discovery path; the Autonomy popover is the permanent home for anyone
 * who says "Not now".
 *
 * Honest by construction: it states exactly what enabling does (concept titles
 * and the reasons you typed, written to ~/.deeppairing, readable by your other
 * projects), and "Not now" is a real answer — the card never returns.
 */
export function CrossProjectCard() {
  const visible = useCrossProjectStore((s) => s.cardVisible);
  const saving = useCrossProjectStore((s) => s.saving);
  const setPublish = useCrossProjectStore((s) => s.setPublish);
  const dismissCard = useCrossProjectStore((s) => s.dismissCard);
  const setCardHeight = useCrossProjectStore((s) => s.setCardHeight);
  const cardRef = useRef<HTMLDivElement | null>(null);

  /**
   * R2 — publish the card's rendered height so ToastLayer can lift its column
   * clear of it. See the z-index note on the element below for why the card,
   * not the toasts, owns the corner.
   *
   * offsetHeight is 0 in jsdom, and the store clamps non-positive values to 0,
   * so tests (and any headless host) simply fall back to the toasts' normal
   * bottom-4 placement rather than reading a bogus offset.
   */
  useLayoutEffect(() => {
    // The card is always MOUNTED (App renders it unconditionally); `visible`
    // is what gates the render — so the "gone" case has to zero the height
    // here, not in an unmount cleanup that never runs.
    setCardHeight(visible ? (cardRef.current?.offsetHeight ?? 0) : 0);
  }, [visible, setCardHeight]);
  useEffect(() => () => setCardHeight(0), [setCardHeight]);

  if (!visible) return null;

  const enable = async () => {
    const ok = await setPublish(true);
    // Dismiss either way: the question has been answered. On failure the store
    // already toasted and rolled back, and the popover toggle remains.
    dismissCard();
    if (ok) {
      useToastStore.getState().push({
        kind: "info",
        title: "Cross-project memory on",
        body: "New stances you record here will be flagged (advisory) on your other projects.",
        ttl: 6000,
      });
    }
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Enable cross-project memory"
      data-testid="cross-project-card"
      /* R2 — the card OWNS the bottom-right corner while it is open.
         Round 13 (screenshot-verified): the card shipped at z-40 and the toast
         stack sits at z-[60] in the same fixed corner, so at the exact moment
         of consent BOTH buttons were painted over — and click-intercepted — by
         the ledger-write and "sent" toasts for the ~5-6s they live. A consent
         prompt you can't click is worse than no prompt.
         Judged in the card's favour: it is the rarer and more consequential
         surface (offered once per project, and it governs whether your stances
         leave this machine's project boundary), while a ledger toast is
         informational and repeats. So the card goes ABOVE the toasts — and,
         rather than simply burying them, it publishes its height so ToastLayer
         lifts its column clear and both stay readable. */
      className="fixed bottom-4 right-4 z-[70] w-[22rem] max-w-[calc(100vw-2rem)]
                 rounded-lg border border-accent-blue/30 bg-surface-elevated shadow-2xl
                 overflow-hidden"
    >
      <div className="px-4 py-3 space-y-2">
        <div className="text-xs font-semibold text-text-primary">
          Stance recorded.
        </div>
        <div className="text-2xs text-text-secondary leading-relaxed">
          Next time the agent proposes this here, it gets stopped — it refuses and
          quotes your reason back. Want it flagged on your other projects too?
        </div>
        {/* Q2 review H2 — this is the point of CONSENT, so it has to be exactly
            true. The earlier draft promised "no code, diffs, or file paths leave
            this project"; the review executed a real publish and found a
            changeset-reject key of "packages/api/src/auth/session-store.ts —
            swap Redis for an in-memory Map". We now strip a machine-generated
            path prefix from that one fallback (concept-hygiene.ts), but a
            stance title is the human's own words — if they typed a path, we
            keep it — so the copy discloses the actual payload and its one
            caveat rather than making a promise the mechanism can't keep.
            Item 13: turning it back off is also not a retraction, and saying so
            here is cheaper than a surprise later. */}
        <div className="text-[10px] text-text-muted leading-relaxed">
          Publishing writes three things to
          <code className="mx-1 px-1 rounded bg-surface-secondary">~/.deeppairing</code>
          where your other projects can read them: the stance itself, the reason you
          typed, and this project’s folder name. No code, no diffs, and nothing
          leaves your machine — but a stance is <em>your</em> wording, so if you name
          a file in it, that name travels with it. Elsewhere it’s only an advisory
          nudge, never a block. You can turn this off later; that stops new stances
          being published but doesn’t withdraw ones already written.
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={enable}
            disabled={saving}
            className="px-2.5 py-1 text-2xs font-medium text-white bg-accent-blue-strong rounded
                       hover:bg-accent-blue-strong-hover disabled:opacity-50
                       transition-all duration-[180ms] ease-out press-scale"
          >
            Enable cross-project
          </button>
          <button
            type="button"
            onClick={dismissCard}
            disabled={saving}
            className="px-2.5 py-1 text-2xs text-text-muted hover:text-text-secondary disabled:opacity-50 transition-colors"
          >
            Not now
          </button>
          {/* Q2 review item 9 — the switch lives in the header's ⋯ diagnostics
              menu, not in the Settings sheet. Pointing someone who said "Not
              now" at a place the control isn't is worse than saying nothing. */}
          <span className="ml-auto text-[10px] text-text-muted">
            Later: ⋯ → Autonomy
          </span>
        </div>
      </div>
    </div>
  );
}
