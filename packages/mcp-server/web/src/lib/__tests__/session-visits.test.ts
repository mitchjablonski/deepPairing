import { describe, it, expect } from "vitest";
import { SessionVisits, SESSION_VISITS_KEY, SESSION_VISITS_LIMIT } from "../session-visits";
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
const art = (id: string, sessionId = "A") => ({ id, sessionId });
const unlocked = async (work: () => void) => work();
const options = (storage: Storage) => ({ storage: () => storage, lock: unlocked });
const enter = (visits: SessionVisits, ids: string[], sessionId = "A", projectRoot: string | null = "/p", selected: string | null = ids[0] ?? null) => {
  const plan = visits.plan({ projectRoot, sessionId, currentSelection: selected });
  return { plan, unread: visits.commit(plan, ids.map((id) => art(id, sessionId)), selected) };
};
const documentOf = (storage: Storage) => JSON.parse(storage.getItem(SESSION_VISITS_KEY)!);

describe("#642 origin-local session visit receipts", () => {
  it("seeds first history, then keeps new arrivals unread despite durable observation/recovery", async () => {
    const storage = new MemoryStorage();
    const visits = new SessionVisits(options(storage));
    expect(enter(visits, ["old", "history"]).unread).toEqual([]);
    expect(visits.observe([art("old"), art("history"), art("late-old-timestamp")], "old")).toEqual(["late-old-timestamp"]);
    await visits.settled();
    expect(documentOf(storage).entries[JSON.stringify(["/p", "A"])].observed).toContain("late-old-timestamp");
    const recovery = visits.plan({ projectRoot: "/p", sessionId: "A", currentSelection: "history" });
    expect(recovery.reentry).toBe(false);
    expect(recovery.selection).toBe("history");
    expect(visits.commit(recovery, [art("old")], "history")).toEqual(["late-old-timestamp"]);
    expect(visits.observe([art("history"), art("late-old-timestamp"), art("old")], "history")).toEqual(["late-old-timestamp"]);
    visits.select("late-old-timestamp", "A");
    expect(visits.observe([art("late-old-timestamp"), art("history"), art("old")], "late-old-timestamp")).toEqual([]);
  });

  it("uses last active observation across A → B → A and isolates identical IDs across projects", async () => {
    const storage = new MemoryStorage();
    const visits = new SessionVisits(options(storage));
    enter(visits, ["same", "seen"]);
    visits.select("seen", "A");
    await visits.settled();
    visits.leave();
    expect(enter(visits, ["same"], "B").unread).toEqual([]);
    visits.leave();
    expect(enter(visits, ["same", "seen", "new"]).unread).toEqual(["new"]);
    visits.leave();
    expect(enter(visits, ["same", "other"], "A", "/another").unread).toEqual([]);
    visits.leave();
    expect(enter(visits, ["same", "seen", "new", "newer"]).unread).toEqual(["newer"]);
  });

  it("reloads committed IDs without unload and does not import sibling observation", async () => {
    const storage = new MemoryStorage();
    const before = new SessionVisits(options(storage));
    enter(before, ["old"]);
    before.observe([art("old"), art("sibling", "B")], "old");
    await before.settled();
    const after = new SessionVisits(options(storage));
    expect(enter(after, ["old", "new"]).unread).toEqual(["new"]);
    after.leave();
    expect(enter(after, ["sibling"], "B").unread).toEqual([]);
  });

  it("freezes hidden observation and resumes without clearing prior unread", async () => {
    const storage = new MemoryStorage();
    let visible = true;
    const visits = new SessionVisits({ ...options(storage), visible: () => visible });
    enter(visits, ["old"]);
    visits.observe([art("old"), art("unread-before-hide")], "old");
    await visits.settled();
    const frozen = storage.getItem(SESSION_VISITS_KEY);
    visible = false;
    expect(visits.observe([art("old"), art("unread-before-hide"), art("hidden")], "old")).toEqual(["unread-before-hide", "hidden"]);
    visits.select("hidden", "A");
    expect(storage.getItem(SESSION_VISITS_KEY)).toBe(frozen);
    visible = true;
    expect(visits.observe([art("hidden"), art("old"), art("unread-before-hide")], "old")).toEqual(["unread-before-hide", "hidden"]);
  });

  it("hides the selected pane badge without acknowledging hidden history", async () => {
    const storage = new MemoryStorage();
    let visible = true;
    const visits = new SessionVisits({ ...options(storage), visible: () => visible });
    enter(visits, ["old"]);
    await visits.settled();
    const frozen = storage.getItem(SESSION_VISITS_KEY);
    visits.leave();
    visible = false;
    expect(enter(visits, ["old", "hidden"], "A", "/p", "hidden").unread).toEqual([]);
    expect(storage.getItem(SESSION_VISITS_KEY)).toBe(frozen);
    // Moving the still-hidden pane does not pretend the previous pane was read.
    expect(visits.observe([art("old"), art("hidden")], "old")).toEqual(["hidden"]);
    visible = true;
    expect(visits.observe([art("old"), art("hidden")], "old")).toEqual(["hidden"]);
  });

  it("does not establish first-visit history during hidden loading", () => {
    const storage = new MemoryStorage();
    let visible = false;
    const visits = new SessionVisits({ ...options(storage), visible: () => visible });
    enter(visits, ["old"]);
    visits.observe([art("old"), art("while-hidden")], "old");
    expect(storage.getItem(SESSION_VISITS_KEY)).toBeNull();
    visible = true;
    expect(visits.observe([art("old"), art("while-hidden")], "old")).toEqual([]);
  });

  it("rejects stale plans and persists only accepted pre-replay observations", async () => {
    const storage = new MemoryStorage();
    const queued: Array<() => void> = [];
    const visits = new SessionVisits({ storage: () => storage, lock: (work) => new Promise<void>((resolve) => queued.push(() => { work(); resolve(); })) });
    const stale = visits.plan({ projectRoot: "/p", sessionId: "A", currentSelection: null });
    visits.leave();
    expect(visits.commit(stale, [art("stale")], "stale")).toBeNull();
    enter(visits, ["accepted"]);
    visits.suspend();
    visits.select("historical", "A");
    expect(visits.observe([art("historical")], "historical")).toBeNull();
    queued.splice(0).forEach((work) => work());
    await visits.settled();
    expect(documentOf(storage).entries[JSON.stringify(["/p", "A"])].observed).toEqual(["accepted"]);
    expect(visits.plan({ projectRoot: "/p", sessionId: "A", currentSelection: null }).reentry).toBe(true);
  });

  it("retains an accepted delayed A receipt after A → B then reload", async () => {
    const storage = new MemoryStorage();
    const queued: Array<() => void> = [];
    const visits = new SessionVisits({ storage: () => storage, lock: (work) => new Promise<void>((resolve) => queued.push(() => { work(); resolve(); })) });
    enter(visits, ["seen-a"]);
    visits.select("seen-a", "A");
    visits.leave();
    enter(visits, ["seen-b"], "B");
    queued.splice(0).forEach((work) => work());
    await visits.settled();
    const reloaded = new SessionVisits(options(storage));
    const result = enter(reloaded, ["seen-a", "new-a"]);
    expect(result.plan.selection).toBe("seen-a");
    expect(result.unread).toEqual(["new-a"]);
  });

  it("serializes multi-tab union while preserving each active tab's unread", async () => {
    const storage = new MemoryStorage();
    const a = new SessionVisits(options(storage));
    const b = new SessionVisits(options(storage));
    enter(a, ["old"]);
    enter(b, ["old"]);
    a.observe([art("old"), art("from-a")], "old");
    b.observe([art("old"), art("from-b")], "old");
    await Promise.all([a.settled(), b.settled()]);
    expect(documentOf(storage).entries[JSON.stringify(["/p", "A"])].observed.sort()).toEqual(["from-a", "from-b", "old"]);
    expect(a.observe([art("old"), art("from-a")], "old")).toEqual(["from-a"]);
  });

  it.each(["corrupt", "future", "quota", "unavailable"])("keeps coherent memory for %s storage", async (mode) => {
    const storage = new MemoryStorage();
    if (mode === "corrupt") storage.setItem(SESSION_VISITS_KEY, "{");
    if (mode === "future") storage.setItem(SESSION_VISITS_KEY, JSON.stringify({ version: 2 }));
    if (mode === "quota") storage.setItem = () => { throw new Error("quota"); };
    const visits = new SessionVisits({ ...options(storage), storage: () => { if (mode === "unavailable") throw new Error("private"); return storage; } });
    enter(visits, ["old"]);
    expect(visits.observe([art("old"), art("new")], "old")).toEqual(["new"]);
    visits.select("new", "A");
    await visits.settled();
    expect(visits.observe([art("new"), art("old")], "new")).toEqual([]);
  });

  it("evicts whole old bindings only, with no truncation of a retained ID set", async () => {
    const storage = new MemoryStorage();
    const visits = new SessionVisits(options(storage));
    for (let i = 0; i < SESSION_VISITS_LIMIT + 1; i++) {
      visits.leave(); enter(visits, ["old", "all-ids-retained"], `session-${i}`);
    }
    await visits.settled();
    const doc = documentOf(storage);
    expect(doc.recent).toHaveLength(SESSION_VISITS_LIMIT);
    expect(doc.entries[JSON.stringify(["/p", "session-0"])]).toBeUndefined();
    expect(doc.entries[JSON.stringify(["/p", `session-${SESSION_VISITS_LIMIT}`])].observed).toEqual(["old", "all-ids-retained"]);
  });

  it.each([false, true])("root enrichment uses known history without preemption (read new=%s)", async (readNew) => {
    const storage = new MemoryStorage();
    const prior = new SessionVisits(options(storage));
    enter(prior, ["old"]);
    prior.select("old", "A");
    await prior.settled();
    const current = new SessionVisits(options(storage));
    enter(current, ["old", "new"], "A", null);
    if (readNew) current.select("new", "A");
    const plan = current.plan({ projectRoot: "/p", sessionId: "A", currentSelection: "old" });
    expect(plan.reentry).toBe(false);
    expect(plan.selection).toBe("old");
    expect(current.commit(plan, [art("old"), art("new")], "old")).toEqual(readNew ? [] : ["new"]);
  });

  it("keeps missing project identity memory-only and root enrichment is recovery", () => {
    const storage = new MemoryStorage();
    const visits = new SessionVisits(options(storage));
    enter(visits, ["old"], "A", null);
    expect(storage.getItem(SESSION_VISITS_KEY)).toBeNull();
    const enriched = visits.plan({ projectRoot: "/p", sessionId: "A", currentSelection: "old" });
    expect(enriched.reentry).toBe(false);
    expect(enriched.selection).toBe("old");
  });
});

