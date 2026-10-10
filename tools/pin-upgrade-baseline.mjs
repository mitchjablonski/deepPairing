// Run from the repo root after fetching the documented release tag. No install,
// build, network access, or current source files enter this generated fixture.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const version = "0.1.57";
const commit = "d9efe325454f96473ec84a4537e38661ffdd9aac";
const files = ["server.mjs", "server/package.json", "server/standalone.js", "server/daemon.js", "server/web/index.html", ".claude-plugin/plugin.json", "LICENSE"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contents = {};
const provenance = {};
for (const file of files) {
  const source = file === "LICENSE" ? file : `claude-plugin/${file}`;
  const bytes = execFileSync("git", ["show", `${commit}:${source}`], { maxBuffer: 4 * 1024 * 1024 });
  contents[file] = bytes.toString("utf8");
  if (!Buffer.from(contents[file]).equals(bytes)) throw new Error(`not UTF-8: ${source}`);
  provenance[file] = {
    source, bytes: bytes.length, sha256: sha256(bytes),
    gitBlob: execFileSync("git", ["rev-parse", `${commit}:${source}`], { encoding: "utf8" }).trim(),
  };
}
const compressed = gzipSync(JSON.stringify(contents), { level: 9 });
const destination = path.resolve("packages/mcp-server/src/__tests__/fixtures/plugin-upgrade/v0.1.57");
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, "runtime.json.gz"), compressed);
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({
  version, commit,
  release: `https://github.com/mitchjablonski/deepPairing/releases/tag/v${version}`,
  generator: "node tools/pin-upgrade-baseline.mjs",
  scope: "Exact released runtime subset; UI asset graph, hooks and commands excluded. Original bundle license notices retained.",
  archive: { bytes: compressed.length, sha256: sha256(compressed) }, files: provenance,
}, null, 2) + "\n");
console.log(`Pinned v${version} ${commit}: ${compressed.length} compressed bytes`);
