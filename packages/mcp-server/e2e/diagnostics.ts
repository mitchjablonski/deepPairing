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
    .replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(
      /(\b"?authorization"?\s*[:=]\s*")((?:\\.|[^"\\])*)"/gi,
      (_match, prefix: string, credential: string) => {
        const scheme = credential.match(/^([A-Za-z][A-Za-z0-9._-]*\s+)/)?.[1] ?? "";
        return `${prefix}${scheme}[REDACTED]"`;
      },
    )
    .replace(
      /(\b'?authorization'?\s*[:=]\s*')((?:\\.|[^'\\])*)'/gi,
      (_match, prefix: string, credential: string) => {
        const scheme = credential.match(/^([A-Za-z][A-Za-z0-9._-]*\s+)/)?.[1] ?? "";
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
      /(\b"?authorization"?\s*[:=]\s*["']?)((?:[A-Za-z][A-Za-z0-9._-]*\s+)?)[^,\s;"']+/gi,
      "$1$2[REDACTED]",
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
