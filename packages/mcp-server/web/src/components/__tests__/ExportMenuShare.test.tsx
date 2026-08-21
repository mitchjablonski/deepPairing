/**
 * Q5 — "Share as page (.html)" in the export menu. It DOWNLOADS a file rather
 * than copying markdown to the clipboard (a page is a document you send, not
 * text you paste), and the include-code checkbox rides the request.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExportMenu, filenameFromDisposition } from "../ExportMenu";

const fetchMock = vi.fn();

/** A response whose headers behave like a real Headers object — R3 reads two
 *  of them (the filename and the secret warning). */
function fakeResponse(headers: Record<string, string> = {}, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    text: async () => "# md",
    blob: async () => new Blob(["<!doctype html>"], { type: "text/html" }),
    ...over,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    fakeResponse({ "Content-Disposition": 'attachment; filename="session-s_queue-2026-08-21.html"' }),
  );
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

  // F7 — the old catch opened the same URL in a new tab, which CANNOT work
  // (II2 fail-closes /api/* without X-Project-Hash, which a plain navigation
  // never sends) — it just produced a 403 JSON page. Say what happened.
  it("surfaces an honest error instead of opening a tab that would 403", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    fetchMock.mockResolvedValueOnce(fakeResponse({}, { ok: false, status: 409 }));
    openMenu();
    fireEvent.click(screen.getByText("Share as page (.html)"));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toMatch(/daemon/i);
    expect(openSpy).not.toHaveBeenCalled();
  });

  // R3 — the download used to be hardcoded "deeppairing-session.html", so every
  // page a human ever downloaded had the same name and the second export
  // overwrote the first. The server already computes a session-stamped name.
  it("uses the server's session-stamped filename", async () => {
    const anchors: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === "a") anchors.push(el as HTMLAnchorElement);
      return el;
    });
    openMenu();
    fireEvent.click(screen.getByText("Share as page (.html)"));
    await waitFor(() => expect(anchors.length).toBeGreaterThan(0));
    expect(anchors[0]!.download).toBe("session-s_queue-2026-08-21.html");
    vi.restoreAllMocks();
  });

  it("parses the disposition defensively, and never lets it escape the folder", () => {
    expect(filenameFromDisposition('attachment; filename="session-a-2026-08-21.html"')).toBe(
      "session-a-2026-08-21.html",
    );
    expect(filenameFromDisposition("attachment; filename*=UTF-8''session-b-2026-08-21.html")).toBe(
      "session-b-2026-08-21.html",
    );
    const traversal = filenameFromDisposition('attachment; filename="../../etc/evil.html"');
    expect(traversal).not.toContain("/");
    expect(traversal.startsWith(".")).toBe(false);
    expect(traversal).toBe("_.._etc_evil.html");
    expect(filenameFromDisposition(null)).toBe("deeppairing-session.html");
    expect(filenameFromDisposition("attachment")).toBe("deeppairing-session.html");
    expect(filenameFromDisposition('attachment; filename="notes.txt"')).toBe("deeppairing-session.html");
  });

  // R3 — the MCP tool and the CLI have warned since F6; this menu is the
  // surface with a person behind it, and it was the silent one.
  it("relays the daemon's secret warning as a dismissible alert — without blocking the download", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        "Content-Disposition": 'attachment; filename="session-s_queue-2026-08-21.html"',
        "X-DeepPairing-Secret-Warning": "Possible secret in this page - review before sharing: AWS access key id in research.findings[0].evidence[0].snippet",
      }),
    );
    openMenu();
    fireEvent.click(screen.getByText("Share as page (.html)"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("AWS access key id");
    // Warn-only: the file downloaded exactly as before.
    expect((URL as any).createObjectURL).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows no alert for a clean export", async () => {
    openMenu();
    fireEvent.click(screen.getByText("Share as page (.html)"));
    await waitFor(() => expect((URL as any).createObjectURL).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
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
