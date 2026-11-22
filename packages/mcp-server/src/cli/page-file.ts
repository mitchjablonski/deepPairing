import fs from "node:fs";

export type PageFileRead =
  | { ok: true; bytes: Buffer }
  | { ok: false; tooLarge: true; size: number };

/**
 * Read `deeppairing present page --file` input with a hard bound. Opens once
 * (O_NONBLOCK so a FIFO can't hang the open; no O_NOFOLLOW, because --file may
 * legitimately be a symlink to a file anywhere), requires a regular file on
 * the descriptor, and reads at most `maxBytes + 1` bytes from it, so a file
 * that grows after the fstat is still caught without reading all of it.
 * Throws for unreadable / non-regular input; returns `tooLarge` over the cap.
 */
export function readBoundedPageFile(file: string, maxBytes: number): PageFileRead {
  const { O_RDONLY, O_NONBLOCK } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(file, O_RDONLY | (O_NONBLOCK ?? 0));
  } catch (err) {
    throw new Error(`Cannot open the page file ${file}: ${(err as NodeJS.ErrnoException).code ?? String(err)}.`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`The page file ${file} is not a regular file.`);
    if (stat.size > maxBytes) return { ok: false, tooLarge: true, size: stat.size };
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const got = fs.readSync(fd, buf, total, buf.length - total, total);
      if (got === 0) break;
      total += got;
    }
    if (total > maxBytes) return { ok: false, tooLarge: true, size: total };
    return { ok: true, bytes: buf.subarray(0, total) };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}
