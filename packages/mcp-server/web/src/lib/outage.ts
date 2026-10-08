/** #465 N4 — whole minutes ELAPSED (floor), like every other duration label
 *  ("Agent working · Nm"): 92s of outage is "1 min", not "2 min". The banner
 *  only shows it past 60s, so it is never below 1. */
export function outageMinutes(outageMs: number): number {
  return Math.max(1, Math.floor(outageMs / 60_000));
}
