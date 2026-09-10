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
  if (value === undefined || value.trim() === "") return DEFAULT_SPAN;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4096
    ? parsed : DEFAULT_SPAN;
}

function usableBase(value: string | undefined, span: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) &&
    parsed >= 1024 && parsed <= MAX_BASE && parsed + span - 1 <= MAX_PORT
    ? parsed : undefined;
}

/**
 * Give one Playwright invocation a stable, best-effort-isolated daemon window.
 * A valid explicit base wins; an invalid or overflowing base safely re-derives.
 * Invalid spans normalize to the test default. The daemon's bind retry remains
 * the final authority if independently-derived windows collide.
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
  const base = usableBase(env.DEEPPAIRING_PORT_BASE, span) ?? derivedBase;

  return {
    DEEPPAIRING_PORT_BASE: String(base),
    DEEPPAIRING_PORT_SPAN: String(span),
  };
}
