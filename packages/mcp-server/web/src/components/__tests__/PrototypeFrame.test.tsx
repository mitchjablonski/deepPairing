import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrototypeFrame } from "../PrototypeFrame";

describe("PrototypeFrame", () => {
  it("is click-to-run: no iframe until the user opts in", () => {
    render(<PrototypeFrame html="<button onclick='alert(1)'>go</button>" />);
    // Banner + run gate, but nothing executing yet.
    expect(screen.getByText(/sandboxed . no network/i)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
  });

  it("on Run, mounts a hardened sandbox: opaque origin + CSP, agent html only inside srcdoc", async () => {
    render(<PrototypeFrame html="<h1>hello prototype</h1>" />);
    await userEvent.click(screen.getByRole("button", { name: /run prototype/i }));
    const iframe = document.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    // allow-scripts WITHOUT allow-same-origin → opaque origin, no parent access.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    const srcdoc = iframe.getAttribute("srcdoc") ?? "";
    // CSP injected + no network egress, and the agent html is contained in srcdoc.
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("<h1>hello prototype</h1>");
    // The agent html is NOT rendered into the parent document.
    expect(screen.queryByText("hello prototype")).not.toBeInTheDocument();
  });

  it("refuses to render a prototype over the size cap", () => {
    const huge = "<div>" + "x".repeat(520 * 1024) + "</div>";
    render(<PrototypeFrame html={huge} />);
    expect(screen.getByText(/too large to render safely/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run prototype/i })).not.toBeInTheDocument();
  });
});
