import fs from "node:fs";
import path from "node:path";

/**
 * #532 — ONE deepPairing project per repository, not per git worktree.
 *
 * `.deeppairing/` is gitignored, and the project root resolves from
 * CLAUDE_PROJECT_DIR / the cwd. So an agent working in a git LINKED WORKTREE
 * (Claude Code `isolation: worktree` subagents, `EnterWorktree`, a user's own
 * `git worktree add`) used to be a different project: its own daemon port
 * (hashed from the root), its own sessions and an EMPTY rejection ledger — and
 * the preflight gate's `ledgersPresent` fast path then passed every proposal
 * the human had already rejected in the main checkout. The gate failed open.
 *
 * The fix canonicalises a linked worktree to its MAIN CHECKOUT, so the ledger,
 * the daemon, the sessions and the preferences are shared by the main checkout
 * and every worktree of it.
 *
 * It reads git's on-disk layout instead of spawning `git rev-parse
 * --git-common-dir`: hooks run on every Edit/Write and are latency-sensitive
 * (a `git` spawn is several ms; this is a handful of stat/read calls). The
 * layout it relies on is git's documented worktree format
 * (gitrepository-layout(5), git-worktree(1)):
 *
 *   <worktree>/.git                  a FILE: `gitdir: <common>/worktrees/<name>`
 *   <common>/worktrees/<name>/commondir   `../..` (relative to that gitdir)
 *
 * What is NOT redirected (returns null, behaviour unchanged):
 *   - a main checkout (`.git` is a directory) and any non-git directory;
 *   - a SUBMODULE: its `.git` file points at `<super>/.git/modules/<name>`,
 *     which has no `commondir` — a submodule is its own repository, not a
 *     worktree of its superproject;
 *   - worktrees of a BARE repository (no main checkout to share with): the
 *     common dir isn't named `.git`, or its config says `bare = true`;
 *   - anything malformed or unreadable (fail to "unchanged", never throw).
 *
 * Node builtins only — this is a leaf, inlined into every hook bundle and
 * imported by guardrail-rules.ts (itself a dependency-light leaf).
 */

export interface LinkedWorktree {
  /** The linked worktree's top-level directory (where its `.git` file is). */
  worktreeTop: string;
  /** The main checkout's top-level directory (the parent of the common `.git`). */
  mainTop: string;
}

function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Why a `.git` FILE that looked like a linked worktree was NOT honoured. Set
 * only for a suspicious shape (garbage, a broken or forged back-pointer, a
 * common dir that isn't a git dir) — never for a submodule or a bare repo,
 * which are legitimately not redirected.
 */
export type WorktreeRejection = string;

interface Inspection {
  worktree: LinkedWorktree | null;
  rejected?: WorktreeRejection;
}

/** Is `dir` a real git common dir (HEAD + objects/ + refs/)? */
function isGitDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "HEAD")).isFile()
      && fs.statSync(path.join(dir, "objects")).isDirectory()
      && fs.statSync(path.join(dir, "refs")).isDirectory();
  } catch {
    return false;
  }
}

/** The `gitdir:` target of a `.git` file, resolved; null if it has none. */
function readGitdirPointer(top: string, dotGitFile: string): string | null {
  const raw = fs.readFileSync(dotGitFile, "utf8");
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(raw);
  return m ? path.resolve(top, m[1]!) : null;
}

/**
 * Parse `<top>/.git` (a file) as a linked worktree.
 *
 * #536 review (P3) — the redirect must not be cheap to forge. A `.git` file is
 * just a file: an agent `Write` of `gitdir: /tmp/crafted/worktrees/x` could
 * otherwise point the project at an empty repo and an empty ledger. So the
 * redirect is honoured only when git's OWN back-reference agrees:
 *   - `<gitdir>/gitdir` names THIS worktree's `.git` file;
 *   - `<gitdir>` sits at `<common>/worktrees/<name>`;
 *   - `<common>` is a real git dir (HEAD, objects/, refs/), named `.git`, not
 *     bare, and it IS the main checkout's `.git` directory.
 * Any mismatch falls back to the un-redirected root (the pre-#532 behaviour)
 * and is reported as `rejected`. Edits to a linked worktree's `.git` file also
 * always ask (guardrail-rules.ts, the `deeppairing-state` class).
 */
