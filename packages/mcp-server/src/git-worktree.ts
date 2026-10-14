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

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/** Parse `<top>/.git` (a file) as a linked worktree. Null if it is anything else. */
function parseLinkedWorktree(top: string, dotGitFile: string): LinkedWorktree | null {
  try {
    const raw = fs.readFileSync(dotGitFile, "utf8");
    const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(raw);
    if (!m) return null;
    const gitdir = path.resolve(top, m[1]!);
    // A linked worktree's private gitdir carries `commondir`; a submodule's
    // module dir (`.git/modules/<name>`) does not. This is THE discriminator.
    let common: string;
    try {
      common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
    } catch {
      return null;
    }
    if (!common) return null;
    const commonDir = path.resolve(gitdir, common);
    // No main checkout to share with: a bare repository (or a submodule's own
    // worktree, whose common dir is `.git/modules/<name>`).
    if (path.basename(commonDir) !== ".git") return null;
    try {
      const config = fs.readFileSync(path.join(commonDir, "config"), "utf8");
      if (/^[ \t]*bare[ \t]*=[ \t]*true[ \t]*$/im.test(config)) return null;
    } catch {
      return null; // not a usable repository
    }
    const mainTop = path.dirname(commonDir);
    // The main checkout's own `.git` must BE that common dir (a directory).
    const mainDotGit = path.join(mainTop, ".git");
    if (!fs.statSync(mainDotGit).isDirectory() || !sameDir(mainDotGit, commonDir)) return null;
    if (sameDir(mainTop, top)) return null;
    return { worktreeTop: top, mainTop };
  } catch {
    return null;
  }
}

/**
 * The linked worktree enclosing `p` (a directory or a file, existing or not),
 * found by walking up to the nearest `.git` entry. Null when that entry is a
 * directory (a main checkout), isn't a linked worktree, or there is none.
 */
export function findLinkedWorktree(p: string): LinkedWorktree | null {
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
      if (st) return st.isFile() ? parseLinkedWorktree(cur, dotGit) : null;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
    return null;
  } catch {
    return null;
  }
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
export function canonicalProjectDir(dir: string): { projectRoot: string; worktree: LinkedWorktree | null } {
  const abs = path.resolve(dir);
  const mapped = canonicalizeWorktreePath(abs);
  if (!mapped.worktree) return { projectRoot: abs, worktree: null };
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
): { projectRoot: string; workspaceRoot: string; worktree: LinkedWorktree | null } {
  const claude = env.CLAUDE_PROJECT_DIR;
  const explicit = env.DEEPPAIRING_PROJECT_ROOT;
  if (!claude && explicit) return { projectRoot: explicit, workspaceRoot: explicit, worktree: null };
  const raw = claude || (typeof eventCwd === "string" && eventCwd ? eventCwd : "") || cwd();
  try {
    const { projectRoot, worktree } = canonicalProjectDir(raw);
    // Only rewrite when redirected: an unredirected root stays exactly as
    // written (no path.resolve normalisation the old chain didn't do).
    return worktree ? { projectRoot, workspaceRoot: raw, worktree } : { projectRoot: raw, workspaceRoot: raw, worktree: null };
  } catch {
    return { projectRoot: raw, workspaceRoot: raw, worktree: null };
  }
}
