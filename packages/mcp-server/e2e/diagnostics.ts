import fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import path from "node:path";
import type { TestInfo } from "@playwright/test";

/** Persist only an already-redacted, bounded tail outside the raw trace archive. */
export async function attachDiagnosticFile(testInfo: TestInfo, name: string, body: Buffer): Promise<void> {
  try {
    const file = testInfo.outputPath(`${name}.txt`);
    await fs.writeFile(file, body);
    await testInfo.attach(name, { path: file, contentType: "text/plain" });
  } catch (error) {
    // Diagnostics are secondary evidence, never a replacement for the failure.
    console.warn(`[e2e] could not persist ${name}: ${redactDiagnostic(String(error))}`);
  }
}

export type FileTail =
  | { kind: "tail"; size: number; skipped: number; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "not-regular"; type: string }
  | { kind: "escaped" }
  | { kind: "replaced" }
  | { kind: "unreadable"; code: string };

function fileType(stat: Stats): string {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFIFO()) return "fifo";
  if (stat.isDirectory()) return "directory";
  if (stat.isSocket()) return "socket";
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return "device";
  return "unknown";
}

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown";
}

/**
 * Read at most `maxBytes` from the END of the regular file at `root/<relative>`,
 * confined to the fixture `root`:
 *
 *  1. `root` is canonicalised once (`realpath`) — the fixture's own mkdtemp may
 *     legitimately sit under a symlinked tmp (macOS `/var` → `/private/var`).
 *  2. `realpath(root/<relative>)` must equal `realRoot/<relative>` exactly, so
 *     NO component below the root — parent directories included — may be a
 *     symlink. This is what rejects a `.deeppairing` → elsewhere link.
 *  3. The canonical path is opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (FIFOs
 *     cannot block the open), the HANDLE is fstat'ed and must be a regular file,
 *     and its (dev, ino) must match a fresh stat of the canonical path.
 *  4. ONE positioned read of at most `maxBytes` from the end. Never the whole
 *     file, never sliced afterwards.
 *
 * Every failure is returned as a value, never thrown, so a diagnostic read can
 * never replace the primary failure.
 *
 * Honest limits: these are sequential syscalls, not an atomic openat walk. A
 * same-uid writer racing between the realpath check and the open could still
 * substitute a path component; the handle-identity check narrows but does not
 * eliminate that window, and on Windows `ino` may be less discriminating. The
 * fixture root is a process-private mkdtemp, so the realistic threat is the
 * fixture's own contents, which this fully confines.
 */
export async function readConfinedFileTail(root: string, relative: readonly string[], maxBytes: number): Promise<FileTail> {
  let handle: fs.FileHandle | undefined;
  try {
    const realRoot = await fs.realpath(root);
    const expected = path.join(realRoot, ...relative);
    if (!expected.startsWith(realRoot + path.sep)) return { kind: "escaped" };
    const leaf = await fs.lstat(path.join(root, ...relative));
    if (!leaf.isFile()) return { kind: "not-regular", type: fileType(leaf) };
    let real: string;
    try {
      real = await fs.realpath(path.join(root, ...relative));
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT") return { kind: "missing" };
      if (code === "ELOOP") return { kind: "not-regular", type: "symlink" };
      if (code === "ENOTDIR") return { kind: "not-regular", type: "not-a-directory-parent" };
      return { kind: "unreadable", code };
    }
    if (real !== expected) return { kind: "escaped" };
    // O_NOFOLLOW/O_NONBLOCK are absent on Windows; the realpath + fstat checks still hold.
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    handle = await fs.open(expected, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "not-regular", type: fileType(stat) };
    const current = await fs.stat(expected);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return { kind: "replaced" };
    const length = Math.min(stat.size, maxBytes);
    const skipped = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, skipped);
    return { kind: "tail", size: stat.size, skipped, bytes: buffer.subarray(0, bytesRead) };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "not-regular", type: "symlink" };
    return { kind: "unreadable", code };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function scrubUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

function safeAuthorizationScheme(credential: string): string {
  return credential.match(/^((?:Basic|Bearer|Digest|Negotiate|AWS4-HMAC-SHA256)\s+)/i)?.[1] ?? "";
}

