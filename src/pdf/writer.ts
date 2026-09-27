/**
 * The writer: put a file back together.
 *
 * Two ways to save. A full rewrite emits every object and a fresh index. An
 * incremental save appends only what changed and adds a new index section that
 * points back at the old one. Incremental is the default because it keeps
 * untouched bytes byte-identical, which matters when a document carries a
 * digital signature or a reviewer has already annotated it.
 */

import { encodeHexString, encodeName } from "./parser";
import {
  PdfDict,
  PdfName,
  PdfRef,
  PdfStream,
  PdfString,
  isArray,
  isDict,
  type PdfObject,
} from "./objects";
import { flateEncode } from "./filters";
import type { PdfDocument } from "./document";

export interface SaveOptions {
  /** Append to the source file. Default true when the writer has a source. */
  incremental?: boolean;
  /** Re-deflate streams whose bytes changed. Default false. */
  compress?: boolean;
}

class ByteSink {
  private chunks: Uint8Array[] = [];
  private len = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.len += bytes.length;
  }

  pushStr(s: string): void {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    this.push(out);
  }

  get length(): number {
    return this.len;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.len);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

/** PDF has no exponent notation, so a real number must be written out longhand. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) {
    // `String(1e21)` is "1e+21", which no PDF reader can read back.
    const s = String(n === 0 ? 0 : n);
    return s.includes("e") ? expandExponential(s) : s;
  }
  let s = n.toFixed(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0" || s === "") return "0";
  return s;
}

/** Turn `1.2e+21` into `1200000000000000000000`. */
function expandExponential(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return "0";
  const sign = m[1] ?? "";
  const int = m[2] ?? "0";
  const frac = m[3] ?? "";
  const exp = Number(m[4]);
  const digits = int + frac;
  const pointAt = int.length + exp;
  if (pointAt <= 0) return sign + "0." + "0".repeat(-pointAt) + digits;
  if (pointAt >= digits.length) return sign + digits + "0".repeat(pointAt - digits.length);
  return sign + digits.slice(0, pointAt) + "." + digits.slice(pointAt);
}

const LITERAL_ESCAPES: Record<number, string> = {
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x08: "\\b",
  0x0c: "\\f",
  0x28: "\\(",
  0x29: "\\)",
  0x5c: "\\\\",
};

