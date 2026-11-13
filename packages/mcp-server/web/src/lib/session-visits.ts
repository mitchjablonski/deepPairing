/** Origin-local artifact visit receipts. No artifact content or event timestamps. */
export const SESSION_VISITS_KEY = "dp-session-visits-v1";
export const SESSION_VISITS_LIMIT = 32;
interface VisitArtifact { id: string; sessionId: string }
interface Receipt { observed: string[]; selected: string | null }
interface DocumentV1 { version: 1; recent: string[]; entries: Record<string, Receipt> }
interface Visit {
  key: string;
  projectRoot: string | null;
  sessionId: string;
  observed: Set<string>;
  unread: Set<string>;
  read: Set<string>;
  selected: string | null;
  firstVisit: boolean;
  visibleCommitted: boolean;
}
export interface VisitPlan {
  token: number;
  visit: Visit;
  reentry: boolean;
  /** undefined permits the legacy selection migration; null is an explicit empty receipt. */
  selection: string | null | undefined;
}
interface Options {
  storage?: () => Storage | null;
  visible?: () => boolean;
  lock?: (work: () => void) => Promise<unknown>;
}
const empty = (): DocumentV1 => ({ version: 1, recent: [], entries: {} });
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function parseDocument(raw: string | null): DocumentV1 | null {
  if (raw === null) return empty();
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
        !("entries" in value) || !value.entries || typeof value.entries !== "object" ||
        !("recent" in value) || !Array.isArray(value.recent)) return null;
    const doc = empty();
    for (const key of value.recent) {
      if (!validId(key)) return null;
      const identity: unknown = JSON.parse(key);
      if (!Array.isArray(identity) || identity.length !== 2 || !identity.every(validId)) return null;
      const entry: unknown = (value.entries as Record<string, unknown>)[key];
      if (!entry || typeof entry !== "object" || !("observed" in entry) || !Array.isArray(entry.observed) ||
          !entry.observed.every(validId) || !("selected" in entry) ||
          (entry.selected !== null && !validId(entry.selected))) return null;
      doc.entries[key] = { observed: [...new Set(entry.observed)], selected: entry.selected };
      if (!doc.recent.includes(key)) doc.recent.push(key);
    }
    return doc;
  } catch { return null; }
}
const browserStorage = (): Storage | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};
const browserVisible = () => typeof document === "undefined" || !document.hidden;

export class SessionVisits {
  private active: Visit | null = null;
  private lifecycleStarted = false;
  private memory = new Map<string, Receipt>();
  private token = 0;
  private lifetime = 0;
  private revisions = new Map<string, number>();
  private dirty = new Set<string>();
  private writes: Promise<unknown>[] = [];
  private readonly storage: () => Storage | null;
  private readonly visible: () => boolean;
  private readonly lock: (work: () => void) => Promise<unknown>;
  constructor(options: Options = {}) {
    this.storage = options.storage ?? browserStorage;
    this.visible = options.visible ?? browserVisible;
    this.lock = options.lock ?? ((work) => typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(SESSION_VISITS_KEY, work) : Promise.resolve());
  }
  /** End an actual bound-session visit; network recovery must not call this. */
  leave(): void { this.active = null; this.lifecycleStarted = true; this.token++; }
  beginBinding(): void { this.lifecycleStarted = true; }
  /** undefined is isolated legacy use; null is a scoped but unaccepted/left binding. */
  selectionBinding(): string | null | undefined {
    return this.active?.sessionId ?? (this.lifecycleStarted ? null : undefined);
  }
  /** Suspend live observation before installing history; exit needs a new live snapshot. */
  suspend(): void { this.leave(); }
  /** Discard one UI lifetime's memory; never delete another binding's durable receipt. */
  resetRuntime(): void { this.leave(); this.lifetime++; this.memory.clear(); this.revisions.clear(); this.dirty.clear(); this.lifecycleStarted = false; }
  async settled(): Promise<void> { await Promise.all(this.writes); }
  matches(sessionId: string | null, projectRoot: string | null): boolean {
    return !!this.active && this.active.sessionId === sessionId &&
      (!projectRoot || !this.active.projectRoot || projectRoot === this.active.projectRoot);
  }

