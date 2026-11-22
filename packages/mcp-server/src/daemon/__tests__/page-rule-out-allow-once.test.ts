/**
 * #680 slice 4 — a page rule-out block offers no "Allow once": present_page, a
 * page revise and a file-watch save can't honour an allowance. Through the
 * REAL daemon + DaemonClient + MCP server (the stance-exceptions harness), so
 * the row's origin also has to survive the daemon's memory API to scope the gate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { StanceWorld } from "./stance-exceptions.harness.js";

let world: StanceWorld;
afterEach(async () => { await world?.dispose(); });

describe("#680 slice 4 — page rule-out blocks are never allow-once eligible", () => {
  it("present_page refused by a page rule-out: eligible:false (page_rule_out), and the refusal suggests the page or the Ledger, not allow-once", async () => {
    world = new StanceWorld("dp-ro-allow-");
    const w = await world.wrapper();
    world.store(w.sessionId).recordRejectedApproach({ description: "Up to 60s", reason: "too stale", origin: "page_rule_out" });

    // Page-only through the daemon path too: a non-page proposal naming it passes.
    const findings = await w.call("present_findings", {
      title: "Cache review",
      summary: "TTL is up to 60s today.",
      findings: [{ category: "design", title: "Up to 60s staleness", detail: "seen in prod", significance: "low" }],
    });
    expect(findings.isError, findings.text).toBeFalsy();

    const res = await w.call("present_page", { title: "Cache", html: "<p>TTL expiry, up to 60s stale</p>" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(res.text).toContain("can't be allowed once");
    expect(res.text).toContain("retire it in the companion's Ledger");
    expect(res.text).not.toMatch(/ask the human to allow this proposal once/);

    expect(await world.newestBlock()).toMatchObject({ toolName: "present_page", eligible: false, ineligibleReason: "page_rule_out" });
  });
});
