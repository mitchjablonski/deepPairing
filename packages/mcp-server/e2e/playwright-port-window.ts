const E2E_PORT_FLOOR = 33_000;
const MAX_PORT = 65_535;
const MAX_BASE = 65_000;
const DEFAULT_SPAN = 128;

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function usableSpan(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return DEFAULT_SPAN;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 4096 ? parsed : DEFAULT_SPAN;
}

/**
 * Give one Playwright invocation a stable, best-effort-isolated daemon window.
 * Explicit caller values always win. The daemon's bind retry remains the final
 * authority if two independently-derived windows happen to collide.
 */
export function playwrightPortEnv(
  env: NodeJS.ProcessEnv,
  pid: number,
): Pick<NodeJS.ProcessEnv, "DEEPPAIRING_PORT_BASE" | "DEEPPAIRING_PORT_SPAN"> {
  const span = usableSpan(env.DEEPPAIRING_PORT_SPAN);
  // resolvePortWindow accepts bases only through 65000, even when a smaller
  // span would fit above it. An invalid base would silently use normal ports.
  const lastBase = Math.min(MAX_BASE, MAX_PORT - span + 1);
  const windowCount = Math.floor((lastBase - E2E_PORT_FLOOR) / span) + 1;
  const identity = [env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, pid].filter(Boolean).join(":");
  const derivedBase = E2E_PORT_FLOOR + (hash(identity) % windowCount) * span;

  return {
    DEEPPAIRING_PORT_BASE: env.DEEPPAIRING_PORT_BASE ?? String(derivedBase),
    DEEPPAIRING_PORT_SPAN: env.DEEPPAIRING_PORT_SPAN ?? String(DEFAULT_SPAN),
  };
}
