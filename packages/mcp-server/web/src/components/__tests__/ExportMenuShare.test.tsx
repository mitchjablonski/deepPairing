/**
 * Q5 — "Share as page (.html)" in the export menu. It DOWNLOADS a file rather
 * than copying markdown to the clipboard (a page is a document you send, not
 * text you paste), and the include-code checkbox rides the request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExportMenu } from "../ExportMenu";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "# md",
    blob: async () => new Blob(["<!doctype html>"], { type: "text/html" }),
  });
  // jsdom implements neither of these.
  (URL as any).createObjectURL = vi.fn(() => "blob:fake");
  (URL as any).revokeObjectURL = vi.fn();
});

function openMenu() {
  render(<ExportMenu />);
  fireEvent.click(screen.getByRole("button", { name: /export/i }));
}

describe("ExportMenu — share as page", () => {
  it("offers the shareable page alongside the six markdown formats", () => {
    openMenu();
    expect(screen.getByText("Share as page (.html)")).toBeTruthy();
    expect(screen.getByText("Full Report")).toBeTruthy();
    expect(screen.getByText("Learnings")).toBeTruthy();
  });

  it("downloads from /api/export.html with code included by default", async () => {
    openMenu();
    fireEvent.click(screen.getByText("Share as page (.html)"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/api/export.html");
    expect(url).toContain("includeCode=1");
    expect((URL as any).createObjectURL).toHaveBeenCalled();
  });

  it("drops the code bodies when the checkbox is cleared", async () => {
    openMenu();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Share as page (.html)"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]![0])).toContain("includeCode=0");
  });

  it("still copies markdown for the other formats", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    openMenu();
    fireEvent.click(screen.getByText("Full Report"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# md"));
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/export?format=full");
  });
});
