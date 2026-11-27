import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { isClosedArtifactStatus, readFileWatch, type Artifact, type Comment, type PageFileWatchRecorded, type PageFileWatchRefused } from "@deeppairing/shared";
import { ParentSupersededError, type FileStore } from "../store/file-store.js";
import { readPageSource } from "../mcp/tools/present-page.js";
import { validateRevisePageInput } from "../mcp/validate-tool-input.js";
import { artifactProposal } from "../mcp/artifact-preflight.js";
import { preflightRejectedApproaches, persistPreflightTrace } from "../mcp/tool-helpers.js";
import { relocatePageComments } from "../mcp/page-anchor-relocate.js";

/**
 * #680 slice 3 — the daemon watches the file behind every LIVE file-backed
 * `page` artifact (presented with `path`, so it carries `sourcePath`). When the
 * agent edits that file, the watch records a new version the way
 * revise_artifact(supersede) does: v(N+1) is a fresh draft, vN is superseded,
 * and the human's page comments stay where they are (on their own version) and
 * show on the new version through the companion's whole-chain comment read,
 * re-found there by the annotator. The server re-anchors too, for the agent
 * (page-anchor-relocate.ts): comments whose quoted text is gone are listed as
 * orphaned on the new version's `fileWatch.recorded`, and check_feedback
 * reports that once.
 *
 * Timing. A save starts a quiet timer (QUIET_MS, reset by every further
 * write); when it lapses, the file is read. Versions are at most one per
 * MIN_INTERVAL_MS per artifact: a fire inside that window waits for it to end.
 * So a burst of writes is one version, and a slow trickle at most one per 10s.
 *
 * Reading. The new content goes through present_page's own reader
 * (readPageSource: realpath containment, O_NOFOLLOW|O_NONBLOCK, fstat, cap+1
 * read, realpath recheck), so a file swapped for a symlink out of the project
 * is refused exactly as at present time. A missing file is not an error (an
 * editor's atomic save briefly removes it); the watch waits for it to return.
 *
 * The gate. The new text is checked by the SAME preflight present_page and
 * revise_artifact run (artifactProposal "page" → preflightRejectedApproaches).
 * A match records NOTHING: no version, the live one stays as it was. The block
 * is broadcast (companion toast + project block log, as for any refusal), and
 * the live version gets a `fileWatch.refused` notice with the stored reason,
 * which check_feedback reports to the agent once. It is not offered as a
 * one-time allowance: there is no agent call to admit, and a revise_artifact
 * the agent makes itself goes through the normal allowance path. The refused
 * bytes are remembered by digest, so repeated write events on the same content
 * do not re-block or re-announce.
 *
 * Lifetime. Watching follows the artifact: sync() (called on every
 * artifact-changing broadcast and on session registration) starts a watch for
 * each live file-backed page and stops it once the artifact is approved,
 * rejected, withdrawn, retracted or superseded by a version without the same
 * source. A version the watch itself records keeps the same watch. stopSession
 * (wrapper unregistered) and dispose (daemon exit) close everything.
 */

import { PAGE_WATCH_MIN_INTERVAL_MS, PAGE_WATCH_QUIET_MS } from "../page-watch-timing.js";
export { PAGE_WATCH_MIN_INTERVAL_MS, PAGE_WATCH_QUIET_MS };
export const PAGE_WATCH_POLL_MS = 1_000;

/** The subset of fs.FSWatcher the watch uses (injectable for tests). */
export interface PageDirWatcher {
  close(): void;
  on?(event: "error", cb: (err: unknown) => void): unknown;
}