function inspectDotGitFile(top: string, dotGitFile: string): Inspection {
  try {
    const gitdir = readGitdirPointer(top, dotGitFile);
    if (!gitdir) return { worktree: null, rejected: `${dotGitFile} has no "gitdir:" line` };
    // A linked worktree's private gitdir carries `commondir`; a submodule's
    // module dir (`.git/modules/<name>`) does not. Not a worktree: no redirect,
    // nothing suspicious.
    let common: string;
    try {
      common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    } catch {
      return { worktree: null };
    }
    if (!common) return { worktree: null, rejected: `${gitdir}/commondir is empty` };
    const commonDir = path.resolve(gitdir, common);
    // No main checkout to share with: a bare repository (or a submodule's own
    // worktree, whose common dir is `.git/modules/<name>`).
    if (path.basename(commonDir) !== ".git") return { worktree: null };
    if (!isGitDir(commonDir)) return { worktree: null, rejected: `${commonDir} is not a git directory` };
    try {
      const config = fs.readFileSync(path.join(commonDir, "config"), "utf8");
      if (/^[ \t]*bare[ \t]*=[ \t]*true[ \t]*$/im.test(config)) return { worktree: null };
    } catch {
      return { worktree: null, rejected: `${commonDir} has no config` };
    }
    // git's own back-reference: <gitdir>/gitdir names this worktree's .git file.
    let back: string;
    try {
      back = fs.readFileSync(path.join(gitdir, "gitdir"), "utf8").trim();
    } catch {
      return { worktree: null, rejected: `${gitdir} has no gitdir back-reference` };
    }
    if (!back || !samePath(path.resolve(gitdir, back), dotGitFile)) {
      return { worktree: null, rejected: `${gitdir}/gitdir does not point back at ${dotGitFile}` };
    }
    if (!samePath(path.dirname(gitdir), path.join(commonDir, "worktrees"))) {
      return { worktree: null, rejected: `${gitdir} is not under ${commonDir}/worktrees` };
    }
    const mainTop = path.dirname(commonDir);
    // The main checkout's own `.git` must BE that common dir (a directory).
    const mainDotGit = path.join(mainTop, ".git");
    if (!fs.statSync(mainDotGit).isDirectory() || !samePath(mainDotGit, commonDir)) {
      return { worktree: null, rejected: `${mainDotGit} is not the common dir ${commonDir}` };
    }
    if (samePath(mainTop, top)) return { worktree: null };
    return { worktree: { worktreeTop: top, mainTop } };
  } catch (err) {
    return { worktree: null, rejected: `${dotGitFile} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Walk up from `p` to the nearest `.git` entry and inspect it. */
function inspect(p: string): Inspection {
  try {
    let cur = path.resolve(p);
    for (let i = 0; i < 256; i++) {
      const dotGit = path.join(cur, ".git");
      let st: fs.Stats | undefined;
      try {
        st = fs.statSync(dotGit);
      } catch {
        st = undefined;
      }
      if (st) return st.isFile() ? inspectDotGitFile(cur, dotGit) : { worktree: null };
      const parent = path.dirname(cur);
      if (parent === cur) return { worktree: null };
      cur = parent;
    }
    return { worktree: null };
  } catch {
    return { worktree: null };
  }
}

/**
 * #536 review (P3) — is `abs` a linked worktree's `.git` FILE (a file with a
 * `gitdir:` line whose target carries `commondir`)? Such a file decides which
 * project — and so which ledger — the worktree uses, so the state guardrail
 * always asks before an agent edits it. A `.git` DIRECTORY, a submodule's
 * `.git` file and a missing file are not matched.
 */
export function isLinkedWorktreeGitFile(abs: string): boolean {
  try {
    if (!fs.lstatSync(abs).isFile()) return false;
    const gitdir = readGitdirPointer(path.dirname(abs), abs);
    return !!gitdir && fs.statSync(path.join(gitdir, "commondir")).isFile();
  } catch {
    return false;
  }
}

/**
 * The linked worktree enclosing `p` (a directory or a file, existing or not),
 * found by walking up to the nearest `.git` entry. Null when that entry is a
 * directory (a main checkout), isn't a linked worktree, or there is none.
 */
export function findLinkedWorktree(p: string): LinkedWorktree | null {
  return inspect(p).worktree;
}

/**
 * Map a path inside a linked worktree to the SAME repo-relative path in the
 * main checkout. Anything not inside a linked worktree is returned unchanged
 * (resolved). Used for paths that must compare equal across worktrees: the
 * checkpoint receipt keys and the guardrail's project-relative match.
 */
export function canonicalizeWorktreePath(p: string): { path: string; worktree: LinkedWorktree | null } {
  const abs = path.resolve(p);
  const worktree = findLinkedWorktree(abs);
  if (!worktree) return { path: abs, worktree: null };
  return mapInto(abs, worktree);
}

function mapInto(abs: string, worktree: LinkedWorktree): { path: string; worktree: LinkedWorktree } {
  const rel = path.relative(worktree.worktreeTop, abs);
  return { path: rel ? path.join(worktree.mainTop, rel) : worktree.mainTop, worktree };
}

/**
 * The deepPairing project root for a directory: the directory itself, unless
 * it is (inside) a linked worktree, in which case the main checkout. A
 * worktree SUBDIRECTORY maps to the same subdirectory of the main checkout
 * when that exists there, else to the main checkout's top (never invent a
 * directory in the main checkout for a branch-only path).
 */
export function canonicalProjectDir(dir: string): { projectRoot: string; worktree: LinkedWorktree | null; rejected?: WorktreeRejection } {
  const abs = path.resolve(dir);
  const found = inspect(abs);
  if (!found.worktree) return found.rejected ? { projectRoot: abs, worktree: null, rejected: found.rejected } : { projectRoot: abs, worktree: null };
  const mapped = mapInto(abs, found.worktree);
  let projectRoot = mapped.path;
  try {
    if (!fs.statSync(projectRoot).isDirectory()) projectRoot = mapped.worktree.mainTop;
  } catch {
    projectRoot = mapped.worktree.mainTop;
  }
  return { projectRoot, worktree: mapped.worktree };
}

/**
 * The hook lanes' project root (R1 #279 precedence, unchanged):
 * CLAUDE_PROJECT_DIR > DEEPPAIRING_PROJECT_ROOT > the event's cwd > cwd.
 *
 * #532 — the winner is canonicalised to the main checkout when it is a linked
 * worktree, EXCEPT an explicit DEEPPAIRING_PROJECT_ROOT, which is taken as
 * written (the escape hatch means exactly what it says).
 *
 * `workspaceRoot` is the un-redirected directory, for callers that need the
 * path the agent is actually working in.
 */
export function resolveHookRoots(
  eventCwd?: unknown,
  env: Record<string, string | undefined> = process.env,
  cwd: () => string = () => process.cwd(),
): { projectRoot: string; workspaceRoot: string; worktree: LinkedWorktree | null; rejected?: WorktreeRejection } {
  const claude = env.CLAUDE_PROJECT_DIR;
  const explicit = env.DEEPPAIRING_PROJECT_ROOT;
  if (!claude && explicit) return { projectRoot: explicit, workspaceRoot: explicit, worktree: null };
  const raw = claude || (typeof eventCwd === "string" && eventCwd ? eventCwd : "") || cwd();
  try {
    const { projectRoot, worktree, rejected } = canonicalProjectDir(raw);
    // Only rewrite when redirected: an unredirected root stays exactly as
    // written (no path.resolve normalisation the old chain didn't do).
    if (worktree) return { projectRoot, workspaceRoot: raw, worktree };
    return rejected ? { projectRoot: raw, workspaceRoot: raw, worktree: null, rejected } : { projectRoot: raw, workspaceRoot: raw, worktree: null };
  } catch {
    return { projectRoot: raw, workspaceRoot: raw, worktree: null };
  }
}
