import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DaemonClient } from "../src/daemon/client.js";
import { daemonAuthHeaders, evictDaemon, probeDaemonIdentity, readDaemonInfo, waitForPortRelease } from "../src/daemon/lifecycle.js";
import { expect, test } from "./test.js";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
type SessionReceipt = { sessionId: string; companionUrl: string };

async function stopProjectDaemon(projectRoot: string): Promise<void> {
  const info = readDaemonInfo(projectRoot);
  if (!info) return;
  const identity = await probeDaemonIdentity(info.port);
  if (identity) {
    expect(identity).toMatchObject({ pid: info.pid, projectRoot });
    expect(await evictDaemon(info.port, info.pid)).toBe("evicted");
  }
  await waitForPortRelease(info.port, info.pid, { expectedProjectRoot: projectRoot });
}

test("standalone CLI resumes the exact session and reads browser feedback without consuming it", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dp-cli-review-")));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  await Promise.all([home, project, otherProject].map((dir) => fs.mkdir(dir)));
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    bin: { deeppairing: string };
  };
  const entry = path.resolve(packageRoot, manifest.bin.deeppairing);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, DEEPPAIRING_NO_OPEN: "1", CLAUDE_CONFIG_DIR: home,
  };
  delete env.NODE_OPTIONS;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DEEPPAIRING_PING;
  delete env.DEEPPAIRING_PING_URL;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.XDG_STATE_HOME;
  delete env.XDG_CACHE_HOME;
  const run = (projectRoot: string, ...args: string[]) =>
    exec(process.execPath, [entry, ...args], {
      cwd: projectRoot,
      env: { ...env, DEEPPAIRING_PROJECT_ROOT: projectRoot },
      timeout: 25_000,
    });
  const receipt = async (...args: string[]): Promise<SessionReceipt> =>
    JSON.parse((await run(project, ...args)).stdout);
  const sessionDirs = path.join(project, ".deeppairing", "sessions");

  try {
    const opened = await receipt("open");
    const url = new URL(opened.companionUrl);
    expect(url.searchParams.get("session")).toBe(opened.sessionId);
    expect(await fs.readdir(sessionDirs)).toEqual([opened.sessionId]);
    expect(await fs.readdir(project)).not.toContain(".mcp.json");

    await stopProjectDaemon(project);
    const resumed = await receipt("resume", opened.sessionId);
    expect(resumed.sessionId).toBe(opened.sessionId);
    expect(await fs.readdir(sessionDirs)).toEqual([opened.sessionId]);
    const second = await receipt("open");
    expect(second.sessionId).not.toBe(opened.sessionId);
    await expect(run(otherProject, "resume", opened.sessionId)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await fs.readdir(otherProject)).toEqual([]);
    await expect(run(project, "resume", "../other")).rejects.toMatchObject({ code: 1, stdout: "" });
    const unknown = opened.sessionId.slice(0, -36) + randomUUID();
    await expect(run(project, "resume", unknown)).rejects.toMatchObject({ code: 1, stdout: "" });
    const legacy = "session_project_legacy";
    await fs.mkdir(path.join(sessionDirs, legacy));
    await expect(run(project, "resume", legacy)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect((await fs.readdir(sessionDirs)).sort()).toEqual([opened.sessionId, second.sessionId, legacy].sort());

    const info = readDaemonInfo(project);
    if (!info?.authToken) throw new Error("Test daemon did not publish its authentication token");
    const sibling = new DaemonClient(info.port, resumed.sessionId, project, info.authToken);
    const readCatalog = async (companionUrl = resumed.companionUrl) => {
      const response = await fetch(new URL("/api/active-sessions", companionUrl), {
        headers: daemonAuthHeaders(project), signal: AbortSignal.timeout(5_000),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    await sibling.register({ expectedProjectRoot: project, project: "Example project" });
    try {
      await sibling.renameSession("Renamed review");
      const concurrent = await Promise.all([receipt("resume", resumed.sessionId), receipt("resume", resumed.sessionId)]);
      expect(concurrent).toEqual([resumed, resumed]);
      expect(await readCatalog()).toMatchObject({
        sessions: expect.arrayContaining([expect.objectContaining({
          sessionId: resumed.sessionId, live: true, title: "Renamed review", project: "Example project", artifactCount: 0,
        })]),
      });
    } finally {
      await sibling.unregister();
    }
    expect(await readCatalog()).toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId: resumed.sessionId, live: false })]),
    });

    const inputFile = path.join(root, "options.json");
    const input = {
      title: "Choose a replay backend",
      context: "Choose the storage backend for event replay.",
      options: [
        { id: "redis", title: "Redis Streams", description: "Use Redis Streams", concept: { name: "Redis Streams" },
          pros: [], cons: [], effort: "medium", risk: "medium" },
        { id: "local", title: "Local file", description: "Keep a local replay file",
          pros: [], cons: [], effort: "low", risk: "low" },
      ],
    };
    await fs.writeFile(inputFile, JSON.stringify(input));
    const runPresent = (requestId: string) => run(project, "present", "options",
      "--session-id", resumed.sessionId, "--request-id", requestId, "--file", inputFile);
    const readRefusal = async (requestId: string) => {
      const result = await runPresent(requestId).catch((error: { code: number; stdout: string; stderr: string }) => error);
      expect(result).toMatchObject({ code: 1, stderr: "" });
      return JSON.parse(result.stdout);
    };
    const requestId = randomUUID();
    const presented = JSON.parse((await runPresent(requestId)).stdout);
    expect(presented).toMatchObject({
      sessionId: resumed.sessionId, requestId, companionUrl: resumed.companionUrl,
      artifactId: expect.stringMatching(/^art_/), decisionId: expect.stringMatching(/^dec_/),
    });
    expect(JSON.parse((await runPresent(requestId)).stdout)).toEqual({ ...presented, replayed: true });

    const runRead = (sessionId: string, ...flags: string[]) => run(project, "read-decision",
      "--session-id", sessionId, "--decision-id", presented.decisionId, ...flags);
    const readDecision = async (...flags: string[]) => JSON.parse((await runRead(resumed.sessionId, ...flags)).stdout);
    const draft = {
      sessionId: resumed.sessionId,
      decisionId: presented.decisionId,
      artifactId: presented.artifactId,
      context: input.context,
      artifactStatus: "draft",
      recordedRejections: [],
    };
    expect(await readDecision()).toEqual(draft);
    expect(await readDecision("--wait-ms", "25")).toEqual({ ...draft, waitStatus: "timed_out" });
    await expect(runRead(resumed.sessionId, "--wait-ms", "30001")).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("--wait-ms must be a whole number from 1 to 30000."),
    });
    await expect(runRead(second.sessionId, "--wait-ms", "10000")).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("Decision does not exist in this standalone session."),
    });

    await page.goto(resumed.companionUrl);
    const pane = page.locator(`[data-artifact-id="${presented.artifactId}"]`);
    const [choice] = await Promise.all([
      readDecision("--wait-ms", "10000"),
      pane.getByRole("button", { name: "Select Local file", exact: true }).click(),
    ]);
    expect(choice).toEqual({
      ...draft, artifactStatus: "approved", waitStatus: "resolved", selectedOptionId: "local", selectedTitle: "Local file",
    });
    await expect(pane.getByText("Decision Made", { exact: true })).toBeVisible();
    await pane.getByRole("button", { name: "Never suggest Redis Streams", exact: true }).click();
    const reason = "No operators for this dependency.";
    const rejection = pane.getByRole("group", { name: "Never suggest Redis Streams" });
    await rejection.getByRole("textbox").fill(reason);
    await rejection.getByRole("button", { name: "Remember as rejected", exact: true }).click();
    await expect(rejection).toHaveCount(0);

    const commentId = "cmt_passive_decision_read";
    await sibling.addComment({ id: commentId, artifactId: presented.artifactId, author: "human", content: "Please document the replay procedure." });
    const pendingDecisions = await sibling.getResolvedDecisions();
    const pendingComments = await sibling.getUnacknowledgedComments();
    const approvedPatterns = (await sibling.getSessionMemory()).approvedPatterns;
    expect(pendingDecisions.map((d) => d.decisionId)).toEqual([presented.decisionId]);
    expect(pendingComments.map((comment) => comment.id)).toContain(commentId);

    const result = await readDecision();
    expect(result).toEqual({
      sessionId: resumed.sessionId,
      decisionId: presented.decisionId,
      artifactId: presented.artifactId,
      context: input.context,
      artifactStatus: "approved",
      selectedOptionId: "local",
      selectedTitle: "Local file",
      recordedRejections: [{ description: "Choose a replay backend: Redis Streams", reason }],
    });
    await sibling.forceFlush();
    // Disconnect the browser before restarting so only CLI commands can load the review.
    await page.goto("about:blank");
    await stopProjectDaemon(project);
    await expect(runRead(resumed.sessionId)).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(`deeppairing resume ${resumed.sessionId}`),
    });
    const restarted = readDaemonInfo(project);
    if (!restarted?.authToken) throw new Error("Restarted test daemon did not publish its authentication token");
    const restartedUrl = `http://localhost:${restarted.port}`;
    expect(await readCatalog(restartedUrl)).toEqual({ sessions: [] });

    const reopened = await receipt("resume", resumed.sessionId);
    expect(reopened.sessionId).toBe(resumed.sessionId);
    expect(await readDecision()).toEqual(result);
    expect(await readDecision()).toEqual(result);
    const resumedClient = new DaemonClient(restarted.port, resumed.sessionId, project, restarted.authToken);
    expect(await resumedClient.getResolvedDecisions()).toEqual(pendingDecisions);
    expect(await resumedClient.getUnacknowledgedComments()).toEqual(pendingComments);
    expect((await resumedClient.getSessionMemory()).approvedPatterns).toEqual(approvedPatterns);

    const deniedId = randomUUID();
    expect(await readRefusal(deniedId)).toMatchObject({
      sessionId: resumed.sessionId, requestId: deniedId, isError: true, code: "rejected_approach_blocked", reason,
      message: expect.stringContaining("Use a new UUID if you change the input."),
    });
    expect(await readCatalog(reopened.companionUrl)).toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId: resumed.sessionId, live: false, artifactCount: 1 })]),
    });

    await fs.writeFile(inputFile, JSON.stringify({ ...input, options: [] }));
    const invalidId = randomUUID();
    const invalid = await readRefusal(invalidId);
    expect(invalid).toMatchObject({
      sessionId: resumed.sessionId, requestId: invalidId, isError: true, code: "INPUT_VALIDATION_FAILED",
      message: expect.stringContaining("Use a new UUID if you change the input."),
    });
    expect(invalid).not.toHaveProperty("reason");

    await fs.writeFile(inputFile, JSON.stringify({
      ...input,
      options: [
        { id: "sqlite", title: "SQLite", description: "Use an embedded database", pros: [], cons: [], effort: "low", risk: "low" },
        input.options[1],
      ],
    }));
    expect(await readRefusal(deniedId)).toMatchObject({
      isError: true, code: "standalone_operation_conflict", message: expect.stringContaining("use a new UUID for changed input."),
    });
    const changedId = randomUUID();
    const changed = JSON.parse((await runPresent(changedId)).stdout);
    expect(changed).toMatchObject({ sessionId: resumed.sessionId, requestId: changedId, artifactId: expect.stringMatching(/^art_/) });
    expect(changed.artifactId).not.toBe(presented.artifactId);
    expect(await readCatalog(reopened.companionUrl)).toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ sessionId: resumed.sessionId, live: false, artifactCount: 2 })]),
    });
    expect(await fs.readdir(project)).not.toContain(".mcp.json");

    await page.goto(reopened.companionUrl);
    await page.locator(`button[data-artifact-item="${changed.artifactId}"]`).click();
    await expect(page.locator(`[data-dp-pane][data-artifact-id="${changed.artifactId}"]:not([inert])`)
      .getByRole("button", { name: "Select SQLite", exact: true })).toBeVisible();

    // #679/#680 — an HTML page from a project file goes through the same
    // daemon route and replays on a retried request ID.
    await fs.mkdir(path.join(project, "review"));
    await fs.writeFile(path.join(project, "review", "page.html"), "<h1>Replay plan</h1><p>Keep a local replay file.</p>");
    const pageId = randomUUID();
    const runPage = () => run(project, "present", "page", "--session-id", resumed.sessionId, "--request-id", pageId,
      "--path", "review/page.html", "--title", "Replay plan page");
    const presentedPage = JSON.parse((await runPage()).stdout);
    expect(presentedPage).toMatchObject({
      sessionId: resumed.sessionId, requestId: pageId, artifactId: expect.stringMatching(/^art_/), sourcePath: "review/page.html",
    });
    expect(JSON.parse((await runPage()).stdout)).toEqual({ ...presentedPage, replayed: true, status: "draft" });

    const runPageRead = (sessionId: string, artifactId: string) => run(project, "read-page-feedback",
      "--session-id", sessionId, "--artifact-id", artifactId);
    const readPage = async (artifactId = presentedPage.artifactId) =>
      JSON.parse((await runPageRead(resumed.sessionId, artifactId)).stdout);
    await receipt("resume", second.sessionId);
    await expect(runPageRead(second.sessionId, presentedPage.artifactId)).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("Page does not exist in this standalone session."),
    });
    await page.locator(`button[data-artifact-item="${presentedPage.artifactId}"]`).click();
    const pagePane = page.locator(`[data-dp-pane][data-artifact-id="${presentedPage.artifactId}"]:not([inert])`);
    const frame = pagePane.getByTestId("page-artifact").frameLocator("iframe");
    const composer = pagePane.getByTestId("page-anchor-composer");
    await frame.getByRole("heading", { name: "Replay plan" }).click();
    const question = "Where is the recovery procedure documented?";
    await composer.getByLabel("Comment on the selected spot").fill(question);
    await composer.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(composer.getByText(question, { exact: true })).toBeVisible();

    const rejectedText = "Keep a local replay file.";
    const rejectedReason = "A replay file can unexpectedly fill the disk.";
    await frame.getByText(rejectedText, { exact: true }).click();
    await composer.getByRole("button", { name: "Rule this out", exact: true }).click();
    const ruleOutPanel = composer.getByTestId("page-rule-out-panel");
    await ruleOutPanel.getByRole("textbox").fill(rejectedReason);
    await ruleOutPanel.getByRole("button", { name: "Rule it out", exact: true }).click();
    await expect(composer.getByTestId("page-rule-out-recorded")).toBeVisible();
    const pageFeedback = await readPage();
    expect(pageFeedback).toEqual({
      sessionId: resumed.sessionId,
      artifact: { id: presentedPage.artifactId, version: 1, status: "draft" },
      omittedComments: 0,
      comments: [
        { id: expect.any(String), parentCommentId: null, intent: "comment", content: rejectedReason,
          htmlAnchor: expect.objectContaining({ kind: "element", locator: expect.any(String), quote: rejectedText, version: 1 }),
          ruleOut: { description: rejectedText } },
        { id: expect.any(String), parentCommentId: null, intent: "question", content: question,
          htmlAnchor: expect.objectContaining({ kind: "element", locator: expect.any(String), quote: "Replay plan", version: 1 }) },
      ],
    });
    expect(await readPage()).toEqual(pageFeedback);

    // Saving the file records v2 through the daemon's watch; a retry of the
    // original call still replays v1 but says where the page went.
    await fs.writeFile(path.join(project, "review", "page.html"), "<h1>Replay plan</h1><p>Stream the events from retained archives.</p>");
    let movedReplay: Record<string, unknown> = {};
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      movedReplay = JSON.parse((await runPage()).stdout);
      if (movedReplay.currentArtifactId) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(movedReplay).toEqual({
      ...presentedPage, replayed: true, status: "superseded",
      currentArtifactId: expect.stringMatching(/^art_/), currentVersion: 2, currentStatus: "draft",
      note: expect.stringMatching(/^replayed; the page has since moved to v2 \(art_/),
    });
    expect(movedReplay.currentArtifactId).not.toBe(presentedPage.artifactId);
    const successor = { id: movedReplay.currentArtifactId as string, version: 2, status: "draft" };
    expect(await readPage()).toEqual({ ...pageFeedback, artifact: { ...pageFeedback.artifact, status: "superseded" }, successor });
    expect(await readPage(successor.id)).toEqual({
      sessionId: resumed.sessionId, artifact: successor, comments: [], omittedComments: 0,
    });

    const inlineFile = path.join(root, "inline-page.html");
    await fs.writeFile(inlineFile, "<h1>Inline page</h1><p>Read the archived events.</p>");
    const inline = JSON.parse((await run(project, "present", "page", "--session-id", resumed.sessionId,
      "--request-id", randomUUID(), "--file", inlineFile, "--title", "Inline page")).stdout);
    await fs.writeFile(inlineFile, "<h1>Inline page</h1><p>Read retained event logs in order.</p>");
    const revisionId = randomUUID();
    const revise = (requestId: string) => run(project, "revise-page", "--session-id", resumed.sessionId,
      "--artifact-id", inline.artifactId, "--request-id", requestId, "--file", inlineFile, "--reason", "Clarify order");
    const revised = JSON.parse((await revise(revisionId)).stdout);
    expect(revised).toMatchObject({
      sessionId: resumed.sessionId, requestId: revisionId, parentArtifactId: inline.artifactId,
      artifactId: expect.stringMatching(/^art_/), version: 2, status: "draft",
    });
    expect(JSON.parse((await revise(revisionId)).stdout)).toEqual({ ...revised, replayed: true });
    expect(await readPage(inline.artifactId)).toMatchObject({
      artifact: { id: inline.artifactId, status: "superseded" },
      successor: { id: revised.artifactId, status: "draft", version: 2 },
    });
    const staleRevision = await revise(randomUUID()).catch((err: { code: number; stdout: string; stderr: string }) => err);
    expect(staleRevision).toMatchObject({ code: 1, stderr: "" });
    expect(JSON.parse(staleRevision.stdout)).toMatchObject({
      isError: true, code: "parent_superseded", currentArtifactId: revised.artifactId, currentVersion: 2,
    });
  } finally {
    await page.close();
    await stopProjectDaemon(project);
    await stopProjectDaemon(otherProject);
    await fs.rm(root, { recursive: true, force: true });
  }
});
