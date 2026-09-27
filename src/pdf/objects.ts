/**
 * The PDF object model.
 *
 * Everything in a PDF file is one of eight things. This module is the type
 * union for them, plus a thin class for each one that needs behaviour.
 * Nothing here touches bytes; `lexer.ts` and `parser.ts` do that.
 */

/** A name object, written `/Type` in the file. The stored value is decoded. */
export class PdfName {
  constructor(public readonly name: string) {}

  toString(): string {
    return `/${this.name}`;
  }
}

/** An indirect reference, written `7 0 R` in the file. */
export class PdfRef {
  constructor(
    public readonly num: number,
    public readonly gen: number,
  ) {}

  toString(): string {
    return `${this.num} ${this.gen} R`;
  }
}

/**
 * A string object. PDF text strings are bytes, not characters. The encoding is
 * decided elsewhere in the file, so the bytes are kept raw and the helpers
 * below are opt-in interpretations.
 */
export class PdfString {
  constructor(public readonly bytes: Uint8Array) {}

  /** Latin-1, which is what PDFDocEncoding is close enough to for most files. */
  asLatin1(): string {
    let out = "";
    for (const b of this.bytes) out += String.fromCharCode(b);
    return out;
  }

  /** UTF-16BE when the byte-order mark is present, otherwise Latin-1. */
  asText(): string {
    if (this.bytes.length >= 2 && this.bytes[0] === 0xfe && this.bytes[1] === 0xff) {
      let out = "";
      for (let i = 2; i + 1 < this.bytes.length; i += 2) {
        out += String.fromCharCode(((this.bytes[i] as number) << 8) | (this.bytes[i + 1] as number));
      }
      return out;
    }
    return this.asLatin1();
  }

  toString(): string {
    return `(${this.asLatin1()})`;
  }
}

/** A dictionary. Keys are decoded names, without the leading slash. */
export class PdfDict {
  private readonly map = new Map<string, PdfObject>();

  constructor(entries?: Iterable<readonly [string, PdfObject]>) {
    if (entries) for (const [k, v] of entries) this.map.set(k, v);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): PdfObject | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: PdfObject): this {
    this.map.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  entries(): IterableIterator<[string, PdfObject]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, PdfObject]> {
    return this.map.entries();
  }

  /** Resolves a name, reading `null` when the key is missing or is not a name. */
  getName(key: string): string | null {
    const v = this.map.get(key);
    return v instanceof PdfName ? v.name : null;
  }

  getNumber(key: string): number | null {
    const v = this.map.get(key);
    return typeof v === "number" ? v : null;
  }

  getBool(key: string, fallback: boolean): boolean {
    const v = this.map.get(key);
    return typeof v === "boolean" ? v : fallback;
  }

  getArray(key: string): PdfObject[] | null {
    const v = this.map.get(key);
    return Array.isArray(v) ? v : null;
  }

  getDict(key: string): PdfDict | null {
    const v = this.map.get(key);
    return v instanceof PdfDict ? v : null;
  }

  getStream(key: string): PdfStream | null {
    const v = this.map.get(key);
    return v instanceof PdfStream ? v : null;
  }

  setName(key: string, name: string): this {
    this.map.set(key, new PdfName(name));
    return this;
  }

  setNumber(key: string, n: number): this {
    this.map.set(key, n);
    return this;
  }
}

/**
 * A stream object: a dictionary plus the bytes that follow the `stream`
 * keyword. The bytes are kept in their stored, still-encoded form. Decoding
 * happens in `filters.ts`, so a stream can be read without paying for filters
 * the caller does not need.
 */
export class PdfStream {
  constructor(
    public readonly dict: PdfDict,
    public raw: Uint8Array,
  ) {}

  /** The effective length after a successful decode, for streams with one. */
  decodedLength: number | null = null;

  /**
   * Replace the bytes and clear any filter, because the new bytes are not
   * encoded. The caller re-applies a filter if it wants one.
   */
  setPlainData(data: Uint8Array): void {
    this.raw = data;
    this.dict.delete("Filter");
    this.dict.delete("DecodeParms");
    this.dict.delete("DP");
    this.dict.setNumber("Length", data.length);
  }
}

export type PdfObject =
  | null
  | boolean
  | number
  | PdfName
  | PdfString
  | PdfRef
  | PdfObject[]
  | PdfDict
  | PdfStream;

export function isDict(v: unknown): v is PdfDict {
  return v instanceof PdfDict;
}

export function isStream(v: unknown): v is PdfStream {
  return v instanceof PdfStream;
}

export function isName(v: unknown): v is PdfName {
  return v instanceof PdfName;
}

export function isRef(v: unknown): v is PdfRef {
  return v instanceof PdfRef;
}

export function isArray(v: unknown): v is PdfObject[] {
  return Array.isArray(v);
}

export function isNumber(v: unknown): v is number {
  return typeof v === "number";
}
