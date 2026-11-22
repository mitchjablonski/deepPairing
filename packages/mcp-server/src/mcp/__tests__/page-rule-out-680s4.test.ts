/**
 * #680 slice 4 — "Rule this out" on a spot in a page: the human's explicit
 * submit records a rejected stance from the anchored text (description = the
 * capped quote, reason = their own words, sourceArtifactId = the page, the
 * anchor kept for provenance), leaves an anchored comment marked `ruleOut`,
 * and leaves the page under review. The EXISTING gate then refuses a later
 * present_page / revise whose page text contains that phrase, with the reason,
 * and check_feedback tells the agent in the page's comment lane.
 *
 * Fakes, not mocks: a real FileStore, the real HTTP routes, the real MCP server.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PAGE_RULE_OUT_MESSAGES } from "@deeppairing/shared";
import type { FileStore } from "../../store/file-store.js";
import { getGlobalStore } from "../../store/global-store.js";
import { findRejectedApproachMatch } from "../preflight-validator.js";
import { readRejectedApproachEntries } from "../../cli/preflight-hook-core.js";
import { recordStance, formatRecordStanceOutcome } from "../../store/stance-add.js";
import { createHttpRoutes } from "../../http/routes.js";
import { withHash } from "../../http/__tests__/routes.harness.js";
import { setupServerTest, makeCallTool } from "./server-test-harness.js";

const ctx = setupServerTest();
const callTool = makeCallTool(ctx);
let store: FileStore;
let app: ReturnType<typeof createHttpRoutes>;
let broadcasts: any[];
beforeEach(() => {
  store = ctx.store;
  broadcasts = [];
  app = withHash(createHttpRoutes(store, ctx.tmpDir, (e) => broadcasts.push(e)), ctx.tmpDir);
});

const LONG_SENTENCE =
  "We keep a second write-through purge queue on every node so that a dropped invalidation message never leaves a stale session behind for longer than one heartbeat interval in production";

const PAGE_HTML =
  "<h1>Cache invalidation</h1>" +
  "<p>You can pick one of three strategies for the session cache.</p>" +
  "<table><tr><th>Strategy</th><th>Staleness</th></tr>" +
  "<tr><td>TTL expiry</td><td>Up to 60s</td></tr>" +
  "<tr><td>Write-through purge</td><td>None</td></tr></table>" +
  "<p>Note: shard the purge queue by tenant id</p>" +
  `<p>${LONG_SENTENCE}</p>` +
  "<div><p>Red apples ripen.</p><p>Green pears soften.</p><p>Blue plums dry.</p></div>" +
  "<img alt=\"\" src=\"x.png\">";

async function presentPage(html = PAGE_HTML): Promise<string> {
  const res = await callTool("present_page", { title: "Session cache strategies", summary: "Which one should I build?", html });
  expect(res.isError, res.text).toBeFalsy();
  return store.getArtifacts().filter((a) => a.type === "page").at(-1)!.id;
}

const cellAnchor = {
  kind: "cell" as const,
  locator: "table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)",
  quote: "Up to 60s",
  table: { row: "TTL expiry", col: "Staleness" },
  version: 1,
};

const ruleOut = (artifactId: string, body: unknown) =>
  app.request(`/api/artifacts/${artifactId}/rule-out`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("#680 slice 4 — recording the stance", () => {
  it("records a human-authored stance from the anchored text and an anchored ruleOut comment; the page stays under review", async () => {
    const id = await presentPage();
    const res = await ruleOut(id, { htmlAnchor: cellAnchor, reason: "  sixty seconds of stale sessions logged people out  " });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ status: "recorded", description: "Up to 60s", alreadyRecorded: false, reason: "sixty seconds of stale sessions logged people out" });

    const rows = store.getSessionMemory().rejectedApproaches;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: "Up to 60s",
      reason: "sixty seconds of stale sessions logged people out",
      sourceArtifactId: id,
      sourceAnchor: cellAnchor,
    });

    const comments = store.getCommentsForArtifact(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "human",
      content: "sixty seconds of stale sessions logged people out",
      ruleOut: { description: "Up to 60s" },
      target: { artifactId: id, htmlAnchor: cellAnchor },
    });

    // Element-level: the page is NOT rejected or closed.
    expect(store.getArtifacts().find((a) => a.id === id)!.status).toBe("draft");
    expect(broadcasts.filter((b) => b?.type === "ledger_write" && b.kind === "rejected")).toEqual([
      expect.objectContaining({ description: "Up to 60s", sourceArtifactId: id }),
    ]);
    expect(broadcasts.some((b) => b?.type === "comment_added" && b.comment.id === comments[0]!.id)).toBe(true);
    expect(broadcasts.some((b) => b?.type === "artifact_status_changed" || b?.type === "artifact_updated")).toBe(false);
  });

  it("a repeat is idempotent on the stance (first reason kept)", async () => {
    const id = await presentPage();
    await ruleOut(id, { htmlAnchor: cellAnchor, reason: "first" });
    const again = await ruleOut(id, { htmlAnchor: cellAnchor, reason: "second" });
    expect(again.status).toBe(200);
    const body = await again.json() as any;
    expect(body).toMatchObject({ alreadyRecorded: true, reason: "first" });
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(1);
    // No second rule-out comment with a different reason: the first is reused.
    const ruleOuts = store.getCommentsForArtifact(id).filter((c) => c.ruleOut);
    expect(ruleOuts.map((c) => c.content)).toEqual(["first"]);
    expect(body.comment.id).toBe(ruleOuts[0]!.id);
  });

  it("a repeat whose first comment never landed leaves one, carrying the RECORDED reason", async () => {
    const id = await presentPage();
    store.recordRejectedApproach({ description: "Up to 60s", reason: "first", sourceArtifactId: id, origin: "page_rule_out" });
    const res = await ruleOut(id, { htmlAnchor: cellAnchor, reason: "second" });
    expect(await res.json()).toMatchObject({ alreadyRecorded: true, reason: "first" });
    expect(store.getCommentsForArtifact(id).filter((c) => c.ruleOut).map((c) => c.content)).toEqual(["first"]);
  });

  it("a phrase already rejected some other way is not re-labelled: no rule-out comment", async () => {
    const id = await presentPage();
    store.recordRejectedApproach({ description: "Up to 60s", reason: "from a decision card" });
    const res = await ruleOut(id, { htmlAnchor: cellAnchor, reason: "mine" });
    expect(await res.json()).toMatchObject({ alreadyRecorded: true, reason: "from a decision card" });
    expect(store.getCommentsForArtifact(id)).toHaveLength(0);
  });

  it("caps a long quote at a word boundary, as a literal prefix of the page text", async () => {
    const id = await presentPage();
    const res = await ruleOut(id, { htmlAnchor: { kind: "text", locator: "p:nth-of-type(3)", quote: LONG_SENTENCE }, reason: "no second queue" });
    expect(res.status).toBe(200);
    const { description } = await res.json() as { description: string };
    expect(description.length).toBeLessThanOrEqual(120);
    expect(LONG_SENTENCE.startsWith(description)).toBe(true);
    expect(LONG_SENTENCE.charAt(description.length)).toBe(" ");
  });

  it("keeps only the longest colon-free part of a quote (the gate would otherwise match the post-colon noun alone)", async () => {
    const id = await presentPage();
    const res = await ruleOut(id, { htmlAnchor: { kind: "element", locator: "p:nth-of-type(2)", quote: "Note: shard the purge queue by tenant id" }, reason: "tenants are uneven" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).description).toBe("shard the purge queue by tenant id");
  });
});

describe("#680 slice 4 — page rule-outs stay project-local", () => {
  it("is never mirrored into the cross-project ledger, even when the project publishes; it still gates here", async () => {
    const id = await presentPage();
    store.setGlobalLedgerPublish(true);
    // Control: an ordinary rejection in this opted-in project DOES publish, so
    // the empty result below is the rule working, not a dead mirror.
    store.recordRejectedApproach({ description: "redis for caching", reason: "control" });
    expect((await ruleOut(id, { htmlAnchor: cellAnchor, reason: "private reason" })).status).toBe(200);

    const ledger = getGlobalStore().query({ limit: 100 }).map((e) => e.concept.toLowerCase());
    expect(ledger).toContain("redis for caching");
    expect(ledger.some((c) => c.includes("60s"))).toBe(false);
    const row = store.getSessionMemory().rejectedApproaches.find((r) => r.description === "Up to 60s");
    expect(row).toMatchObject({ origin: "page_rule_out", sourceArtifactId: id });

    // A later unrelated write keeps the origin, and retiring it writes no global counter-approval.
    store.recordRejectedApproach({ description: "global singletons", reason: "x" });
    expect(store.getSessionMemory().rejectedApproaches.find((r) => r.description === "Up to 60s")?.origin).toBe("page_rule_out");
    expect(store.overrideRejectedApproach({ description: "Up to 60s" }).retired).toBe(1);
    expect(getGlobalStore().query({ limit: 100 }).some((e) => e.concept.toLowerCase().includes("60s"))).toBe(false);
  });
});

describe("#680 slice 4 — validation", () => {
  it.each([
    ["an empty reason", { htmlAnchor: cellAnchor, reason: "" }],
    ["a whitespace-only reason", { htmlAnchor: cellAnchor, reason: "   \n " }],
    ["no reason", { htmlAnchor: cellAnchor }],
    ["an over-length quote", { htmlAnchor: { ...cellAnchor, quote: "q".repeat(281) }, reason: "x" }],
    ["a malformed anchor", { htmlAnchor: { kind: "region", locator: "#a", quote: "a" }, reason: "x" }],
    ["an over-length reason", { htmlAnchor: cellAnchor, reason: "r".repeat(2001) }],
  ])("refuses %s with 400 and records nothing", async (_label, body) => {
    const id = await presentPage();
    const res = await ruleOut(id, body);
    expect(res.status).toBe(400);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
    expect(store.getCommentsForArtifact(id)).toHaveLength(0);
  });

  it("refuses an unknown artifact (404) and a non-page artifact (400)", async () => {
    await presentPage();
    expect((await ruleOut("art_nope", { htmlAnchor: cellAnchor, reason: "x" })).status).toBe(404);
    store.createArtifact({ id: "plan_1", type: "plan", title: "Wire it", content: { steps: [] } });
    expect((await ruleOut("plan_1", { htmlAnchor: cellAnchor, reason: "x" })).status).toBe(400);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
  });

  it.each([
    ["no_text", { kind: "element" as const, locator: "img", quote: "" }],
    ["too_short", { kind: "element" as const, locator: "td", quote: "None" }],
    ["too_short", { kind: "text" as const, locator: "p", quote: "60s" }],
    // A selection spanning two blocks: the gate reads one block at a time, so it would never fire.
    ["not_on_page", { kind: "text" as const, locator: "div", quote: "Red apples ripen. Green pears soften. Blue plums dry." }],
    // Overlaps the page's own title: it would refuse every revision of this page.
    // Only common words: it would block ordinary prose.
    ["too_generic", { kind: "text" as const, locator: "p", quote: "of the" }],
  ])("refuses an anchor the gate couldn't enforce sensibly (%s)", async (why, htmlAnchor) => {
    const id = await presentPage(PAGE_HTML + "<p>Most of the handlers</p>");
    const res = await ruleOut(id, { htmlAnchor, reason: "x" });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json).toMatchObject({ code: "rule_out_not_gateable", reason: why });
    // no_text / too_short / too_generic carry the exact message the companion shows before submit.
    if (why === "no_text" || why === "too_short" || why === "too_generic") expect(json.error).toBe(PAGE_RULE_OUT_MESSAGES[why]);
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
  });

  it("refuses a page version that is no longer under review (409)", async () => {
    const id = await presentPage();
    store.updateArtifactStatus(id, "superseded");
    const res = await ruleOut(id, { htmlAnchor: cellAnchor, reason: "x" });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("rule_out_page_closed");
    expect(store.getSessionMemory().rejectedApproaches).toHaveLength(0);
  });

  it("the public comment route can't forge the ruleOut marker, nor can a writer claim a stance that doesn't exist", async () => {
    const id = await presentPage();
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactId: id, content: "fake", target: { artifactId: id, htmlAnchor: cellAnchor }, ruleOut: { description: "Up to 60s" } }),
    });
    expect(res.status).toBe(200);
    // Store-level backstop: a marker naming no recorded stance is dropped.
    const direct = store.addComment({ id: "cmt_forged", artifactId: id, content: "forged", author: "human", target: { artifactId: id, htmlAnchor: cellAnchor }, ruleOut: { description: "Up to 60s" } });
    expect(direct.ruleOut).toBeUndefined();
    // …nor one naming a stance that isn't THIS page's rule-out.
    store.recordRejectedApproach({ description: "Up to 60s", reason: "elsewhere" });
    const notOurs = store.addComment({ id: "cmt_not_ours", artifactId: id, content: "x", author: "human", target: { artifactId: id, htmlAnchor: cellAnchor }, ruleOut: { description: "Up to 60s" } });
    expect(notOurs.ruleOut).toBeUndefined();
    expect(store.getCommentsForArtifact(id).every((c) => c.ruleOut === undefined)).toBe(true);
  });
});

describe("#680 slice 4 — the existing gate enforces it", () => {
  it("present_page refuses a page containing the ruled-out text, citing the reason; a page without it passes", async () => {
    const id = await presentPage();
    expect((await ruleOut(id, { htmlAnchor: cellAnchor, reason: "sixty seconds of stale sessions" })).status).toBe(200);

    const blocked = await callTool("present_page", {
      title: "Cache, take two",
      html: "<h2>Options</h2><ul><li>TTL expiry, up to 60s stale</li></ul>",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(blocked.text).toContain("sixty seconds of stale sessions");

    const fine = await callTool("present_page", { title: "Cache, take three", html: "<p>TTL expiry, up to 5s stale</p>" });
    expect(fine.isError, fine.text).toBeFalsy();
  });

  it("revise_artifact refuses a revision that keeps the text; one that drops it goes through", async () => {
    const id = await presentPage();
    await ruleOut(id, { htmlAnchor: cellAnchor, reason: "too stale" });
    const keep = await callTool("revise_artifact", { artifactId: id, mode: "supersede", reason: "tweak", content: { html: PAGE_HTML.replace("<h1>", "<h1>Revised ") } });
    expect(keep.isError).toBe(true);
    expect(keep.text).toContain("too stale");
    const drop = await callTool("revise_artifact", { artifactId: id, mode: "supersede", reason: "dropped the 60s option", content: { html: PAGE_HTML.replace("Up to 60s", "Up to 5s") } });
    expect(drop.isError, drop.text).toBeFalsy();
  });
});

describe("#680 slice 4 — a rule-out reaches only pages that still contain the phrase", () => {
  const PHRASE_SPOT = { kind: "text" as const, locator: "p:nth-of-type(3)", quote: LONG_SENTENCE };
  const OPTION = (title: string, description: string) => ({ id: title.toLowerCase().replace(/\W+/g, "-"), title, description, pros: [], cons: [], effort: "low", risk: "low", recommendation: false });
  let phrase: string;
  beforeEach(async () => {
    const id = await presentPage();
    const res = await ruleOut(id, { htmlAnchor: PHRASE_SPOT, reason: "one queue is enough" });
    expect(res.status).toBe(200);
    phrase = (await res.json() as any).description;
    expect(phrase).toContain("write-through purge queue");
  });

  it("an option titled with a fragment of the phrase is allowed (no reverse lane)", async () => {
    const res = await callTool("present_options", {
      title: "Invalidation",
      context: "How should invalidation work?",
      options: [OPTION("Purge queue", "a queue of purge messages"), OPTION("TTL only", "let entries expire")],
    });
    expect(res.isError, res.text).toBeFalsy();
  });

  it("a page TITLED with a fragment, with an unrelated body, is allowed", async () => {
    const res = await callTool("present_page", { title: "Stale session", summary: "every node", html: "<p>Sessions expire after an hour.</p>" });
    expect(res.isError, res.text).toBeFalsy();
  });

  it("a page whose BODY contains the phrase is refused, with the reason", async () => {
    const res = await callTool("present_page", { title: "Another take", html: `<section><p>${phrase} and more.</p></section>` });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("REJECTED_APPROACH_BLOCKED");
    expect(res.text).toContain("one queue is enough");
  });

  it("a non-page artifact containing the whole phrase is allowed (the stance is page text, not a named approach)", async () => {
    const res = await callTool("present_findings", {
      title: "Cache review",
      summary: `Today: ${phrase}.`,
      findings: [{ category: "design", title: phrase, detail: "seen in prod", significance: "low" }],
    });
    expect(res.isError, res.text).toBeFalsy();
  });

  it("the matcher skips it for raw edits (the PreToolUse hook) and the hook's reader keeps the origin", () => {
    const row = store.getSessionMemory().rejectedApproaches.find((r) => r.description === phrase)!;
    expect(findRejectedApproachMatch([`const note = "${phrase}";`], [row], { rawEditText: true })).toBeNull();
    const entries = readRejectedApproachEntries(ctx.tmpDir);
    expect(entries.find((e) => e.entry.description === phrase)?.entry.origin).toBe("page_rule_out");
  });
});

describe("#680 slice 4 — a later ordinary stance on the same phrase widens the row", () => {
  const PHRASE = "Redis Streams queue";
  const OPT = (id: string, title: string) => ({ id, title, description: `use ${title}`, pros: [], cons: [], effort: "low", risk: "low", recommendation: false });
  const presentOptionNaming = () =>
    callTool("present_options", { title: "Job runner", context: "Which job runner?", options: [OPT("x", PHRASE), OPT("y", "Plain cron")] });
  const row = () => store.getSessionMemory().rejectedApproaches.find((r) => r.description === PHRASE);
  let pageId: string;
  beforeEach(async () => {
    pageId = await presentPage(`<h1>Jobs</h1><p>${PHRASE}</p><p>Plain cron</p>`);
    const res = await ruleOut(pageId, { htmlAnchor: { kind: "element", locator: "p", quote: PHRASE }, reason: "streams were flaky" });
    expect(res.status).toBe(200);
    expect(row()?.origin).toBe("page_rule_out");
    // Page-scoped: an option naming the phrase is NOT refused yet.
    const before = await presentOptionNaming();
    expect(before.isError, before.text).toBeFalsy();
  });

  it("artifact reject: rejecting an artifact titled with the phrase drops the origin; an option naming it is refused", async () => {
    store.createArtifact({ id: "plan_rs", type: "plan", title: PHRASE, content: { steps: [] } });
    const res = await app.request("/api/artifacts/plan_rs/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "rejected", feedback: "no streams" }),
    });
    expect(res.status).toBe(200);
    expect(row()).toBeDefined();
    expect(row()!.origin).toBeUndefined();
    expect(row()!.reason).toBe("streams were flaky"); // the first reason is kept
    const after = await presentOptionNaming();
    expect(after.isError).toBe(true);
    expect(after.text).toContain("REJECTED_APPROACH_BLOCKED");
  });

  it("stance add: returns `widened` (not `exists`), says so, drops the origin; an option naming it is refused", async () => {
    const outcome = await recordStance(store, { what: PHRASE, why: "we tried it", addedVia: "cli", requestedBy: "user" });
    expect(outcome.status).toBe("widened");
    const text = formatRecordStanceOutcome(outcome, "This project").text;
    expect(text).toMatch(/now an ordinary stance/);
    expect(text).not.toMatch(/Nothing changed/);
    expect(row()!.origin).toBeUndefined();
    const after = await presentOptionNaming();
    expect(after.isError).toBe(true);
    expect(after.text).toContain("REJECTED_APPROACH_BLOCKED");
  });

  it("stance add on a widened page phrase publishes like any stance when the project opts in", async () => {
    store.setGlobalLedgerPublish(true);
    await recordStance(store, { what: PHRASE, why: "we tried it", addedVia: "cli", requestedBy: "user" });
    expect(getGlobalStore().query({ limit: 100 }).map((e) => e.concept.toLowerCase())).toContain(PHRASE.toLowerCase());
  });

  it("never-suggest: the option's own row (\"<label>: <title>\") gates options naming it; the page row keeps its scope", async () => {
    // never-suggest keys "<label>: <title>", which never equals a rule-out
    // phrase (those have no colon), so it adds its own ordinary row rather
    // than deduping onto the page row — and that row is what gates.
    await callTool("present_options", { title: "Queue", context: "Which queue?", options: [OPT("a", "SQS"), OPT("b", PHRASE)] });
    const dec = store.getArtifacts().find((a) => a.type === "decision" && a.title === "Queue")!;
    const decisionId = (dec.content as { decisionId: string }).decisionId;
    await app.request(`/api/decisions/${decisionId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: "a" }) });
    const ns = await app.request(`/api/decisions/${decisionId}/options/b/never-suggest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "no streams" }) });
    expect(ns.status).toBe(200);
    expect(store.getSessionMemory().rejectedApproaches.find((r) => r.description === `Queue: ${PHRASE}`)?.origin).toBeUndefined();
    const after = await presentOptionNaming();
    expect(after.isError).toBe(true);
    expect(after.text).toContain("REJECTED_APPROACH_BLOCKED");
  });

  it("any ordinary write that dedupes onto the page row (e.g. the send-back's concept key) widens it", () => {
    store.recordRejectedApproach({ description: PHRASE, reason: "none of these", concept: PHRASE, sourceArtifactId: "dec_x" });
    expect(row()!.origin).toBeUndefined();
    // …but a repeat page rule-out never re-narrows an ordinary row.
    store.recordRejectedApproach({ description: PHRASE, reason: "x", sourceArtifactId: pageId, origin: "page_rule_out" });
    expect(row()!.origin).toBeUndefined();
  });
});

describe("#680 slice 4 — check_feedback surfaces it in the page comment lane", () => {
  it("delivers the rule-out comment with its anchor, reason and the recorded stance phrase", async () => {
    const id = await presentPage();
    await ruleOut(id, { htmlAnchor: cellAnchor, reason: "sixty seconds of stale sessions" });
    const res = await callTool("check_feedback");
    expect(res.text).toContain("🚫");
    expect(res.text).toContain("sixty seconds of stale sessions");
    expect(res.text).toContain('RULED OUT: recorded as a rejected stance ("Up to 60s")');
    expect(res.text).toContain('on page cell "Up to 60s"');
    const c = (res.structuredContent as any).comments.find((x: any) => x.ruleOut);
    expect(c).toMatchObject({ artifactId: id, content: "sixty seconds of stale sessions", ruleOut: { description: "Up to 60s" }, htmlAnchor: cellAnchor });
    // A plain page comment carries no ruleOut key.
    await store.addComment({ id: "cmt_plain", artifactId: id, content: "plain", author: "human", target: { artifactId: id, htmlAnchor: cellAnchor } });
    const res2 = await callTool("check_feedback");
    const plain = (res2.structuredContent as any).comments.find((x: any) => x.id === "cmt_plain");
    expect(plain).toBeDefined();
    expect("ruleOut" in plain).toBe(false);
  });
});
