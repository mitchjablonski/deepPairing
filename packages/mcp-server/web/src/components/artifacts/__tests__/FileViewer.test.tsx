import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api", () => ({ apiGet }));

import { FileViewer } from "../FileViewer";
import { useArtifactStore } from "../../../stores/artifact";

const okResponse = (content: string) => ({ ok: true, json: async () => ({ content }) });

beforeEach(() => {
  useArtifactStore.getState().reset();
  apiGet.mockReset();
});

describe("FileViewer — U3 dismissability", () => {
  it("loading branch has a Close button (a hung fetch can't trap the user) and Escape closes", async () => {
    apiGet.mockReturnValue(new Promise(() => {})); // never resolves → stays loading
    const onClose = vi.fn();
    render(<FileViewer filePath="/src/x.ts" onClose={onClose} />);

    expect(screen.getByText(/loading .*x\.ts/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("loaded view is a labelled dialog and the backdrop dismisses it", async () => {
    apiGet.mockResolvedValue(okResponse("line1\nline2"));
    const onClose = vi.fn();
    const { container } = render(<FileViewer filePath="/src/x.ts" onClose={onClose} />);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // clicking the backdrop (outermost fixed overlay) closes; clicking the panel does not
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".fixed.inset-0")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("U4 — a failed comment submit re-enables the composer and keeps the text (not stuck-disabled)", async () => {
    apiGet.mockResolvedValue(okResponse("alpha\nbeta\ngamma"));
    vi.spyOn(useArtifactStore.getState(), "submitComment").mockRejectedValue(new Error("network"));
    render(<FileViewer filePath="/src/x.ts" artifactId="art_1" onClose={() => {}} />);

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("1")); // select line 1 via its gutter number
    const input = await screen.findByPlaceholderText(/add your comment/i);
    await userEvent.type(input, "why this?");
    const btn = screen.getByRole("button", { name: "Comment" });
    await userEvent.click(btn);

    // pre-U4 `submitting` stayed true forever; now it re-enables + keeps the text
    await waitFor(() => expect(screen.getByRole("button", { name: "Comment" })).not.toBeDisabled());
    expect((screen.getByPlaceholderText(/add your comment/i) as HTMLInputElement).value).toBe("why this?");
  });
});
