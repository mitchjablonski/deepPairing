import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { ArtifactStatusActions } from "../ArtifactStatusActions";
import { useArtifactStore } from "../../../stores/artifact";
import { useConnectionStore } from "../../../stores/connection";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_x",
    sessionId: "s1",
    type: "research",
    version: 1,
    parentId: null,
    title: "Test artifact",
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt: "2026-04-17T10:00:00.000Z",
    updatedAt: "2026-04-17T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ autonomyLevel: "supervised" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ArtifactStatusActions — status branches", () => {
  it("approved: shows ✓ Approved and no action buttons", () => {
    render(<ArtifactStatusActions artifact={artifact({ status: "approved" })} />);
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Approve/i })).not.toBeInTheDocument();
  });

  it("rejected: shows ✗ Rejected", () => {
    render(<ArtifactStatusActions artifact={artifact({ status: "rejected" })} />);
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it("revised: shows Revision requested + awaiting agent", () => {
    render(<ArtifactStatusActions artifact={artifact({ status: "revised" })} />);
    expect(screen.getByText("Revision requested")).toBeInTheDocument();
    expect(screen.getByText(/awaiting agent/i)).toBeInTheDocument();
  });

  it("reviewing: shows Under review", () => {
    render(<ArtifactStatusActions artifact={artifact({ status: "reviewing" })} />);
    expect(screen.getByText("Under review")).toBeInTheDocument();
  });

  it("superseded: shows Superseded by newer version", () => {
    render(<ArtifactStatusActions artifact={artifact({ status: "superseded" })} />);
    expect(screen.getByText(/superseded by newer version/i)).toBeInTheDocument();
  });

  it("retracted: shows Retracted by agent + reason", () => {
    render(
      <ArtifactStatusActions
        artifact={artifact({
          status: "retracted",
          content: { retractReason: "wrong file" },
        })}
      />,
    );
    expect(screen.getByText(/retracted by agent/i)).toBeInTheDocument();
    expect(screen.getByText("wrong file")).toBeInTheDocument();
  });
});

describe("ArtifactStatusActions — draft interactions", () => {
  it("shows all three action buttons", () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request Revision/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeInTheDocument();
  });

  it("Reject + Request Revision are disabled without a comment", () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    expect(screen.getByRole("button", { name: /Request Revision/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject$/ })).toBeDisabled();
  });

  it("typing a comment enables Reject and Request Revision", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "needs a rethink");
    expect(screen.getByRole("button", { name: /Request Revision/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject$/ })).not.toBeDisabled();
  });

  it("clicking Approve hits /api/artifacts/:id/status with approved", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    await userEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/artifacts/art_x/status"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"status":"approved"'),
        }),
      ),
    );
  });

  it("clicking Request Revision submits both the comment and revised status", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "please re-do");

    await userEvent.click(screen.getByRole("button", { name: /Request Revision/i }));

    // Two fetches: comment POST + status POST
    await waitFor(() => {
      const calls = (fetch as any).mock.calls.map((c: any) => c[0]);
      expect(calls.some((u: string) => u.includes("/api/comments"))).toBe(true);
      expect(calls.some((u: string) => u.includes("/api/artifacts/art_x/status"))).toBe(true);
    });
    // Body of the status call includes "revised"
    const statusCall = (fetch as any).mock.calls.find((c: any) =>
      c[0].includes("/api/artifacts/art_x/status"),
    );
    expect(statusCall[1].body).toContain('"status":"revised"');
  });

  it("Cmd+Enter in the textarea submits approve", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    const textarea = screen.getByRole("textbox");
    await userEvent.click(textarea);
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/artifacts/art_x/status"),
        expect.any(Object),
      ),
    );
  });

  it("Approve label changes to 'Approve with note' when a comment is typed", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "good work");
    expect(screen.getByRole("button", { name: /Approve with note/i })).toBeInTheDocument();
  });

  it("Respond button is the primary action — submits the comment without status change (I1)", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    // Disabled when empty
    expect(screen.getByRole("button", { name: /^Respond$/ })).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox"), "a thought");
    const respondBtn = screen.getByRole("button", { name: /^Respond$/ });
    expect(respondBtn).not.toBeDisabled();

    await userEvent.click(respondBtn);

    await waitFor(() => {
      const calls = (fetch as any).mock.calls.map((c: any) => c[0]);
      // Responded: comment POST hit
      expect(calls.some((u: string) => u.includes("/api/comments"))).toBe(true);
      // But NOT a status update — the artifact stays in draft
      expect(calls.some((u: string) => u.includes("/api/artifacts/art_x/status"))).toBe(false);
    });
  });

  it("Cmd+Enter with text in the textarea sends a Respond, not an Approve (I1)", async () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "here's my thought");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => {
      const calls = (fetch as any).mock.calls.map((c: any) => c[0]);
      expect(calls.some((u: string) => u.includes("/api/comments"))).toBe(true);
      expect(calls.some((u: string) => u.includes("/api/artifacts/art_x/status"))).toBe(false);
    });
  });
});

describe("ArtifactStatusActions — keyboard shortcut event", () => {
  it("dp:artifact-shortcut(approve) arms the 3s countdown", async () => {
    vi.useFakeTimers();
    render(<ArtifactStatusActions artifact={artifact()} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("dp:artifact-shortcut", {
          detail: { artifactId: "art_x", action: "approve" },
        }),
      );
    });
    // The arm event fires the countdown UI synchronously via setState
    expect(screen.getByText(/Will auto-approve in 3s/)).toBeInTheDocument();
  });

  it("dp:artifact-shortcut(revise) focuses the textarea", () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("dp:artifact-shortcut", {
          detail: { artifactId: "art_x", action: "revise" },
        }),
      );
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("ignores shortcut events for a different artifactId", () => {
    render(<ArtifactStatusActions artifact={artifact()} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("dp:artifact-shortcut", {
          detail: { artifactId: "someone_else", action: "approve" },
        }),
      );
    });
    expect(screen.queryByText(/Will auto-approve/)).not.toBeInTheDocument();
  });
});
