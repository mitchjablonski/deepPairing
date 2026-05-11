import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useFocusTrap } from "../useFocusTrap";

/**
 * DD7 — restore focus to the previously-focused element when the trap
 * deactivates. Pre-DD7 a keyboard user opening a modal via a button
 * and pressing Esc found focus dropped to <body>. The hook now captures
 * document.activeElement on mount and restores it on cleanup.
 */

function Trapped({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} role="dialog">
      <button>inside-1</button>
      <button>inside-2</button>
    </div>
  );
}

function Harness({ trapActive }: { trapActive: boolean }) {
  return (
    <div>
      <button data-testid="trigger">trigger</button>
      {trapActive && <Trapped active />}
    </div>
  );
}

describe("useFocusTrap (DD7 — restore focus)", () => {
  it("restores focus to the previously-focused element when the trap unmounts", () => {
    const { getByTestId, rerender } = render(<Harness trapActive={false} />);
    const trigger = getByTestId("trigger") as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Activate the trap — focus moves into the dialog (first focusable).
    rerender(<Harness trapActive={true} />);
    expect(document.activeElement?.textContent).toBe("inside-1");

    // Deactivate — focus restored to the trigger.
    rerender(<Harness trapActive={false} />);
    expect(document.activeElement).toBe(trigger);
  });

  it("does NOT crash when the previously-focused element has been removed from the DOM", () => {
    const { getByTestId, rerender, unmount } = render(<Harness trapActive={false} />);
    const trigger = getByTestId("trigger") as HTMLButtonElement;
    trigger.focus();
    rerender(<Harness trapActive={true} />);
    // Unmount the entire harness (including the trigger) — DD7 cleanup
    // tries to restore focus but the trigger no longer exists.
    expect(() => unmount()).not.toThrow();
  });
});