describe("#652 bounded receipt recovery", () => {
  const key = (sid: string) => JSON.stringify(["/p", sid]);
  const seed = (storage: Storage, names: string[], recent: unknown = names.map(key)) => {
    storage.setItem(SESSION_VISITS_KEY, JSON.stringify({ version: 1, recent,
      entries: Object.fromEntries(names.map((sid) => [key(sid), { observed: ["old"], selected: "old" }])) }));
  };
  const queuedVisits = (storage: Storage) => {
    const queue: Array<() => void> = [];
    const visits = new SessionVisits({ storage: () => storage,
      lock: (work) => new Promise<void>((resolve) => queue.push(() => { work(); resolve(); })) });
    return { visits, queue };
  };
  it.each([null, {}, ["bad", key("A"), key("A"), key("missing")]])("salvages complete own canonical receipts with malformed ordering %j", async (recent) => {
    const storage = new MemoryStorage();
    seed(storage, ["A", "B"], recent);
    const doc = documentOf(storage);
    doc.entries[key("broken")] = { observed: ["ok", null], selected: null };
    doc.entries['[ "/p", "alias" ]'] = { observed: ["old"], selected: "old" };
    doc.entries["__proto__"] = { observed: ["old"], selected: "old" };
    storage.setItem(SESSION_VISITS_KEY, JSON.stringify(doc));
    const visits = new SessionVisits(options(storage));
    expect(enter(visits, ["old", "new"]).unread).toEqual(["new"]);
    await visits.settled();
    const saved = documentOf(storage);
    expect(Object.keys(saved.entries).sort()).toEqual([key("A"), key("B")]);
    expect(saved.recent).toEqual([key("A"), key("B")]);
  });
  it.each([{ version: 2, entries: {} }, { version: 1, entries: [] }, "{"])("refuses unrecognized envelopes %j", async (value) => {
    const storage = new MemoryStorage();
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    storage.setItem(SESSION_VISITS_KEY, raw);
    const visits = new SessionVisits(options(storage));
    enter(visits, ["old"]);
    await visits.settled();
    expect(storage.getItem(SESSION_VISITS_KEY)).toBe(raw);
  });
  it("rereads after quota, preserves concurrent entries, and keeps more than 2000 exact IDs", async () => {
    const storage = new MemoryStorage();
    seed(storage, ["A", "victim"]);
    const original = storage.setItem.bind(storage);
    let attempts = 0;
    storage.setItem = (k, v) => {
      attempts++;
      if (attempts === 1) {
        const fresh = documentOf(storage);
        fresh.entries[key("concurrent")] = { observed: ["other"], selected: null };
        fresh.recent.unshift(key("concurrent"));
        original(k, JSON.stringify(fresh));
        throw new DOMException("full", "QuotaExceededError");
      }
      original(k, v);
    };
    const visits = new SessionVisits(options(storage));
    const ids = Array.from({ length: 2005 }, (_, i) => `id-${i}`);
    enter(visits, ids);
    await visits.settled();
    expect(attempts).toBe(2);
    const doc = documentOf(storage);
    expect(doc.entries[key("victim")]).toBeUndefined();
    expect(doc.entries[key("concurrent")].observed).toEqual(["other"]);
    expect(doc.entries[key("A")].observed).toEqual(["old", ...ids]);
  });
  it.each(["quota-twice", "security", "no-victim", "future"])("bounds %s failure without evicting cached history", async (mode) => {
    const storage = new MemoryStorage();
    seed(storage, mode === "no-victim" ? ["A"] : ["A", "B"]);
    const { visits, queue } = queuedVisits(storage);
    enter(visits, ["old"], "B");
    queue.shift()!();
    await visits.settled();
    visits.leave();
    const prior = storage.getItem(SESSION_VISITS_KEY);
    const original = storage.setItem.bind(storage);
    let attempts = 0;
    storage.setItem = (k, _v) => {
      attempts++;
      if (mode === "future") original(k, JSON.stringify({ version: 2 }));
      throw new DOMException("full", mode === "security" ? "SecurityError" : "QuotaExceededError");
    };
    // Remove B durably only for the no-victim case; its cached receipt remains.
    if (mode === "no-victim") original(SESSION_VISITS_KEY, JSON.stringify({ version: 1, recent: [key("A")],
      entries: { [key("A")]: { observed: ["old"], selected: "old" } } }));
    enter(visits, ["old", "new"]);
    queue.shift()!();
    await visits.settled();
    expect(attempts).toBe(mode === "quota-twice" ? 2 : 1);
    if (mode === "quota-twice" || mode === "security") expect(storage.getItem(SESSION_VISITS_KEY)).toBe(prior);
    visits.leave();
    expect(enter(visits, ["old", "new-b"], "B").unread).toEqual(["new-b"]);
    // Do not execute the final queued write; this assertion examines retained memory.
  });
  it.each([false, true])("protects accepted B from delayed A flush (quota=%s)", async (quota) => {
    const storage = new MemoryStorage();
    const names = Array.from({ length: SESSION_VISITS_LIMIT }, (_, i) => `old-${i}`);
    seed(storage, [...names.slice(0, -1), "B"]);
    const { visits, queue } = queuedVisits(storage);
    enter(visits, ["a"], "A");
    visits.leave();
    enter(visits, ["old", "new-b"], "B");
    const original = storage.setItem.bind(storage);
    let attempts = 0;
    storage.setItem = (k, v) => {
      if (++attempts === 1 && quota) throw new DOMException("full", "QuotaExceededError");
      original(k, v);
    };
    queue.shift()!(); // A runs while B is the accepted active binding.
    expect(documentOf(storage).entries[key("B")]).toBeDefined();
    expect(documentOf(storage).entries[key("A")]).toBeDefined();
    expect(visits.observe([art("old", "B"), art("new-b", "B")], "old")).toEqual(["new-b"]);
    queue.splice(0).forEach((work) => work());
    await visits.settled();
  });
  it("invalidates an evicted queued receipt without ABA resurrection after revisit", async () => {
    const storage = new MemoryStorage();
    seed(storage, ["A", "B"]);
    const { visits, queue } = queuedVisits(storage);
    enter(visits, ["old", "stale-b"], "B"); // B token 1, held behind A deliberately.
    visits.leave();
    enter(visits, ["a"], "A");
    const original = storage.setItem.bind(storage);
    let fail = true;
    storage.setItem = (k, v) => {
      if (fail) { fail = false; throw new DOMException("full", "QuotaExceededError"); }
      original(k, v);
    };
    const flushA = queue.splice(1, 1)[0];
    if (!flushA) throw new Error("Expected the queued A eviction callback");
    flushA(); // A successfully evicts B.
    expect(documentOf(storage).entries[key("B")]).toBeUndefined();
    visits.leave();
    expect(enter(visits, ["fresh-b"], "B").unread).toEqual([]);
    queue.shift()!(); // Old B callback must not match the new B write token.
    expect(documentOf(storage).entries[key("B")]).toBeUndefined();
    queue.shift()!();
    await visits.settled();
    expect(documentOf(storage).entries[key("B")].observed).toEqual(["fresh-b"]);
  });
});
