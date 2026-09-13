/**
 * Chunk-safe JSONL parser (T7 CRITICAL — carried Agent Deck finding).
 *
 * Harness stdout arrives as arbitrary byte slices: a JSON line can be split anywhere,
 * INCLUDING inside a multi-byte UTF-8 character. This parser is therefore byte-oriented:
 * TextDecoder in streaming mode holds partial code points across push() calls, a line
 * buffer holds partial lines. Feeding the same stream at any chunk boundaries yields the
 * identical record sequence — that property is what the replay tests pin.
 *
 * It NEVER throws and NEVER hangs: malformed lines come back as {ok:false} records, and
 * a line exceeding maxLineBytes is flushed as malformed rather than buffered forever
 * (the never-ending-line attack is a hang in disguise).
 */
export type JsonlRecord =
  | { ok: true; value: unknown }
  | { ok: false; line: string; reason: "invalid-json" | "line-too-long" };

export class JsonlChunkParser {
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private buffer = "";
  private overflowing = false;

  constructor(private readonly maxLineBytes = 8 * 1024 * 1024) {}

  /** Feed the next slice of bytes (or a string); returns records completed by it. */
  push(chunk: Uint8Array | string): JsonlRecord[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: JsonlRecord[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\n") continue;
      const line = this.buffer + text.slice(start, i);
      this.buffer = "";
      start = i + 1;
      if (this.overflowing) {
        this.overflowing = false;
        out.push({ ok: false, line: line.slice(0, 256), reason: "line-too-long" });
      } else if (line.trim().length > 0) {
        out.push(parseLine(line)); // blank lines are keep-alives, not records
      }
    }
    this.buffer += text.slice(start);
    if (this.buffer.length > this.maxLineBytes) {
      // stop buffering a line that never ends; report it when (if) its newline arrives
      this.buffer = this.buffer.slice(0, 256);
      this.overflowing = true;
    }
    return out;
  }

  /** End of stream: whatever is buffered is the (possibly torn) final line. */
  flush(): JsonlRecord[] {
    const line = this.decoder.decode(); // drain any partial code point
    const last = this.buffer + line;
    this.buffer = "";
    if (this.overflowing) {
      this.overflowing = false;
      return [{ ok: false, line: last.slice(0, 256), reason: "line-too-long" }];
    }
    if (last.trim().length === 0) return [];
    return [parseLine(last)];
  }
}

function parseLine(line: string): JsonlRecord {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false, line: line.slice(0, 256), reason: "invalid-json" };
  }
}