export interface PageWatchDeps {
  projectRoot: string;
  getStore: (sessionId: string) => FileStore | undefined;
  broadcast: (sessionId: string, event: unknown) => void;
  /** Whether a wrapper or standalone review can own a watch. */
  isSessionLive?: (sessionId: string) => boolean;
  /** Standalone saves acquire a permit before any effects. */
  admitWatchedWrite?: (sessionId: string) => Promise<(() => void) | undefined> | undefined;
  log?: (msg: string) => void;
  /** Directory watcher. Default fs.watch; tests pass a fake they can fire. */
  watch?: (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => PageDirWatcher;
  /** stat poll beside the watcher (fs.watch misses events on some
   *  filesystems, e.g. WSL /mnt/c over 9P). 0 disables it. */
  pollIntervalMs?: number;
  quietMs?: number;
  minIntervalMs?: number;
  /** The rejection gate. Default preflightRejectedApproaches; tests pass a
   *  fake that can hold the check open (stop-during-gate regression). */
  gate?: typeof preflightRejectedApproaches;
  /** The file's change signature for the stat poll. Default: mtime, ctime,
   *  size, inode. Tests pass a coarse fake (a filesystem whose timestamps
   *  don't move) to prove nothing correctness-critical relies on it. */
  statSig?: (absPath: string) => string;
}

interface Entry {
  sessionId: string;
  artifactId: string;
  sourcePath: string;
  absPath: string;
  watcher: PageDirWatcher | null;
  poll: ReturnType<typeof setInterval> | null;
  quiet: ReturnType<typeof setTimeout> | null;
  lastSig: string;
  lastRecordAt: number;
  dirty: boolean;
  /** Bumped on every file event. A read whose generation is no longer
   *  current describes a save that has since been overwritten. */
  gen: number;
  processing: Promise<void> | null;
  stopped: boolean;
}

function statSig(p: string): string {
  try {
    const st = fs.statSync(p);
    // ctime too: a same-size rewrite whose mtime was preserved (or landed in
    // the same coarse mtime tick) still moves ctime, so the poll notices it.
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "missing";
  }
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** present_page's refusal text names the tool and "the artifact"; keep only
 *  the reason, which is what the agent needs here. */
function readerReason(text: string): string {
  const m = /refused — ([\s\S]*?)(?: The artifact was NOT created\.)?$/.exec(text);
  return (m ? m[1]! : text).trim().slice(0, 500);
}

function conceptName(c: unknown): string | undefined {
  if (typeof c === "string" && c.trim()) return c.trim().slice(0, 200);
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    const n = ((c as { name: string }).name).trim();
    return n ? n.slice(0, 200) : undefined;
  }
  return undefined;
}

function isWatchable(a: Artifact): boolean {
  return a.type === "page" && !isClosedArtifactStatus(a.status) && typeof (a.content as { sourcePath?: unknown }).sourcePath === "string";
}

function sourceOf(a: Artifact): string {
  return String((a.content as { sourcePath?: unknown }).sourcePath ?? "");
}

export class PageWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly rootReal: string;
  private readonly quietMs: number;
  private readonly minIntervalMs: number;
  private readonly pollMs: number;
  private disposed = false;

  constructor(private readonly deps: PageWatchDeps) {
    let real = deps.projectRoot;
    try { real = fs.realpathSync(deps.projectRoot); } catch { /* keep the lexical root */ }
    this.rootReal = real;
    this.quietMs = deps.quietMs ?? PAGE_WATCH_QUIET_MS;
    this.minIntervalMs = deps.minIntervalMs ?? PAGE_WATCH_MIN_INTERVAL_MS;
    this.pollMs = deps.pollIntervalMs ?? PAGE_WATCH_POLL_MS;
  }

  private sig(p: string): string {
    return (this.deps.statSig ?? statSig)(p);
  }

  private log(msg: string): void {
    try { this.deps.log?.(`[page-watch] ${msg}`); } catch { /* never */ }
  }

  private key(sessionId: string, artifactId: string): string {
    return `${sessionId}\u0000${artifactId}`;
  }

  /** The artifact ids currently watched in a session (tests, diagnostics). */
  watched(sessionId: string): string[] {
    return [...this.entries.values()].filter((e) => e.sessionId === sessionId).map((e) => e.artifactId);
  }

  /** Resolves once no read/record is in flight for the session's watches. */
  async idle(sessionId?: string): Promise<void> {
    for (;;) {
      const busy = [...this.entries.values()].filter((e) => (!sessionId || e.sessionId === sessionId) && e.processing);
      if (busy.length === 0) return;
      await Promise.all(busy.map((e) => e.processing));
    }
  }