function escapeLiteral(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of bytes) {
    const esc = LITERAL_ESCAPES[b];
    if (esc) {
      for (const c of esc) out.push(c.charCodeAt(0));
    } else if (b === 0x00 || b < 0x20 || b > 0x7e) {
      out.push(0x5c, 0x30 + ((b >> 6) & 0x07), 0x30 + ((b >> 3) & 0x07), 0x30 + (b & 0x07));
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

export class PdfWriter {
  readonly source: PdfDocument | null;
  private readonly objects = new Map<number, PdfObject>();
  private readonly gens = new Map<number, number>();
  private readonly changed = new Set<number>();
  private next: number;
  private trailerOverrides = new PdfDict();

  constructor(source: PdfDocument | null = null) {
    this.source = source;
    if (source) {
      this.next = source.size || 1;
      if (this.next < 1) this.next = 1;
    } else {
      this.next = 1;
    }
  }

  /** Reserve the next free object number. */
  alloc(): PdfRef {
    const num = this.next++;
    this.gens.set(num, 0);
    this.objects.set(num, null);
    this.changed.add(num);
    return new PdfRef(num, 0);
  }

  set(ref: PdfRef, value: PdfObject): this {
    this.objects.set(ref.num, value);
    this.gens.set(ref.num, ref.gen);
    this.changed.add(ref.num);
    return this;
  }

  /** True when this writer has taken over an object number from the source. */
  owns(num: number): boolean {
    return this.objects.has(num);
  }

  get(ref: PdfRef): PdfObject {
    const local = this.objects.get(ref.num);
    if (local !== undefined) return local;
    return this.source?.getObject(ref.num) ?? null;
  }

  /** The catalog, from the writer's own objects or from the source file. */
  get rootRef(): PdfRef | null {
    if (this.source) {
      const r = this.source.trailer.get("Root");
      if (r instanceof PdfRef) return r;
    }
    return null;
  }

  dict(): PdfDict {
    return new PdfDict();
  }

  /** A stream with the correct `/Length` already set. */
  stream(dict: PdfDict, data: Uint8Array, compress = false): PdfStream {
    const bytes = compress ? flateEncode(data) : data;
    const d = new PdfDict(dict);
    if (compress) {
      d.setName("Filter", "FlateDecode");
      d.setNumber("Length", bytes.length);
    } else {
      d.delete("Filter");
      d.delete("DecodeParms");
      d.delete("DP");
      d.setNumber("Length", bytes.length);
    }
    return new PdfStream(d, bytes);
  }

  /**
   * Build the final bytes. Every object that is written gets an absolute file
   * offset, so the index is only correct after the sink position is known.
   */
  save(opts: SaveOptions = {}): Uint8Array {
    const incremental = opts.incremental ?? this.source !== null;
    const nums = incremental ? [...this.changed].sort((a, b) => a - b) : this.allNumbers();
    if (nums.length === 0 && !incremental) {
      throw new Error("nothing to write: the writer holds no objects");
    }

    const version = this.source?.version && this.source.version !== "unknown" ? this.source.version : "1.7";
    const sink = new ByteSink();
    if (incremental) {
      // An incremental save is an append. The original bytes must be the
      // output's first bytes, unchanged, or the earlier sections it points
      // back at no longer exist.
      if (!this.source) throw new Error("an incremental save needs a source document");
      sink.push(this.source.buf);
    } else {
      sink.pushStr(`%PDF-${version}\n`);
      // A binary comment on line 2 tells transfer tools the file is not text.
      sink.push(encodeBinaryComment());
    }

    const offsets = new Map<number, number>();
    for (const num of nums) {
      const value = this.objects.has(num) ? this.objects.get(num) : this.source?.getObject(num);
      if (value === undefined) continue;
      offsets.set(num, sink.length);
      const gen = this.gens.get(num) ?? 0;
      sink.pushStr(`${num} ${gen} obj\n`);
      this.serialize(sink, value, opts);
      sink.pushStr("\nendobj\n");
    }

    if (offsets.size === 0) throw new Error("no objects resolved to bytes");

    const startxref = sink.length;
    this.writeXrefTable(sink, offsets);

    const trailer = this.buildTrailer(offsets, incremental);
    sink.pushStr("trailer\n");
    this.serialize(sink, trailer, opts);
    sink.pushStr(`\nstartxref\n${startxref}\n%%EOF\n`);
    return sink.toBytes();
  }

  private allNumbers(): number[] {
    const set = new Set<number>([...this.changed]);
    if (this.source) {
      for (const n of this.source.xref.keys()) {
        // Object 0 heads the free list and is never a real object.
        if (n === 0) continue;
        if (this.source.xref.get(n)?.type === 0) continue;
        set.add(n);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  private buildTrailer(offsets: Map<number, number>, incremental: boolean): PdfDict {
    const t = new PdfDict();
    if (this.source) {
      for (const [k, v] of this.source.trailer.entries()) {
        // These describe the index itself, so they are rebuilt below.
        if (k === "Prev" || k === "XRefStm" || k === "Type" || k === "W" || k === "Index" || k === "Length" || k === "Filter") continue;
        t.set(k, v);
      }
      if (this.source.encrypted) t.set("Encrypt", this.source.trailer.get("Encrypt") ?? null);
    }
    for (const [k, v] of this.trailerOverrides.entries()) t.set(k, v);

    let size = 1;
    for (const n of offsets.keys()) size = Math.max(size, n + 1);
    if (this.source) size = Math.max(size, this.source.size);
    t.setNumber("Size", size);

    // A full rewrite has no earlier section. An incremental one points at it.
    if (this.source && this.source.startxref > 0 && incremental) {
      t.setNumber("Prev", this.source.startxref);
    }
    return t;
  }

  /** Group consecutive object numbers into index subsections. */
  private writeXrefTable(sink: ByteSink, offsets: Map<number, number>): void {
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    sink.pushStr("xref\n");
    let i = 0;
    while (i < nums.length) {
      const start = nums[i] as number;
      let run = 1;
      while (i + run < nums.length && (nums[i + run] as number) === start + run) run++;
      sink.pushStr(`${start} ${run}\n`);
      for (let k = 0; k < run; k++) {
        const num = start + k;
        const off = offsets.get(num) as number;
        const gen = this.gens.get(num) ?? 0;
        sink.pushStr(`${off.toString().padStart(10, "0")} ${gen.toString().padStart(5, "0")} n\r\n`);
      }
      i += run;
    }
  }

  /** @internal Used by serializeObject and by the content stream writer. */
  serialize(sink: ByteSink, obj: PdfObject, opts: SaveOptions): void {
    if (obj === null || obj === undefined) {
      sink.pushStr("null");
      return;
    }
    if (typeof obj === "boolean") {
      sink.pushStr(obj ? "true" : "false");
      return;
    }
    if (typeof obj === "number") {
      sink.pushStr(formatNumber(obj));
      return;
    }
    if (obj instanceof PdfName) {
      sink.push(encodeName(obj.name));
      return;
    }
    if (obj instanceof PdfString) {
      // The parentheses are part of the syntax, not part of the data.
      sink.pushStr("(");
      sink.push(escapeLiteral(obj.bytes));
      sink.pushStr(")");
      return;
    }
    if (obj instanceof PdfRef) {
      sink.pushStr(`${obj.num} ${obj.gen} R`);
      return;
    }
    if (isArray(obj)) {
      sink.pushStr("[");
      obj.forEach((v, i) => {
        if (i > 0) sink.pushStr(" ");
        this.serialize(sink, v, opts);
      });
      sink.pushStr("]");
      return;
    }
    if (obj instanceof PdfStream) {
      this.serializeStream(sink, obj, opts);
      return;
    }
    if (isDict(obj)) {
      this.serializeDict(sink, obj, opts);
      return;
    }
    sink.pushStr("null");
  }

  private serializeDict(sink: ByteSink, dict: PdfDict, opts: SaveOptions): void {
    sink.pushStr("<<");
    for (const [k, v] of dict.entries()) {
      sink.pushStr(" ");
      sink.push(encodeName(k));
      sink.pushStr(" ");
      this.serialize(sink, v, opts);
    }
    sink.pushStr(dict.size === 0 ? ">>" : " >>");
  }

  private serializeStream(sink: ByteSink, stream: PdfStream, opts: SaveOptions): void {
    let raw = stream.raw;
    const filterName = stream.dict.getName("Filter");

    // Bytes changed and the old filter no longer describes them.
    const declared = stream.dict.getNumber("Length");
    if (opts.compress && !filterName && raw.length > 0) {
      const encoded = flateEncode(raw);
      if (encoded.length < raw.length) {
        stream.dict.setName("Filter", "FlateDecode");
        raw = encoded;
      }
    }

    // A direct `/Length` is always correct, and safer than a stale reference.
    stream.dict.setNumber("Length", raw.length);
    if (declared !== null && declared !== raw.length) {
      stream.dict.delete("DecodeParms");
    }

    this.serializeDict(sink, stream.dict, opts);
    sink.pushStr("\nstream\n");
    sink.push(raw);
    sink.pushStr("\nendstream");
  }

  setTrailerValue(key: string, value: PdfObject): this {
    this.trailerOverrides.set(key, value);
    return this;
  }
}

function encodeBinaryComment(): Uint8Array {
  // Four bytes above 127 mark the file as binary for transfer tools.
  return Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a);
}

/** Serialize a single object to bytes. Used by the content stream writer. */
export function serializeObject(obj: PdfObject): Uint8Array {
  const sink = new ByteSink();
  new PdfWriter().serialize(sink, obj, {});
  return sink.toBytes();
}

export { encodeHexString };
