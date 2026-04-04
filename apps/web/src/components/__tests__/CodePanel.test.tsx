import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChangesList } from "../ChangesList";
import { useCodeStore } from "../../stores/code";
import type { CodeChangeEvent } from "@deeppairing/shared";

const change1: CodeChangeEvent = {
  type: "code_change",
  filePath: "/src/services/auth-service.ts",
  changeType: "create",
  diff: "--- /dev/null\n+++ b/src/services/auth-service.ts\n@@ -0,0 +1 @@\n+export class AuthService {}",
  reasoning: {
    type: "reasoning",
    action: "Create AuthService",
    reasoning: "Service pattern for auth logic",
    confidence: "high",
  },
  toolCallId: "tc_001",
};

const change2: CodeChangeEvent = {
  type: "code_change",
  filePath: "/src/routes/auth.ts",
  changeType: "modify",
  diff: "--- a/src/routes/auth.ts\n+++ b/src/routes/auth.ts\n@@ -1 +1 @@\n-old\n+new",
  toolCallId: "tc_002",
};

beforeEach(() => {
  useCodeStore.setState({ changes: [], selectedFile: null });
});

describe("ChangesList", () => {
  it("renders nothing when no changes", () => {
    const { container } = render(<ChangesList />);
    expect(container.firstChild).toBeNull();
  });

  it("renders changed files with type indicators", () => {
    useCodeStore.setState({ changes: [change1, change2], selectedFile: change1.filePath });
    render(<ChangesList />);

    expect(screen.getByText("auth-service.ts")).toBeInTheDocument();
    expect(screen.getByText("auth.ts")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument(); // create
    expect(screen.getByText("M")).toBeInTheDocument(); // modify
  });

  it("shows file count", () => {
    useCodeStore.setState({ changes: [change1, change2], selectedFile: null });
    render(<ChangesList />);

    expect(screen.getByText("Changed Files (2)")).toBeInTheDocument();
  });

  it("highlights selected file", () => {
    useCodeStore.setState({ changes: [change1, change2], selectedFile: change1.filePath });
    render(<ChangesList />);

    const selectedButton = screen.getByText("auth-service.ts").closest("button");
    expect(selectedButton?.className).toContain("bg-blue-50");
  });

  it("calls selectFile on click", () => {
    useCodeStore.setState({ changes: [change1, change2], selectedFile: change1.filePath });
    render(<ChangesList />);

    fireEvent.click(screen.getByText("auth.ts"));
    expect(useCodeStore.getState().selectedFile).toBe("/src/routes/auth.ts");
  });

  it("shows reasoning indicator dot for changes with reasoning", () => {
    useCodeStore.setState({ changes: [change1, change2], selectedFile: null });
    render(<ChangesList />);

    // change1 has reasoning, change2 doesn't
    const dots = document.querySelectorAll('[title="Has reasoning"]');
    expect(dots).toHaveLength(1);
  });

  it("shows directory path in muted text", () => {
    useCodeStore.setState({ changes: [change1], selectedFile: null });
    render(<ChangesList />);

    expect(screen.getByText("/src/services/")).toBeInTheDocument();
  });
});