  /** Reconcile the watched set with the session's live file-backed pages. */
  sync(sessionId: string): void {
    if (this.disposed) return;
    const store = this.deps.getStore(sessionId);
    if (!store || (this.deps.isSessionLive && !this.deps.isSessionLive(sessionId))) {
      this.stopSession(sessionId);
      return;
    }
    let artifacts: Artifact[];
    try {
      artifacts = store.getArtifacts();
    } catch (err) {
      // A frozen store (#338) can't be written anyway; leave watches as they are.
      this.log(`sync skipped for ${sessionId}: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    const wanted = artifacts.filter(isWatchable);
    for (const entry of [...this.entries.values()]) {
      if (entry.sessionId !== sessionId) continue;
      const a = byId.get(entry.artifactId);
      if (a && isWatchable(a) && sourceOf(a) === entry.sourcePath) continue;
      // Superseded by a live successor reading the same file (the agent's own
      // revise_artifact): the watch, and its rate-limit window, move to it.
      const next = a?.status === "superseded"
        ? wanted.find((w) => w.parentId === entry.artifactId && sourceOf(w) === entry.sourcePath && !this.entries.has(this.key(sessionId, w.id)))
        : undefined;
      if (next) this.rekey(entry, next.id);
      else this.stop(entry);
    }
    for (const a of wanted) {
      if (!this.entries.has(this.key(sessionId, a.id))) this.start(sessionId, a);
    }
  }

  stopSession(sessionId: string): void {
    for (const e of [...this.entries.values()]) if (e.sessionId === sessionId) this.stop(e);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of [...this.entries.values()]) this.stop(e);
  }

  private rekey(entry: Entry, artifactId: string): void {
    // Review P2-1 — a stopped entry is dead: re-inserting it would make sync()
    // think the new version is watched and skip it forever.
    if (entry.stopped || this.disposed) return;
    this.entries.delete(this.key(entry.sessionId, entry.artifactId));
    entry.artifactId = artifactId;
    this.entries.set(this.key(entry.sessionId, artifactId), entry);
  }

  private start(sessionId: string, a: Artifact): void {
    const sourcePath = sourceOf(a);
    // sourcePath is project-relative to the REAL root (readPageSource); a
    // stored value that is absolute or climbs out is never watched.
    if (!sourcePath || path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes("..")) return;
    const absPath = path.resolve(this.rootReal, sourcePath);
    const entry: Entry = {
      sessionId,
      artifactId: a.id,
      sourcePath,
      absPath,
      watcher: null,
      poll: null,
      quiet: null,
      lastSig: this.sig(absPath),
      lastRecordAt: 0,
      dirty: false,
      gen: 0,
      processing: null,
      stopped: false,
    };
    this.entries.set(this.key(sessionId, a.id), entry);
    const dir = path.dirname(absPath);
    const base = path.basename(absPath);
    try {
      const watchFn = this.deps.watch ?? ((d, l) => fs.watch(d, l));
      // Watch the DIRECTORY: an atomic save (write temp + rename) replaces the
      // file's inode, which a file watch would lose.
      const w = watchFn(dir, (_event, filename) => {
        const name = filename == null ? null : String(filename);
        if (name === null || name === base) this.onChange(entry);
      });
      w.on?.("error", (err) => {
        this.log(`watcher error for ${sourcePath} (${String((err as { code?: string })?.code ?? err)}); the stat poll continues`);
        try { w.close(); } catch { /* gone */ }
        if (entry.watcher === w) entry.watcher = null;
      });
      entry.watcher = w;
    } catch (err) {
      this.log(`could not watch ${sourcePath} (${String((err as { code?: string })?.code ?? err)}); relying on the stat poll`);
    }
    // Review P3-5c — check once on (re)start: a save made while nothing was
    // watching (daemon restart, wrapper re-registration) is picked up too. An
    // unchanged file records nothing.
    entry.dirty = true;
    this.arm(entry, this.quietMs);
    if (this.pollMs > 0) {
      entry.poll = setInterval(() => {
        const sig = this.sig(entry.absPath);
        if (sig === entry.lastSig) return;
        entry.lastSig = sig;
        this.onChange(entry);
      }, this.pollMs);
      entry.poll.unref?.();
    }
  }

  private stop(entry: Entry): void {
    entry.stopped = true;
    if (entry.quiet) { clearTimeout(entry.quiet); entry.quiet = null; }
    if (entry.poll) { clearInterval(entry.poll); entry.poll = null; }
    try { entry.watcher?.close(); } catch { /* gone */ }
    entry.watcher = null;
    const k = this.key(entry.sessionId, entry.artifactId);
    if (this.entries.get(k) === entry) this.entries.delete(k);
  }

  private onChange(entry: Entry): void {
    if (entry.stopped) return;
    entry.lastSig = this.sig(entry.absPath);
    entry.dirty = true;
    entry.gen++;
    // A read in flight reschedules itself when it finishes (dirty).
    if (entry.processing) return;
    this.arm(entry, this.quietMs);
  }

  private arm(entry: Entry, ms: number): void {
    if (entry.quiet) clearTimeout(entry.quiet);
    entry.quiet = setTimeout(() => this.fire(entry), ms);
    entry.quiet.unref?.();
  }

  private fire(entry: Entry): void {
    entry.quiet = null;
    if (entry.stopped) return;
    const wait = entry.lastRecordAt ? entry.lastRecordAt + this.minIntervalMs - Date.now() : 0;
    if (wait > 0) {
      this.arm(entry, wait);
      return;
    }
    entry.dirty = false;
    entry.processing = this.process(entry)
      .catch((err) => this.log(`could not record ${entry.sourcePath}: ${String((err as Error)?.message ?? err)}`))
      .finally(() => {
        entry.processing = null;
        if (entry.dirty && !entry.stopped) this.arm(entry, this.quietMs);
      });
  }

  private async process(entry: Entry): Promise<void> {
    const admission = this.deps.admitWatchedWrite?.(entry.sessionId);
    const release = admission ? await admission : undefined;
    if (admission && !release) return;
    try {
      if (entry.stopped || this.disposed) return;
      await this.processAdmitted(entry);
    } finally {
      release?.();
    }
  }

  private async processAdmitted(entry: Entry): Promise<void> {
    const store = this.deps.getStore(entry.sessionId);
    if (!store) return;
    // Codex review — the snapshot this read is about. A save that lands while
    // an await below is pending (save B during save A's gate check) bumps
    // `gen`: A is then stale, so it records nothing, posts no refusal and
    // does NOT start the rate-limit window. The completion handler re-arms
    // the quiet timer (dirty), so B gets its own 2s quiet read.
    const startGen = entry.gen;
    const stale = () => entry.stopped || this.disposed || entry.gen !== startGen;
    const live = (): Artifact | undefined => {
      const a = store.getArtifacts().find((x) => x.id === entry.artifactId);
      return a && isWatchable(a) && sourceOf(a) === entry.sourcePath ? a : undefined;
    };
    const cur = live();
    if (!cur) {
      this.sync(entry.sessionId);
      return;
    }
    // Missing (deleted, or mid atomic save): nothing to read yet. lstat, so a
    // dangling symlink counts as present and gets the reader's refusal.
    try { fs.lstatSync(entry.absPath); } catch { return; }

    const source = readPageSource(this.rootReal, entry.sourcePath);
    if (!source.ok) {
      const message = readerReason(source.error.content[0]?.text ?? "the file could not be read");
      this.refuse(store, entry, cur, { cause: "unreadable", message, digest: sha256(`unreadable:${message}`) });
      return;
    }
    // Review P3-6 — the path must still BE the watched file: one replaced by a
    // symlink to another file inside the project is not silently recorded as
    // this page.
    if (source.sourcePath !== entry.sourcePath) {
      const message = `${entry.sourcePath} now resolves to a different file (${source.sourcePath}); present that file as its own page if it is meant to be one`;
      this.refuse(store, entry, cur, { cause: "unreadable", message, digest: sha256(`redirect:${source.sourcePath}`) });
      return;
    }
    const html = source.html;
    const curContent = cur.content as Record<string, unknown>;
    if (html === curContent.html) return; // touched, not changed

    const v = validateRevisePageInput({ title: cur.title, summary: curContent.summary, html, concept: curContent.concept });
    if (!v.ok) {
      const message = readerReason(v.error.content[0]?.text ?? "the new page is not valid");
      this.refuse(store, entry, cur, { cause: "unreadable", message, digest: sha256(`invalid:${html}`) });
      return;
    }
    const content: Record<string, unknown> = { ...v.data, sourcePath: entry.sourcePath };
    // Review P3-5b — the refused-content key includes the stances in force, so
    // retiring (or adding) a stance re-admits (or re-checks) identical bytes.
    const digest = sha256(`${html}\u0000${await this.stanceFingerprint(store)}`);
    if (stale()) return;
    if (readFileWatch(cur.fileWatch).refused?.digest === digest) return; // already refused

    // The rejection gate — the same projection present_page and revise use.
    const proposal = artifactProposal("page", cur.title, content)!;
    const bc = (event: unknown) => this.deps.broadcast(entry.sessionId, event);
    const gate = this.deps.gate ?? preflightRejectedApproaches;
    const pre = await gate(store, bc, "page_watch", proposal.text, proposal.paths, proposal.concepts, {
      advisory: proposal.advisory,
      deferRecord: true,
      ...(proposal.rawEditTextFrom !== undefined ? { rawEditTextFrom: proposal.rawEditTextFrom } : {}),
    });

    // Review P2-1 — stopped (resolved, session ended) or disposed while the
    // gate ran: record nothing. Codex review — nor if a newer save landed.
    if (stale()) return;
    // Re-read after the await: the agent may have revised, or the human
    // resolved, the artifact meanwhile.
    const now = live();
    if (!now || now.id !== cur.id || (now.content as Record<string, unknown>).html !== curContent.html) {
      entry.dirty = true;
      return;
    }

    // Codex review (stat-poll path) — the side-effect boundary. Where fs.watch
    // never fires (WSL /mnt/c), a newer save can already be on disk before the
    // next poll tick bumps `gen`. Re-read the file itself (whatever its stat says): if
    // its content is no longer what this read saw, the read is stale. No
    // side effect, no rate-limit window; mark the entry dirty and bump `gen` so
    // the completion handler re-arms the quiet timer for the newer save.
    // Everything from here to the writes is synchronous.
    if (this.overtaken(entry, html)) return;

    if (!pre.ok) {
      const match = pre.event.match ?? {};
      const concept = conceptName(match.concept) ?? (typeof match.description === "string" ? match.description.slice(0, 200) : undefined);
      const reason = typeof match.reason === "string" && match.reason.trim() ? match.reason.trim() : undefined;
      const message = `the new text matches an approach your pair rejected${concept ? ` ("${concept}")` : ""}${reason ? `: ${reason}` : ""}`.slice(0, 2000);
      // The block log + toast, through the daemon's broadcast (which persists
      // it). Not allowance-eligible: there is no agent call to admit.
      bc({ ...pre.event, artifactId: cur.id, sourcePath: entry.sourcePath, eligible: false, ineligibleReason: "file_watch" });
      this.refuse(store, entry, cur, { cause: "gate", message, digest, ...(concept ? { concept } : {}) });
      return;
    }

    await this.record(store, entry, cur, content, pre.trace);
  }

  /** Has the file moved on from the snapshot this read saw? Decided by the
   *  content (and resolved path), never by the stat: an mtime-only touch is
   *  not stale, and a same-stat rewrite is. */
  private overtaken(entry: Entry, html: string): boolean {
    // Always re-read (bounded: pages are capped, and this runs once per
    // recorded version). An equal stat proves nothing: a same-size write in
    // the same coarse mtime tick, or with its mtime restored, looks identical.
    const sig = this.sig(entry.absPath);
    const again = readPageSource(this.rootReal, entry.sourcePath);
    if (again.ok && again.sourcePath === entry.sourcePath && again.html === html) return false;
    entry.lastSig = sig;
    entry.dirty = true;
    entry.gen++;
    return true;
  }

  /** The stances the gate reads, as one hash (session rejections + team rules). */
  private async stanceFingerprint(store: FileStore): Promise<string> {
    try {
      const mem = await store.getSessionMemory();
      const team = (await store.getTeamPreferences?.()) ?? [];
      return sha256(JSON.stringify([mem.rejectedApproaches ?? [], team]));
    } catch {
      return "unknown";
    }
  }

  private refuse(store: FileStore, entry: Entry, cur: Artifact, r: Pick<PageFileWatchRefused, "cause" | "message" | "digest" | "concept">): void {
    entry.lastRecordAt = Date.now();
    const prev = readFileWatch(cur.fileWatch).refused;
    if (prev?.digest === r.digest) return;
    const notice: PageFileWatchRefused = { at: new Date().toISOString(), sourcePath: entry.sourcePath, ...r };
    store.setPageFileWatch(cur.id, "refused", notice);
    this.log(`refused a save of ${entry.sourcePath} for ${cur.id} (${r.cause})`);
    const updated = store.getArtifacts().find((a) => a.id === cur.id);
    if (updated) this.deps.broadcast(entry.sessionId, { type: "artifact_content_updated", artifact: updated });
  }

  private async record(store: FileStore, entry: Entry, cur: Artifact, content: Record<string, unknown>, trace: Parameters<typeof persistPreflightTrace>[4]): Promise<void> {
    if (entry.stopped || this.disposed) return;
    const newId = `art_${nanoid(10)}`;
    let created: Artifact;
    try {
      created = store.createArtifact({
      id: newId,
      // Review P2-2 — the supersede compare-and-swap: a revise_artifact that
      // already versioned this page wins, and the watch records nothing.
      requireUnsupersededParent: true,
      type: "page",
      title: cur.title,
      content,
      agentReasoning: `Recorded automatically from ${entry.sourcePath} after a save.`,
      parentId: cur.id,
      version: cur.version + 1,
      ...(cur.relatedArtifactIds ? { relatedArtifactIds: cur.relatedArtifactIds } : {}),
      ...(cur.featureId ? { feature: cur.featureId } : {}),
      ...(cur.presentedBy ? { presentedBy: cur.presentedBy } : {}),
    });
    } catch (err) {
      if (err instanceof ParentSupersededError) {
        this.log(`skipped ${entry.sourcePath}: ${cur.id} was already replaced${err.successorId ? ` by ${err.successorId}` : ""}`);
        return;
      }
      throw err;
    }
    store.updateArtifactStatus(cur.id, "superseded", "agent_supersede");
    store.addComment({
      id: `cmt_${nanoid(10)}`,
      artifactId: cur.id,
      content: `Superseded by ${newId}: recorded automatically from ${entry.sourcePath} after a save.`,
      author: "agent",
    });

    // Re-anchor every page comment on the chain against the new HTML.
    const all = store.getArtifacts();
    const byId = new Map(all.map((a) => [a.id, a]));
    const chain = new Set<string>();
    for (let a: Artifact | undefined = cur; a && !chain.has(a.id); a = a.parentId ? byId.get(a.parentId) : undefined) chain.add(a.id);
    const comments: Comment[] = store.getComments().filter((c) => chain.has(c.target.artifactId));
    const rel = relocatePageComments(String(content.html), comments);
    const recorded: PageFileWatchRecorded = {
      at: new Date().toISOString(),
      sourcePath: entry.sourcePath,
      fromArtifactId: cur.id,
      fromVersion: cur.version,
      carriedCount: rel.carried.length + rel.unknown.length,
      orphaned: rel.orphaned,
      ...(rel.orphanedOverflow > 0 ? { orphanedOverflow: rel.orphanedOverflow } : {}),
    };
    store.setPageFileWatch(newId, "recorded", recorded);
    // An undelivered refusal on the old version is moot now.
    const prevRefused = readFileWatch(cur.fileWatch).refused;
    if (prevRefused && !prevRefused.delivered) store.setPageFileWatch(cur.id, "refused", { ...prevRefused, delivered: true });

    entry.lastRecordAt = Date.now();
    this.rekey(entry, newId);
    this.log(`recorded ${newId} (v${cur.version + 1}) from ${entry.sourcePath}; ${rel.orphaned.length + rel.orphanedOverflow} comment(s) orphaned`);

    const bc = (event: unknown) => this.deps.broadcast(entry.sessionId, event);
    const traceRecorded = persistPreflightTrace(store, bc, created, "page_watch", trace).catch(() => undefined);
    try {
      const fresh = store.getArtifacts().find((a) => a.id === newId) ?? created;
      bc({ type: "artifact_created", artifact: fresh });
      bc({ type: "artifact_updated", artifactId: cur.id, status: "superseded" });
      const secrets = fresh.secretWarnings ?? [];
      if (secrets.length > 0) {
        bc({ type: "secret_warning", artifactId: newId, patterns: secrets.map((m) => m.pattern), labels: secrets.map((m) => m.label) });
      }
    } finally {
      await traceRecorded;
    }
  }
}
