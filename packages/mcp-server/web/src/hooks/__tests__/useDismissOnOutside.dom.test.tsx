import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useDismissOnOutside } from "../useDismissOnOutside";

function setup() {
  const inside = document.createElement("div");
  const child = document.createElement("textarea");
  inside.appendChild(child);
  const outside = document.createElement("button");
  document.body.append(inside, outside);
  const onDismiss = vi.fn();
  renderHook(() => useDismissOnOutside({ current: inside }, true, onDismiss));
  return { inside, child, outside, onDismiss };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("useDismissOnOutside", () => {
  it("a mousedown outside does NOT dismiss — closing on press shifted the next trigger out from under the release", () => {
    const { outside, onDismiss } = setup();
    fireEvent.mouseDown(outside);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a full click outside dismisses", () => {
    const { outside, onDismiss } = setup();
    fireEvent.mouseDown(outside);
    fireEvent.click(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a click inside keeps it open", () => {
    const { child, onDismiss } = setup();
    fireEvent.mouseDown(child);
    fireEvent.click(child);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("a press that starts inside and is released outside (drag-select) keeps it open", () => {
    const { child, outside, onDismiss } = setup();
    fireEvent.mouseDown(child);
    fireEvent.click(outside);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(outside);
    fireEvent.click(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape dismisses", () => {
    const { onDismiss } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
