/**
 * D1 — the disk trust boundary. JSON.parse returns `any`; every collection
 * read used to cast it blind, so one garbage element in a hand-edited or
 * corrupted-but-parseable file (a string in artifacts.json, null in
 * decisions.json) crashed whatever downstream code touched it first.
 * salvageArray enforces STRUCTURE (array of objects, each carrying its
 * identity field) and drops+logs anything else. Field-level leniency stays
 * the coercers' job — legacy shapes keep loading.
 */
/** D1 review — once-per-label guard: listSessions/search run per request,
 *  so a persistently corrupted file would otherwise log on every poll. */
const salvageLogged = new Set<string>();

export function salvageLog(label: string, message: string): void {
  if (salvageLogged.has(label)) return;
  salvageLogged.add(label);
  console.error(`[deepPairing] ${label}: ${message}`);
}

export function salvageArray<T>(label: string, raw: unknown, idField: string): T[] {
  if (!Array.isArray(raw)) {
    if (raw != null) salvageLog(label, `expected an array, got ${typeof raw} — using []`);
    return [];
  }
  const kept = raw.filter(
    (el) => el !== null && typeof el === "object" && typeof (el as Record<string, unknown>)[idField] === "string",
  );
  if (kept.length !== raw.length) {
    salvageLog(label, `dropped ${raw.length - kept.length} malformed element(s) (missing string '${idField}')`);
  }
  return kept as T[];
}

/** D1 — Record-shaped files must be plain objects (not arrays/primitives). */
export function salvageRecord<T extends Record<string, unknown>>(label: string, raw: unknown, fallback: T): T {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as T;
  if (raw != null) salvageLog(label, `expected an object, got ${Array.isArray(raw) ? "array" : typeof raw} — using fallback`);
  return fallback;
}
