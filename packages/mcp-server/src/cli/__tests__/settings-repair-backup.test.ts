import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanDpEntriesFromScope, HOOK_MARKERS } from "../setup-tasks.js";

let tmp: string;
let file: string;
const own = { type: "command", command: "node own/hook.mjs" };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-settings-backup-"));
  file = path.join(tmp, "settings.local.json");
});
afterEach(() => {
  fs.chmodSync(tmp, 0o700);
  fs.rmSync(tmp, { recursive: true, force: true });
});
const backups = () => fs.readdirSync(tmp).filter((name) => name.startsWith("settings.local.json.deeppairing-backup-"));
const original = () => Buffer.from(" \n" + JSON.stringify({
  permissions: { allow: ["Read"] }, env: { KEEP: "private" }, hooks: {
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: "node .deeppairing/hooks/stop.mjs" }, own] }],
    PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "node .deeppairing/hooks/checkpoint.mjs" }, own] }],
  },
}) + "\n");

describe("consented doctor settings backups", () => {
  it("preserves exact original bytes with unique exclusive backups for each mutation, and no backup for a no-op", () => {
    const bytes = original();
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    expect(cleanDpEntriesFromScope(file, "Stop", HOOK_MARKERS.Stop, { backup: true }).ok).toBe(true);
    const first = backups();
    expect(first).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmp, first[0]!))).toEqual(bytes);
    const middle = fs.readFileSync(file);
    expect(cleanDpEntriesFromScope(file, "PostToolUse", HOOK_MARKERS.PostToolUse, { backup: true }).ok).toBe(true);
    const second = backups();
    expect(second).toHaveLength(2);
    expect(new Set(second).size).toBe(2);
    expect(fs.readFileSync(path.join(tmp, first[0]!))).toEqual(bytes);
    expect(fs.readFileSync(path.join(tmp, second.find((name) => name !== first[0])!))).toEqual(middle);
    expect(second.every((name) => /deeppairing-backup-[0-9a-f-]{36}$/.test(name))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(settings.hooks.Stop[0].hooks).toEqual([own]);
    expect(settings.hooks.PostToolUse[0].hooks).toEqual([own]);
    const final = fs.readFileSync(file);
    expect(cleanDpEntriesFromScope(file, "Stop", HOOK_MARKERS.Stop, { backup: true }).removed).toBe(0);
    expect(backups()).toEqual(second);
    expect(fs.readFileSync(file)).toEqual(final);
  });

  it.runIf(process.platform !== "win32")("does not broaden source permissions", () => {
    fs.writeFileSync(file, original(), { mode: 0o640 });
    expect(cleanDpEntriesFromScope(file, "Stop", HOOK_MARKERS.Stop, { backup: true }).ok).toBe(true);
    const sourceMode = fs.statSync(file).mode & 0o777;
    const backupMode = fs.statSync(path.join(tmp, backups()[0]!)).mode & 0o777;
    expect(backupMode & ~sourceMode).toBe(0);
    expect(backupMode & 0o077).toBe(0);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "refuses the settings mutation if the backup cannot be persisted",
    () => {
      const bytes = original();
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      // The existing file remains writable; only creating a new backup is
      // impossible. This proves failure happens before settings overwrite.
      fs.chmodSync(tmp, 0o500);
      try {
        const result = cleanDpEntriesFromScope(file, "Stop", HOOK_MARKERS.Stop, { backup: true });
        expect(result.ok).toBe(false);
        expect(result.message).toContain("Settings backup failed");
        expect(fs.readFileSync(file)).toEqual(bytes);
        expect(backups()).toEqual([]);
      } finally { fs.chmodSync(tmp, 0o700); }
    },
  );

  it("does not create an original-byte backup for a missing settings file", () => {
    expect(cleanDpEntriesFromScope(file, "Stop", HOOK_MARKERS.Stop, { backup: true }).removed).toBe(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
