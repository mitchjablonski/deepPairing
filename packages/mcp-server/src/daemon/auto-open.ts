/**
 * #152 — should the daemon auto-open the companion UI in a browser on first
 * start? Interactive product behavior is WANTED (H4); scripted / CI /
 * agent-driven starts are not (a WSL2 field test launched real Chrome and
 * left crashpad orphans behind).
 *
 * Two suppression paths, both env vars:
 *   - `DEEPPAIRING_NO_OPEN=1` (or "true"/"yes") — the #152 opt-out for
 *     scripted starts. Set this in any harness that spawns a daemon.
 *   - `DEEPPAIRING_OPEN_BROWSER=0` (or "false"/"no") — the pre-existing H4
 *     opt-out (CI, VS Code extension mode); kept for back-compat.
 *
 * This is deliberately an ENV VAR and NOT TTY sniffing: the daemon is always
 * spawned detached with `stdio: ["ignore", "ignore", "pipe"]` (see
 * lifecycle.ts spawnDaemon), so `process.stdout.isTTY` is NEVER true — even
 * for a real interactive user. Sniffing would therefore disable the auto-open
 * for everyone; the env var is the only mechanism that can distinguish a
 * scripted start from a product one.
 *
 * Pure function over an injected env so it's testable without spawning
 * anything (fakes-not-mocks: pass a plain object).
 */
export function shouldAutoOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  const noOpen = (env.DEEPPAIRING_NO_OPEN ?? "").trim().toLowerCase();
  if (noOpen === "1" || noOpen === "true" || noOpen === "yes") return false;
  const openFlag = env.DEEPPAIRING_OPEN_BROWSER;
  return openFlag !== "0" && openFlag !== "false" && openFlag !== "no";
}
