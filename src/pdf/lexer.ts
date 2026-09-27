/**
 * The PDF lexer.
 *
 * Turns bytes into tokens. It does not build objects and it does not know what
 * a document is; that is `parser.ts`. Keeping the two apart means the same
 * lexer can also walk a content stream, which has no objects at all.
 */

export type TokenType =
  | "num"
  | "name"
  | "str"
  | "keyword"
  | "arrOpen"
  | "arrClose"
  | "dictOpen"
  | "dictClose"
  | "braceOpen"
  | "braceClose"
  | "eof";

export interface Token {
  type: TokenType;
  /** A number for `num`, decoded text for `name` and `keyword`, bytes for `str`. */
  value: number | string | Uint8Array;
}

export function isWhitespace(c: number): boolean {
  return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

export function isDelimiter(c: number): boolean {
  return (
    c === 0x28 || // (
    c === 0x29 || // )
    c === 0x3c || // <
    c === 0x3e || // >
    c === 0x5b || // [
    c === 0x5d || // ]
    c === 0x7b || // {
    c === 0x7d || // }
    c === 0x2f || // /
    c === 0x25 // %
  );
}

export function isRegular(c: number): boolean {
  return !isWhitespace(c) && !isDelimiter(c);
}

const EOF = 0;

/** Read a number the way PDF writes them, then convert. Lenient by design. */
function toNumber(run: string): number {
  const n = Number(run);
  if (!Number.isNaN(n)) return n;
  // Some writers emit forms like "--3" or "1.2.3". Take the leading valid
  // part, and take the sign from the character right before its first digit.
  const m = /(?:\d+\.?\d*|\.\d+)/.exec(run);
  if (!m) return 0;
  const at = m.index;
  const signChar = at > 0 ? run[at - 1] : "";
  const sign = signChar === "-" ? -1 : 1;
  return sign * Number(m[0]);
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export class Lexer {
  readonly buf: Uint8Array;
  pos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get length(): number {
    return this.buf.length;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  private at(i: number): number {
    return i >= 0 && i < this.buf.length ? (this.buf[i] as number) : EOF;
  }

  /** Skip whitespace and `%` comments. */
  skipWhite(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      if (isWhitespace(c)) {
        this.pos++;
      } else if (c === 0x25) {
        // A comment runs to the end of the line, either LF or CR LF.
        while (this.pos < this.buf.length) {
          const d = this.buf[this.pos] as number;
          if (d === 0x0a) break;
          if (d === 0x0d) {
            this.pos++;
            if (this.at(this.pos) === 0x0a) this.pos++;
            break;
          }
          this.pos++;
        }
      } else {
        return;
      }
    }
  }

  /** The next token, leaving `pos` after it. */
  nextToken(): Token {
    this.skipWhite();
    if (this.eof) return { type: "eof", value: 0 };

    const c = this.buf[this.pos] as number;

    switch (c) {
      case 0x5b: // [
        this.pos++;
        return { type: "arrOpen", value: "[" };
      case 0x5d: // ]
        this.pos++;
        return { type: "arrClose", value: "]" };
      case 0x7b: // {
        this.pos++;
        return { type: "braceOpen", value: "{" };
      case 0x7d: // }
        this.pos++;
        return { type: "braceClose", value: "}" };
      case 0x2f: // /
        return { type: "name", value: this.readName() };
      case 0x28: // (
        return { type: "str", value: this.readLiteralString() };
      case 0x3c: // <
        if (this.at(this.pos + 1) === 0x3c) {
          this.pos += 2;
          return { type: "dictOpen", value: "<<" };
        }
        return { type: "str", value: this.readHexString() };
      case 0x3e: // >
        if (this.at(this.pos + 1) === 0x3e) {
          this.pos += 2;
          return { type: "dictClose", value: ">>" };
        }
        // A lone `>` is invalid. Step over it so parsing cannot stall.
        this.pos++;
        return { type: "keyword", value: ">" };
      default:
        break;
    }

    // A run of regular characters is either a number or a keyword.
    const start = this.pos;
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos] as number)) this.pos++;
    const run = latin1(this.buf.subarray(start, this.pos));
    if (run.length === 0) {
      // A stray delimiter we do not handle. Step over it.
      this.pos++;
      return { type: "keyword", value: String.fromCharCode(c) };
    }
    const first = run.charCodeAt(0);
    const looksNumeric =
      (first >= 0x30 && first <= 0x39) || first === 0x2b || first === 0x2d || first === 0x2e;
    if (looksNumeric) return { type: "num", value: toNumber(run) };
    return { type: "keyword", value: run };
  }

  /** The next token without consuming it. */
  peekToken(): Token {
    const save = this.pos;
    const t = this.nextToken();
    this.pos = save;
    return t;
  }

  /** Called with `pos` on the `/`. Returns the decoded name. */
  private readName(): string {
    this.pos++; // skip '/'
    let out = "";
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      if (!isRegular(c)) break;
      if (c === 0x23 && this.pos + 2 < this.buf.length) {
        // `#xx` is a hex escape inside a name.
        const h1 = hexVal(this.at(this.pos + 1));
        const h2 = hexVal(this.at(this.pos + 2));
        if (h1 >= 0 && h2 >= 0) {
          out += String.fromCharCode((h1 << 4) | h2);
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return out;
  }

  /** Called with `pos` on the `(`. */
  private readLiteralString(): Uint8Array {
    this.pos++; // skip '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      let c = this.buf[this.pos] as number;
      this.pos++;
      if (c === 0x5c) {
        // backslash escape
        c = this.buf[this.pos] as number;
        this.pos++;
        switch (c) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: out.push(0x28); break; // (
          case 0x29: out.push(0x29); break; // )
          case 0x5c: out.push(0x5c); break; // \
          case 0x0d: // line continuation
            if (this.at(this.pos) === 0x0a) this.pos++;
            break;
          case 0x0a: // line continuation
            break;
          default: {
            // \ddd, one to three octal digits. Three digits can reach 511,
            // so the result is masked to a byte, which is what readers do.
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let n = 0; n < 2; n++) {
                const d = this.at(this.pos);
                if (d < 0x30 || d > 0x37) break;
                v = v * 8 + (d - 0x30);
                this.pos++;
              }
              out.push(v & 0xff);
            } else {
              out.push(c);
            }
          }
        }
        continue;
      }
      if (c === 0x28) {
        depth++;
        out.push(c);
        continue;
      }
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      if (c === 0x0d) {
        // An end-of-line marker inside a string is stored as a single LF.
        if (this.at(this.pos) === 0x0a) this.pos++;
        out.push(0x0a);
        continue;
      }
      out.push(c);
    }
    return Uint8Array.from(out);
  }

  /** Called with `pos` on the `<`. */
  private readHexString(): Uint8Array {
    this.pos++; // skip '<'
    const out: number[] = [];
    let hi = -1;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos] as number;
      this.pos++;
      if (c === 0x3e) break; // '>'
      const v = hexVal(c);
      if (v < 0) continue; // whitespace and junk are skipped
      if (hi < 0) {
        hi = v;
      } else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4); // an odd final digit is padded with 0
    return Uint8Array.from(out);
  }

  /**
   * Find `needle` in the bytes from `from`, ignoring anything inside a string
   * or a comment. Used to find `endstream` when `/Length` is wrong or indirect.
   */
  findOutsideStrings(needle: string, from: number): number {
    const target = latin1ToBytes(needle);
    const nested = new Lexer(this.buf);
    let i = from;
    let inStr = false;
    let depth = 0;
    while (i < this.buf.length) {
      const c = this.buf[i] as number;
      if (inStr) {
        if (c === 0x5c) {
          i += 2;
          continue;
        }
        if (c === 0x28) depth++;
        if (c === 0x29) {
          depth--;
          if (depth === 0) inStr = false;
        }
        i++;
        continue;
      }
      if (c === 0x28) {
        inStr = true;
        depth = 1;
        i++;
        continue;
      }
      if (c === 0x25) {
        while (i < this.buf.length && this.buf[i] !== 0x0a && this.buf[i] !== 0x0d) i++;
        continue;
      }
      if (c === target[0] && nested.matchesAt(i, target)) return i;
      i++;
    }
    return -1;
  }

  private matchesAt(i: number, target: Uint8Array): boolean {
    for (let k = 0; k < target.length; k++) {
      if (this.at(i + k) !== target[k]) return false;
    }
    return true;
  }
}

export function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