/** Best-effort scrubber for the common credentials emitted by local E2E services. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(URL_PATTERN, scrubUrl)
    .replace(
      /(\b"?(?:set-cookie|cookie)"?\s*[:=]\s*")((?:\\.|[^"\\])*)"/gi,
      '$1[REDACTED]"',
    )
    .replace(
      /(\b'?(?:set-cookie|cookie)'?\s*[:=]\s*')((?:\\.|[^'\\])*)'/gi,
      "$1[REDACTED]'",
    )
    .replace(/(\b"?(?:set-cookie|cookie)"?\s*[:=]\s*")[^"\r\n]*$/gim, "$1[REDACTED]")
    .replace(/(\b'?(?:set-cookie|cookie)'?\s*[:=]\s*')[^'\r\n]*$/gim, "$1[REDACTED]")
    .replace(
      /(\b["']?(?:set-cookie|cookie)["']?\s*[:=]\s*)\[[^\r\n]*\]/gi,
      '$1["[REDACTED]"]',
    )
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(
      /(\b"?authorization"?\s*[:=]\s*")((?:\\.|[^"\\])*)"/gi,
      (_match, prefix: string, credential: string) => {
        const scheme = safeAuthorizationScheme(credential);
        return `${prefix}${scheme}[REDACTED]"`;
      },
    )
    .replace(
      /(\b'?authorization'?\s*[:=]\s*')((?:\\.|[^'\\])*)'/gi,
      (_match, prefix: string, credential: string) => {
        const scheme = safeAuthorizationScheme(credential);
        return `${prefix}${scheme}[REDACTED]'`;
      },
    )
    .replace(
      /(\b"?(?:authToken|accessToken|apiKey|x-api-key|api_key|password)"?\s*[:=]\s*")((?:\\.|[^"\\])*)"/gi,
      '$1[REDACTED]"',
    )
    .replace(
      /(\b'?(?:authToken|accessToken|apiKey|x-api-key|api_key|password)'?\s*[:=]\s*')((?:\\.|[^'\\])*)'/gi,
      "$1[REDACTED]'",
    )
    .replace(
      /(\b"?(?:authToken|accessToken|apiKey|x-api-key|api_key|password)"?\s*[:=]\s*")[^"\r\n]*$/gim,
      "$1[REDACTED]",
    )
    .replace(
      /(\b'?(?:authToken|accessToken|apiKey|x-api-key|api_key|password)'?\s*[:=]\s*')[^'\r\n]*$/gim,
      "$1[REDACTED]",
    )
    .replace(
      /(\b"?authorization"?\s*[:=]\s*)([^\r\n]*)/gi,
      (_match, prefix: string, credential: string) => {
        const quote = credential[0] === '"' || credential[0] === "'" ? credential[0] : "";
        const content = quote ? credential.slice(1) : credential;
        const scheme = safeAuthorizationScheme(content);
        const closed = quote && credential.trimEnd().endsWith(quote) ? quote : "";
        return `${prefix}${quote}${scheme}[REDACTED]${closed}`;
      },
    )
    .replace(
      /(\b"?(?:authToken|accessToken|apiKey|x-api-key|api_key|password)"?\s*[:=]\s*["']?)[^,\s;"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]");
}

export class BoundedDiagnosticTail {
  readonly lines: Buffer[] = [];
  bytes = 0;

  constructor(readonly maxBytes: number) {}

  record(line: string): void {
    // Reject before redaction or eviction: one pathological event must not erase
    // the useful tail that preceded it.
    if (Buffer.byteLength(line) > this.maxBytes) return;
    const safe = Buffer.from(`${redactDiagnostic(line)}\n`);
    if (safe.length > this.maxBytes) return;
    while (this.lines.length && this.bytes + safe.length > this.maxBytes) {
      this.bytes -= this.lines.shift()!.length;
    }
    this.lines.push(safe);
    this.bytes += safe.length;
  }

  body(): Buffer {
    return Buffer.concat(this.lines);
  }
}