  private read(): DocumentV1 | null {
    try { return parseDocument(this.storage()?.getItem(SESSION_VISITS_KEY) ?? null); } catch { return null; }
  }
  private receipt(key: string): Receipt | undefined {
    // Memory is authoritative for this UI lifetime, including quota/lock failure.
    const local = this.memory.get(key);
    const disk = this.read()?.entries[key];
    if (!local) return disk;
    return { selected: this.dirty.has(key) ? local.selected : (disk ? disk.selected : local.selected),
      observed: [...new Set([...local.observed, ...(disk?.observed ?? [])])] };
  }
  private remember(visit: Visit): void {
    const receipt = { observed: [...visit.observed], selected: visit.selected };
    this.memory.delete(visit.key);
    this.memory.set(visit.key, receipt);
    this.dirty.add(visit.key);
    while (this.memory.size > SESSION_VISITS_LIMIT) {
      const oldest = this.memory.keys().next().value!;
      this.memory.delete(oldest); this.dirty.delete(oldest); this.revisions.delete(oldest);
    }
    if (!visit.projectRoot) return; // default lock adapter does no work when locking is unavailable
    const lifetime = this.lifetime;
    const revision = (this.revisions.get(visit.key) ?? 0) + 1;
    this.revisions.set(visit.key, revision);
    const key = visit.key;
    let work: Promise<unknown>;
    try { work = this.lock(() => {
      if (lifetime !== this.lifetime || revision !== this.revisions.get(key)) return;
      try {
        const storage = this.storage();
        if (!storage) return;
        const doc = parseDocument(storage.getItem(SESSION_VISITS_KEY));
        if (!doc) return; // never overwrite corrupt or future-version data
        doc.entries[key] = {
          selected: receipt.selected,
          observed: [...new Set([...(doc.entries[key]?.observed ?? []), ...receipt.observed])],
        };
        doc.recent = [key, ...doc.recent.filter((id) => id !== key)].slice(0, SESSION_VISITS_LIMIT);
        for (const id of Object.keys(doc.entries)) if (!doc.recent.includes(id)) delete doc.entries[id];
        storage.setItem(SESSION_VISITS_KEY, JSON.stringify(doc));
        this.dirty.delete(key);
      } catch { /* quota/private mode: retain coherent in-memory receipt */ }
    }).catch(() => {}); } catch { return; }
    this.writes.push(work);
    void work.finally(() => { this.writes = this.writes.filter((pending) => pending !== work); });
  }

  /** Read-only plan. A failed/stale snapshot cannot consume entry intent or acknowledge IDs. */
  plan(input: { projectRoot: string | null; sessionId: string; currentSelection: string | null; reentry?: boolean }): VisitPlan {
    const old = this.active;
    // Missing/enriched identity in an otherwise identical live binding is not navigation.
    const projectRoot = input.projectRoot ?? (old?.sessionId === input.sessionId ? old.projectRoot : null);
    const enriched = old?.sessionId === input.sessionId && old.projectRoot === null && projectRoot !== null;
    const key = JSON.stringify([projectRoot, input.sessionId]);
    const reentry = !!input.reentry || !old || (old.key !== key && !enriched);
    const receipt = this.receipt(key);
    const visit: Visit = reentry ? {
      key, projectRoot, sessionId: input.sessionId,
      observed: new Set(receipt?.observed ?? []), unread: new Set(), read: new Set(),
      selected: receipt?.selected ?? null, firstVisit: !receipt, visibleCommitted: false,
    } : { ...old!, key, projectRoot, observed: new Set(old!.observed), unread: new Set(old!.unread), read: new Set(old!.read) };
    if (enriched && receipt && !reentry) {
      // Identity discovery is recovery, not pane navigation. Reconcile against
      // the real prior receipt while retaining actual reads in this UI visit.
      visit.observed = new Set(receipt.observed);
      visit.firstVisit = false;
      visit.selected = old!.selected ?? receipt.selected;
    }
    return { token: ++this.token, visit, reentry,
      selection: reentry ? receipt?.selected : input.currentSelection };
  }
  commit(plan: VisitPlan, artifacts: VisitArtifact[], selected: string | null): string[] | null {
    if (plan.token !== this.token) return null;
    this.lifecycleStarted = true;
    this.active = plan.visit;
    return this.observe(artifacts, selected);
  }
  /** Current unread is visit-local; durable observations/other tabs never clear it. */
  observe(artifacts: VisitArtifact[], selected: string | null): string[] | null {
    const visit = this.active;
    if (!visit) return null;
    const ids = artifacts.filter((a) => a.sessionId === visit.sessionId).map((a) => a.id).filter(validId);
    if (!(visit.firstVisit && !visit.visibleCommitted)) {
      for (const id of ids) if (!visit.observed.has(id) && !visit.read.has(id)) visit.unread.add(id);
    }
    // The pane itself never carries an unread badge. Hidden reconciliation is
    // transient only: it does not add a read ID or advance durable observations.
    if (selected && ids.includes(selected)) visit.unread.delete(selected);
    if (this.visible()) {
      // The first eligible visible commit seeds history; hidden loads never do.
      for (const id of ids) visit.observed.add(id);
      if (selected && ids.includes(selected)) { visit.unread.delete(selected); visit.read.add(selected); }
      visit.visibleCommitted = true;
      this.remember(visit);
    }
    return [...visit.unread];
  }
  select(id: string | null, owner: string | undefined): void {
    const visit = this.active;
    if (!visit || (id !== null && owner !== visit.sessionId)) return;
    if (id) visit.unread.delete(id);
    if (!this.visible()) return;
    visit.selected = id;
    if (id) visit.read.add(id);
    this.remember(visit);
  }
  /** Replace only the active binding's badge set, preserving unrelated sibling state. */
  mergeUnread(unread: string[], artifacts: VisitArtifact[], boundUnread: string[]): string[] {
    const sid = this.active?.sessionId;
    if (!sid) return unread;
    const own = new Set(artifacts.filter((a) => a.sessionId === sid).map((a) => a.id));
    return [...new Set([...unread.filter((id) => !own.has(id)), ...boundUnread])];
  }
}
export const sessionVisits = new SessionVisits();
