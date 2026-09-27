/**
 * The PDF object parser: tokens in, objects out.
 *
 * It knows the eight object types and the `N G obj ... endobj` wrapper. It does
 * not know how to find objects in a file, which is `document.ts`.
 */

import { Lexer, latin1ToBytes, type Token } from "./lexer";
import { PdfDict, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from "./objects";

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

/**
 * Read one object. `first` may be supplied when the caller has already read the
 * first token, which is how the reference lookahead below avoids re-reading.
 */
export function parseObject(lex: Lexer, first?: Token): PdfObject {
  const tok = first ?? lex.nextToken();

  switch (tok.type) {
    case "eof":
      throw new PdfError("unexpected end of file while reading an object");

    case "num": {
      // `12 0 R` is a reference. A number followed by another number is only a
      // reference if the third token is `R`.
      if (typeof tok.value !== "number") return null;
      const save = lex.pos;
      const t2 = lex.nextToken();
      if (t2.type === "num") {
        const t3 = lex.nextToken();
        if (t3.type === "keyword" && t3.value === "R") {
          return new PdfRef(tok.value, t2.value as number);
        }
      }
      lex.pos = save;
      return tok.value;
    }

    case "name":
      return new PdfName(String(tok.value));

    case "str":
      return new PdfString(tok.value as Uint8Array);

    case "arrOpen": {
      const arr: PdfObject[] = [];
      for (;;) {
        const t = lex.nextToken();
        if (t.type === "arrClose" || t.type === "eof") break;
        if (t.type === "dictClose") throw new PdfError("unexpected `>>` inside an array");
        arr.push(parseObject(lex, t));
      }
      return arr;
    }

    case "dictOpen": {
      const dict = new PdfDict();
      for (;;) {
        const t = lex.nextToken();
        if (t.type === "dictClose" || t.type === "eof") break;
        if (t.type !== "name") {
          // A key that is not a name means the dict is damaged. Skip the value
          // and keep the keys that do parse, so a bad key cannot lose the rest.
          if (t.type === "arrClose") continue;
          parseObject(lex, t);
          continue;
        }
        const value = parseObject(lex);
        dict.set(String(t.value), value);
      }
      return readStreamIfPresent(lex, dict);
    }

    case "keyword": {
      const kw = String(tok.value);
      if (kw === "true") return true;
      if (kw === "false") return false;
      if (kw === "null") return null;
      // `endobj`, `stream` and friends land here when a file is damaged.
      return null;
    }

    default:
      return null;
  }
}

/**
 * After a dict, a file may put `stream` and then raw bytes. Read them if so.
 *
 * `/Length` is used when it checks out. When it is missing, indirect, or wrong,
 * the bytes are recovered by searching for `endstream`, and `/Length` is
 * corrected to what was actually read.
 */
function readStreamIfPresent(lex: Lexer, dict: PdfDict): PdfObject {
  const save = lex.pos;
  lex.skipWhite();
  const t = lex.nextToken();
  if (t.type !== "keyword" || t.value !== "stream") {
    lex.pos = save;
    return dict;
  }

  // The keyword is followed by CRLF or LF, never by CR alone.
  let p = lex.pos;
  if (lex.buf[p] === 0x0d) p++;
  if (lex.buf[p] === 0x0a) p++;
  const start = p;

  const declared = dict.getNumber("Length");
  if (declared !== null && declared >= 0 && start + declared <= lex.buf.length) {
    const end = start + declared;
    if (endstreamFollows(lex, end)) {
      lex.pos = afterEndstream(lex, end);
      const raw = lex.buf.subarray(start, end);
      if (raw.length > 0 && raw[raw.length - 1] === 0x0a) {
        // A writer that counted the trailing LF into Length.
        lex.pos -= 1;
        return new PdfStream(dict, raw.subarray(0, raw.length - 1));
      }
      return new PdfStream(dict, raw);
    }
  }

  // Fall back to a search. `findOutsideStrings` is not enough here, because a
  // stream holds binary data that may contain the word by coincidence, so this
  // is only used when Length did not work out.
  const found = lex.findOutsideStrings("endstream", start);
  if (found < 0) {
    lex.pos = lex.buf.length;
    return new PdfStream(dict, lex.buf.subarray(start));
  }
  let end = found;
  if (lex.buf[end - 1] === 0x0a) end--;
  if (lex.buf[end - 1] === 0x0d) end--;
  lex.pos = afterEndstream(lex, found);
  dict.setNumber("Length", end - start);
  return new PdfStream(dict, lex.buf.subarray(start, end));
}

function endstreamFollows(lex: Lexer, from: number): boolean {
  const probe = new Lexer(lex.buf, from);
  probe.skipWhite();
  const t = probe.nextToken();
  return t.type === "keyword" && t.value === "endstream";
}

function afterEndstream(lex: Lexer, at: number): number {
  const probe = new Lexer(lex.buf, at);
  probe.skipWhite();
  probe.nextToken(); // endstream
  probe.skipWhite();
  return probe.pos;
}

export interface IndirectObject {
  num: number;
  gen: number;
  value: PdfObject;
}

/**
 * Read the `N G obj ... endobj` at `offset`. Returns null when the bytes there
 * are not an object header, which is how a damaged xref table gets rebuilt.
 */
export function parseIndirectObjectAt(buf: Uint8Array, offset: number): IndirectObject | null {
  const lex = new Lexer(buf, offset);
  const t1 = lex.nextToken();
  const t2 = lex.nextToken();
  const t3 = lex.nextToken();
  if (t1.type !== "num" || t2.type !== "num") return null;
  if (t3.type !== "keyword" || t3.value !== "obj") return null;
  const num = t1.value as number;
  const gen = t2.value as number;
  let value: PdfObject;
  try {
    value = parseObject(lex);
  } catch (err) {
    if (err instanceof PdfError) return null;
    throw err;
  }
  return { num, gen, value };
}

/** Decode a name for the writer, escaping the bytes PDF requires escaped. */
export function encodeName(name: string): Uint8Array {
  const hex = "0123456789ABCDEF";
  const out: number[] = [0x2f]; // '/'
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const needsEscape = c < 0x21 || c > 0x7e || "()<>[]{}/%#".includes(name[i] as string);
    if (needsEscape) {
      // `#` followed by two hex digits, not two raw nibbles.
      out.push(0x23, hex.charCodeAt((c >> 4) & 0x0f), hex.charCodeAt(c & 0x0f));
    } else {
      out.push(c & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Encode a text string as a hex string, which never needs escaping. */
export function encodeHexString(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0x3c]; // '<'
  for (const b of bytes) {
    out.push(0x30 + ((b >> 4) & 0x0f), 0x30 + (b & 0x0f));
  }
  out.push(0x3e); // '>'
  return Uint8Array.from(out);
}

export { latin1ToBytes };
