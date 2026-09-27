/**
 * #418 — concurrent `doctor --fix` runs racing over a dead lock-guard chain
 * (lock + `.break` + `.break.recover`, all owners dead) while writers wait on
 * that lock.
 *
 * Before the fix, two doctors could both judge the same dead `.recover` and
 * unlink it in turn: the second hit a raw ENOENT ("Not removed: ENOENT…"), or
 * — the theoretical case — deleted a LIVE `.recover` a writer had just
 * claimed, letting two breakers run at once. Doctors now serialize through
 * their own O_EXCL `<lock>.doctor` guard and treat ENOENT as "already
 * removed".
 *
 * Every child runs the SOURCE under tsx. Doctor children run exactly the
 * per-lock fix doctor applies (inspectLocks, guards first, clearDeadLockFile),
 * many passes per round to maximize the doctor-vs-doctor window. Writers
 * detect a stolen guard through file-lock's own release check (its "removed
 * while this process held it" warning), and a second holder through an
 * O_EXCL marker inside the critical section.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearDeadLockFile, inspectLocks, ownLockIdentity } from "../file-lock.js";
import { withGlobalStore, type GlobalStoreFixture } from "../../__tests__/global-store-fixture.js";

const CHILD_TIMEOUT_MS = 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE = JSON.stringify(pathToFileURL(path.resolve(here, "../file-lock.ts")).href);
const TSX = import.meta.resolve("tsx");
const IDENTITY = ownLockIdentity()!;

let fx: GlobalStoreFixture;
beforeEach(() => { fx = withGlobalStore("dp-doctor-race-"); });
afterEach(() => { fx.dispose(); });

function deadOwnerBody(): string {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return JSON.stringify({ ...IDENTITY, pid, processStartTime: null, createdAt: "2020-01-01T00:00:00.000Z", nonce: `dead-${pid}-${Math.random()}` });
}

// argv: root role rounds
const childProgram = String.raw`
  const fs = await import("node:fs");
  const path = await import("node:path");
  const lockMod = await import(${LOCK_MODULE});
  const { withFileLock, inspectLocks, clearDeadLockFile } = lockMod;
  const [root, role, roundsText] = process.argv.slice(1);
  const rounds = Number(roundsText);
  const lock = path.join(root, "chain.lock");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
  const result = { rawErrors: [], stolenGuards: 0, overlaps: 0, entered: 0 };
  const origError = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(" ");
    if (/removed while this process held it|replaced while this process held it/.test(text)) result.stolenGuards++;
  };
  fs.writeFileSync(path.join(root, ".ready-" + role), "");
  for (let r = 0; r < rounds; r++) {
    while (!fs.existsSync(path.join(root, ".round-" + r))) {
      if (Date.now() >= deadline) process.exit(6);
      Atomics.wait(waiter, 0, 0, 1);
    }
    if (role.startsWith("doctor")) {
      // The doctor --fix pass: guards before the lock, dead owners only.
      const rank = { clear: -2, doctor: -1, recover: 0, break: 1, lock: 2 };
      for (let pass = 0; pass < 40; pass++) {
        const locks = inspectLocks([root]).sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));
        // Stop once nothing dead is left (keeps CPU low for the rest of the suite).
        if (!locks.some((l) => l.state === "dead")) break;
        for (const l of locks) {
          if (l.state !== "dead") continue;
          try {
            const res = clearDeadLockFile(l.path);
            if (!res.removed && /ENOENT/.test(res.reason)) result.rawErrors.push(res.reason);
          } catch (e) {
            result.rawErrors.push(String(e && e.code ? e.code + ": " + e.message : e));
          }
        }
      }
    } else {
      withFileLock(lock, () => {
        result.entered++;
        const inside = path.join(root, "inside");
        try { fs.closeSync(fs.openSync(inside, "wx")); } catch { result.overlaps++; }
        Atomics.wait(waiter, 0, 0, 2);
        try { fs.unlinkSync(inside); } catch { result.overlaps++; }
      }, { timeoutMs: 30000 });
    }
    fs.writeFileSync(path.join(root, ".done-" + role + "-" + r), "");
  }
  console.error = origError;
  fs.writeFileSync(path.join(root, ".result-" + role), JSON.stringify(result));
`;

function start(role: string, rounds: number): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fx.dir, USERPROFILE: fx.dir };
  delete env.VITEST;
  delete env.NODE_ENV;
  return spawn(process.execPath, ["--import", TSX, "--input-type=module", "--eval", childProgram, fx.dir, role, String(rounds)], {
    stdio: ["pipe", "pipe", "pipe"], env,
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child timeout; stderr=${stderr}`)); }, CHILD_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}; stderr=${stderr}`));
    });
  });
}

async function race(opts: { doctors: number; writers: number; rounds: number; seedDoctorGuard: boolean }) {
  const lock = path.join(fx.dir, "chain.lock");
  const roles = [
    ...Array.from({ length: opts.doctors }, (_, i) => `doctor${i}`),
    ...Array.from({ length: opts.writers }, (_, i) => `writer${i}`),
  ];
  const children = roles.map((role) => start(role, opts.rounds));
  let failure: unknown;
  const finished = Promise.all(children.map(waitForExit)).catch((err: unknown) => { failure = err; });
  const waitFor = async (files: string[]) => {
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (!files.every((f) => fs.existsSync(path.join(fx.dir, f)))) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${files.find((f) => !fs.existsSync(path.join(fx.dir, f)))}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  await waitFor(roles.map((r) => `.ready-${r}`));
  for (let r = 0; r < opts.rounds; r++) {
    // A double crash left the whole chain behind; every writer is blocked
    // until a doctor clears `.recover`.
    fs.writeFileSync(lock, deadOwnerBody());
    fs.writeFileSync(`${lock}.break`, deadOwnerBody());
    fs.writeFileSync(`${lock}.break.recover`, deadOwnerBody());
    // A doctor that crashed inside its own guard, too.
    if (opts.seedDoctorGuard) fs.writeFileSync(`${lock}.doctor`, deadOwnerBody());
    fs.writeFileSync(path.join(fx.dir, `.round-${r}`), "");
    await waitFor(roles.map((role) => `.done-${role}-${r}`));
  }
  await finished;
  if (failure) throw failure;

  const results = Object.fromEntries(roles.map((role) => [role, JSON.parse(fs.readFileSync(path.join(fx.dir, `.result-${role}`), "utf8"))]));
  const rawErrors = roles.flatMap((role) => results[role].rawErrors as string[]);
  expect(rawErrors).toEqual([]);
  // A "replaced/removed while this process held it" release warning in ANY
  // child — writer or doctor — means two holders of the same guard.
  expect(roles.map((role) => results[role].stolenGuards)).toEqual(roles.map(() => 0));
  expect(roles.map((role) => results[role].overlaps)).toEqual(roles.map(() => 0));
  expect(roles.filter((r) => r.startsWith("writer")).reduce((n, role) => n + results[role].entered, 0)).toBe(opts.writers * opts.rounds);
  expect(fs.readdirSync(fx.dir).filter((f) => f.startsWith("chain.lock"))).toEqual([]);
}

describe("#418 — concurrent doctor --fix over a dead guard chain", () => {
  it("serializes doctors: no raw ENOENT, no live guard removed, never two holders", async () => {
    await race({ doctors: 3, writers: 4, rounds: 10, seedDoctorGuard: false });
  }, 180_000);

  it("#421 review: clearing a stranded .doctor is serialized too — never two doctor-guard holders", async () => {
    await race({ doctors: 6, writers: 4, rounds: 40, seedDoctorGuard: true });
  }, 180_000);
});

describe("#418 — doctor guard unit behaviour", () => {
  it("a file another doctor already removed reports 'already removed', never a raw ENOENT", () => {
    const lock = path.join(fx.dir, "gone.lock");
    for (const f of [lock, `${lock}.break`, `${lock}.break.recover`, `${lock}.doctor`]) {
      expect(clearDeadLockFile(f)).toEqual({ removed: false, reason: "already removed" });
    }
  });

  it("a live doctor guard defers other doctors; a stranded dead one is listed and cleared", () => {
    const lock = path.join(fx.dir, "d.lock");
    fs.writeFileSync(`${lock}.break.recover`, deadOwnerBody());
    const live = JSON.stringify({ ...IDENTITY, pid: process.ppid, processStartTime: null, createdAt: "", nonce: "live" });
    fs.writeFileSync(`${lock}.doctor`, live);
    expect(clearDeadLockFile(`${lock}.break.recover`)).toMatchObject({ removed: false, reason: expect.stringMatching(/another doctor/) });
    expect(fs.existsSync(`${lock}.break.recover`)).toBe(true);

    fs.writeFileSync(`${lock}.doctor`, deadOwnerBody());
    const kinds = inspectLocks([fx.dir]).map((r) => `${r.kind}:${r.state}`).sort();
    expect(kinds).toEqual(["doctor:dead", "recover:dead"]);
    expect(clearDeadLockFile(`${lock}.doctor`).removed).toBe(true);
    expect(clearDeadLockFile(`${lock}.break.recover`).removed).toBe(true);
    expect(fs.readdirSync(fx.dir).filter((f) => f.startsWith("d.lock"))).toEqual([]);
  });

  it("a stranded .doctor.clear is listed and left for a human; a live one makes .doctor clearing defer", () => {
    const lock = path.join(fx.dir, "c.lock");
    fs.writeFileSync(`${lock}.doctor`, deadOwnerBody());
    const live = JSON.stringify({ ...IDENTITY, pid: process.ppid, processStartTime: null, createdAt: "", nonce: "live" });
    fs.writeFileSync(`${lock}.doctor.clear`, live);
    expect(clearDeadLockFile(`${lock}.doctor`)).toMatchObject({ removed: false, reason: expect.stringMatching(/busy/) });
    expect(fs.existsSync(`${lock}.doctor`)).toBe(true);

    fs.writeFileSync(`${lock}.doctor.clear`, deadOwnerBody());
    expect(inspectLocks([fx.dir]).map((r) => `${r.kind}:${r.state}`).sort()).toEqual(["clear:dead", "doctor:dead"]);
    expect(clearDeadLockFile(`${lock}.doctor.clear`).removed).toBe(false);
    expect(fs.existsSync(`${lock}.doctor.clear`)).toBe(true);
  });
});
