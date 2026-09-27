/**
 * The document: find the cross-reference data, then resolve objects.
 *
 * This is the part of a PDF reader that deals with the fact that a PDF is a
 * file that gets edited by appending to it. There is no single index. There is
 * a chain of index sections, the newest one wins, and the offsets in the older
 * ones are often wrong because an earlier save moved the bytes.
 */

import { Lexer, latin1 } from "./lexer";
import { parseIndirectObjectAt, parseObject, PdfError } from "./parser";
import {
  PdfDict,
  PdfRef,
  PdfStream,
  isArray,
  isName,
  isStream,
  type PdfObject,
} from "./objects";
import {
  applyPredictor,
  ascii85Decode,
  asciiHexDecode,
  flateDecode,
  isImageFilter,
  lzwDecode,
  runLengthDecode,
} from "./filters";

/** What a cross-reference entry points at. */
export interface XrefEntry {
  type: 0 | 1 | 2;
  /** type 1: byte offset of the object. */
  offset?: number;
  /** type 1: generation number. */
  gen?: number;
  /** type 2: the object number of the object stream holding it. */
  container?: number;
  /** type 2: its index inside that object stream. */
  index?: number;
}

const FILTER_ALIASES: Record<string, string> = {
  FlateDecode: "FlateDecode",
  Fl: "FlateDecode",
  LZWDecode: "LZWDecode",
  LZW: "LZWDecode",
  ASCIIHexDecode: "ASCIIHexDecode",
  AHx: "ASCIIHexDecode",
  ASCII85Decode: "ASCII85Decode",
  A85: "ASCII85Decode",
  RunLengthDecode: "RunLengthDecode",
  RL: "RunLengthDecode",
  Crypt: "Crypt",
};

export interface DecodedStream {
  data: Uint8Array;
  /** Set when the bytes are already an image file, e.g. after DCTDecode. */
  imageCodec: string | null;
}

export interface Repair {
  code: string;
  detail: string;
}

export class PdfDocument {
  readonly buf: Uint8Array;
  readonly xref = new Map<number, XrefEntry>();
  trailer = new PdfDict();
  readonly repairs: Repair[] = [];
  readonly sectionsRead: number[] = [];

  version = "1.7";
  /** Where the newest cross-reference section is, needed to append a new one. */
  startxref = 0;
  /** Highest `/Size` seen, or the highest object number plus one. */
  size = 0;
  encrypted = false;
  encryptionFilter: string | null = null;

  private readonly cache = new Map<number, PdfObject>();
  private readonly objStmCache = new Map<number, Map<number, PdfObject>>();
  private readonly offsetCache = new Map<number, number>();

  private constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  static parse(buf: Uint8Array): PdfDocument {
    const doc = new PdfDocument(buf);
    doc.version = readVersion(buf);
    const startxref = findLastStartXref(buf);
    doc.startxref = startxref;
    if (startxref >= 0) {
      doc.readXrefChain(startxref);
    } else {
      doc.repairs.push({ code: "no-startxref", detail: "no startxref keyword in the tail" });
    }
    doc.finish();
    return doc;
  }

  /** Fill in whatever the cross-reference data failed to provide. */
  private finish(): void {
    // An object stream can hold objects whose entries are only in the newest
    // section. Reading them tells us the true object numbers.
    for (const entry of [...this.xref.values()]) {
      if (entry.type === 2) this.loadObjectStream(entry.container as number);
    }

    // Highest object number, so callers can show a real count.
    let max = 0;
    for (const [num, entry] of this.xref) {
      if (entry.type === 1) max = Math.max(max, num);
      else if (entry.type === 2) max = Math.max(max, num);
    }
    for (const num of this.objStmCache.keys()) {
      for (const inner of this.objStmCache.get(num)!.keys()) max = Math.max(max, inner);
    }
    this.size = this.trailer.getNumber("Size") ?? max + 1;

    const enc = this.trailer.get("Encrypt");
    if (enc !== undefined && enc !== null) {
      this.encrypted = true;
      const d = isStream(enc) ? enc.dict : enc instanceof PdfDict ? enc : null;
      this.encryptionFilter = d?.getName("Filter") ?? null;
    }

    if (this.trailer.get("Root") === undefined) {
      this.repair();
    }
  }

  // ---------------------------------------------------------------- xref chain

  private readXrefChain(start: number): void {
    const seen = new Set<number>();
    let offset: number | undefined = start;
    while (offset !== undefined && offset >= 0 && !seen.has(offset)) {
      seen.add(offset);
      this.sectionsRead.push(offset);
      const next = this.readXrefSection(offset);
      offset = next;
    }
  }

  /** Read one section. Returns the offset of the previous section, if any. */
  private readXrefSection(offset: number): number | undefined {
    const lex = new Lexer(this.buf, offset);
    const first = lex.nextToken();

    if (first.type === "keyword" && first.value === "xref") {
      this.readXrefTable(lex);
      lex.skipWhite();
      const t = lex.nextToken();
      if (t.type === "keyword" && t.value === "trailer") {
        const tr = parseObject(lex);
        if (tr instanceof PdfDict) this.mergeTrailer(tr);
      }
      // A hybrid file also points at an xref stream for the compressed objects.
      const stm = this.trailer.get("XRefStm");
      if (isNumberLike(stm) && !seenOffset(this.sectionsRead, stm)) {
        this.sectionsRead.push(stm);
        this.readXrefStreamSection(stm, true);
      }
      const prev = this.trailer.get("Prev");
      return isNumberLike(prev) ? prev : undefined;
    }

    if (offset < this.buf.length) {
      this.readXrefStreamSection(offset, false);
      const prev = this.trailer.get("Prev");
      return isNumberLike(prev) ? prev : undefined;
    }
    return undefined;
  }

  private readXrefTable(lex: Lexer): void {
    for (;;) {
      lex.skipWhite();
      const save = lex.pos;
      const t1 = lex.nextToken();
      if (t1.type === "keyword" && t1.value === "trailer") {
        // Rewind, so the caller reads the keyword and the dictionary itself.
        lex.pos = save;
        return;
      }
      const t2 = lex.nextToken();
      if (t1.type !== "num" || t2.type !== "num") {
        lex.pos = save;
        return;
      }
      const start = t1.value as number;
      const count = t2.value as number;
      for (let i = 0; i < count; i++) {
        const e = this.readXrefTableEntry(lex);
        if (!e) return;
        this.putEntry(start + i, e, false);
      }
    }
  }

  /**
   * An entry is a fixed 20-byte record: ten digits, a space, five digits, a
   * space, the letter, then two end-of-line bytes. Reading it by byte offset
   * instead of by token keeps the table in step even when a record is odd.
   */
  private readXrefTableEntry(lex: Lexer): XrefEntry | null {
    // Whitespace of every kind can sit before a record, because the subsection
    // header ends on a line break. Skipping only spaces shifts every entry.
    let i = lex.pos;
    while (i < this.buf.length && isSpaceByte(this.buf[i] as number)) i++;

    if (i + 18 > this.buf.length) return null;
    const digits = latin1(this.buf.subarray(i, i + 10));
    const gen = latin1(this.buf.subarray(i + 11, i + 16));
    if (!/^\d{10}$/.test(digits) || !/^\d{5}$/.test(gen)) {
      // Not a record. Step over the line and treat the slot as free, so one
      // odd record does not abandon the rest of the table.
      const nl = this.buf.indexOf(0x0a, i);
      if (nl < 0) return null;
      lex.pos = nl + 1;
      return { type: 0 };
    }
    const kind = this.buf[i + 17];
    let j = i + 18;
    while (j < this.buf.length && isSpaceByte(this.buf[j] as number)) j++;
    lex.pos = j;
    if (kind === 0x6e /* n */) {
      return { type: 1, offset: Number(digits), gen: Number(gen) };
    }
    return { type: 0 };
  }

  private readXrefStreamSection(offset: number, hybrid: boolean): void {
    const ind = parseIndirectObjectAt(this.buf, offset);
    if (!ind || !isStream(ind.value)) {
      this.repairs.push({
        code: hybrid ? "bad-xrefstm" : "bad-xref-section",
        detail: `no xref stream at offset ${offset}`,
      });
      return;
    }
    const stream = ind.value;
    const d = stream.dict;
    if (d.getName("Type") !== "XRef") {
      this.repairs.push({
        code: hybrid ? "bad-xrefstm" : "bad-xref-section",
        detail: `object ${ind.num} at offset ${offset} is not an xref stream`,
      });
      return;
    }
    if (d.get("Root") || d.get("Prev") || d.get("XRefStm")) this.mergeTrailer(d);
    else this.mergeTrailer(d);

    const wArr = d.getArray("W") ?? [];
    const w = wArr.filter((v): v is number => typeof v === "number");
    if (w.length === 0) return;
    const entryWidth = w.reduce((a, b) => a + b, 0);
    const data = this.streamBytes(stream);
    if (data.length < entryWidth) return;

    const size = d.getNumber("Size") ?? 0;
    const indexArr = d.getArray("Index");
    const index: number[] = indexArr
      ? indexArr.filter((v): v is number => typeof v === "number")
      : [0, size];

    let p = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = index[s] as number;
      const count = index[s + 1] as number;
      for (let i = 0; i < count; i++) {
        if (p + entryWidth > data.length) return;
        const fields: number[] = [];
        for (const width of w) {
          let v = 0;
          for (let k = 0; k < width; k++) v = (v << 8) | (data[p + k] as number);
          p += width;
          fields.push(v);
        }
        const type = w[0] === 0 ? (start === 0 && i === 0 ? 0 : 1) : (fields[0] as number);
        const objNum = start + i;
        if (type === 1) {
          this.putEntry(objNum, { type: 1, offset: fields[1] as number, gen: fields[2] ?? 0 }, false);
        } else if (type === 2) {
          this.putEntry(
            objNum,
            { type: 2, container: fields[1] as number, index: fields[2] as number },
            hybrid,
          );
        } else {
          this.putEntry(objNum, { type: 0 }, hybrid);
        }
      }
    }
  }

  /** Newer sections were read first, so an existing entry wins. */
  private putEntry(num: number, entry: XrefEntry, overrideFree: boolean): void {
    const existing = this.xref.get(num);
    if (existing) {
      // A hybrid xref stream only supplies the entries the table marked free.
      if (!overrideFree) return;
      if (existing.type !== 0) return;
    }
    this.xref.set(num, entry);
  }

  private mergeTrailer(d: PdfDict): void {
    for (const [k, v] of d.entries()) {
      if (!this.trailer.has(k)) this.trailer.set(k, v);
    }
  }

  // ------------------------------------------------------------------- repair

  /**
   * Rebuild the index from the file itself. Triggered when the trailer is gone
   * or when a lookup misses, which is how a truncated or hand-edited file is
   * recovered instead of throwing.
   */
  repair(): void {
    const before = this.xref.size;
    this.repairs.push({
      code: "rebuilt-xref",
      detail: `scanned the file for object headers; ${before} indexed entries replaced`,
    });
    this.xref.clear();
    this.cache.clear();
    this.objStmCache.clear();

    // Every `N G obj` in the file, in file order. A later hit is a newer
    // revision, so it overwrites.
    const bytes = this.buf;
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] !== 0x6f || bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) continue; // 'obj'
      if (i + 3 < bytes.length && !isWhiteOrDelim(bytes[i + 3] as number)) continue;
      let j = i - 1;
      while (j >= 0 && isWhiteOrDelim(bytes[j] as number)) j--;
      const genEnd = j + 1;
      while (j >= 0 && isDigit(bytes[j] as number)) j--;
      if (j === genEnd - 1) continue;
      const gen = Number(latin1(bytes.subarray(j + 1, genEnd)));
      while (j >= 0 && isWhiteOrDelim(bytes[j] as number)) j--;
      const numEnd = j + 1;
      while (j >= 0 && isDigit(bytes[j] as number)) j--;
      if (j === numEnd - 1) continue;
      const num = Number(latin1(bytes.subarray(j + 1, numEnd)));
      if (!Number.isFinite(num)) continue;
      this.xref.set(num, { type: 1, offset: this.findObjStart(j + 1), gen });
    }

    // The newest trailer dict wins for each key.
    for (let i = bytes.length - 7; i >= 0; i--) {
      if (latin1(bytes.subarray(i, i + 7)) !== "trailer") continue;
      const ind = parseIndirectObjectAt(bytes, 0);
      void ind;
      const lex = new Lexer(bytes, i + 7);
      try {
        const d = parseObject(lex);
        if (d instanceof PdfDict) this.mergeTrailer(d);
      } catch {
        // A damaged trailer is skipped; the scan below can still find Root.
      }
      break;
    }

    if (!this.trailer.get("Root")) {
      for (const num of this.xref.keys()) {
        const o = this.tryGetObject(num);
        if (o instanceof PdfStream && o.dict.getName("Type") === "XRef") this.mergeTrailer(o.dict);
        else if (o instanceof PdfDict && o.getName("Type") === "Catalog") {
          this.trailer.set("Root", new PdfRef(num, 0));
        }
      }
    }
  }

  private findObjStart(from: number): number {
    let i = from;
    while (i < this.buf.length && isWhiteOrDelim(this.buf[i] as number)) i++;
    return i;
  }

  // ------------------------------------------------------------------ objects

  getObject(num: number): PdfObject {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    const entry = this.xref.get(num);
    // A free entry is not a broken offset, it is the free list. Rebuilding the
    // index for one would throw away every edit made to the object cache.
    if (!entry || entry.type === 0) return null;
    const value = this.tryGetObject(num);
    if (value === undefined) {
      // An offset that points at nothing is the commonest real-world damage.
      this.repair();
      const retried = this.tryGetObject(num);
      if (retried === undefined) return null;
      this.cache.set(num, retried);
      return retried;
    }
    this.cache.set(num, value);
    return value;
  }

  private tryGetObject(num: number): PdfObject | undefined {
    const entry = this.xref.get(num);
    if (!entry) return undefined;
    if (entry.type === 2) {
      const table = this.loadObjectStream(entry.container as number);
      const inner = table?.get(num);
      return inner === undefined ? undefined : inner;
    }
    if (entry.type !== 1 || entry.offset === undefined) return undefined;
    const off = entry.offset;
    if (off < 0 || off >= this.buf.length) return undefined;
    let ind = parseIndirectObjectAt(this.buf, off);
    if (!ind) {
      const alt = this.offsetCache.get(num);
      if (alt !== undefined) ind = parseIndirectObjectAt(this.buf, alt);
    }
    if (!ind) return undefined;
    this.offsetCache.set(num, off);
    return ind.value;
  }

  private loadObjectStream(num: number | undefined): Map<number, PdfObject> | null {
    if (num === undefined) return null;
    const hit = this.objStmCache.get(num);
    if (hit) return hit;
    const raw = this.getObject(num);
    if (!isStream(raw) || raw.dict.getName("Type") !== "ObjStm") return null;
    const data = this.streamBytes(raw);
    const n = raw.dict.getNumber("N") ?? 0;
    const first = raw.dict.getNumber("First") ?? 0;

    const header = new Lexer(data, 0);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const a = header.nextToken();
      const b = header.nextToken();
      if (a.type !== "num" || b.type !== "num") break;
      pairs.push([a.value as number, b.value as number]);
    }

    const table = new Map<number, PdfObject>();
    for (const [objNum, relOff] of pairs) {
      const at = first + relOff;
      if (at < 0 || at >= data.length) continue;
      const lex = new Lexer(data, at);
      try {
        table.set(objNum, parseObject(lex));
      } catch {
        // Skip an object we cannot read rather than losing the whole stream.
      }
    }
    this.objStmCache.set(num, table);
    for (const [objNum] of pairs) {
      if (!this.xref.has(objNum)) this.xref.set(objNum, { type: 2, container: num, index: 0 });
    }
    return table;
  }

  /** Follow indirect references until a direct object is reached. */
  resolve(value: PdfObject, depth = 0): PdfObject {
    let v = value;
    let d = depth;
    while (v instanceof PdfRef && d < 64) {
      v = this.getObject(v.num);
      d++;
    }
    return v;
  }

  getDict(value: PdfObject): PdfDict | null {
    const r = this.resolve(value);
    return r instanceof PdfDict ? r : null;
  }

  getStreamData(stream: PdfStream): DecodedStream {
    return this.decodeStreamData(stream);
  }

  /** Decoded bytes only, for callers that do not care about image codecs. */
  streamBytes(stream: PdfStream): Uint8Array {
    return this.decodeStreamData(stream).data;
  }

  /**
   * Run a stream through its filter chain. `/DecodeParms` is positional, so
   * parm n belongs to filter n. An image codec ends the chain, because the
   * bytes after it are already an encoded image.
   */
  private decodeStreamData(stream: PdfStream): DecodedStream {
    const filterObj = stream.dict.get("Filter");
    const filters: string[] = [];
    const source: PdfObject[] = isArray(filterObj) ? filterObj : filterObj == null ? [] : [filterObj];
    for (const f of source) {
      const r = this.resolve(f);
      if (isName(r)) filters.push(FILTER_ALIASES[r.name] ?? r.name);
    }

    const parmObj = stream.dict.get("DecodeParms") ?? stream.dict.get("DP") ?? null;
    const parms: (PdfDict | null)[] = [];
    if (isArray(parmObj)) {
      for (const p of parmObj) {
        const r = this.resolve(p);
        parms.push(r instanceof PdfDict ? r : null);
      }
    } else {
      const r = this.resolve(parmObj);
      parms.push(r instanceof PdfDict ? r : null);
    }

    let data = stream.raw;
    for (let i = 0; i < filters.length; i++) {
      const name = filters[i] as string;
      if (name === "Crypt") continue;
      if (isImageFilter(name)) {
        return { data, imageCodec: name };
      }
      try {
        switch (name) {
          case "FlateDecode":
            data = flateDecode(data);
            break;
          case "LZWDecode":
            data = lzwDecode(data, parms[i]?.getNumber("EarlyChange") ?? 1);
            break;
          case "ASCIIHexDecode":
            data = asciiHexDecode(data);
            break;
          case "ASCII85Decode":
            data = ascii85Decode(data);
            break;
          case "RunLengthDecode":
            data = runLengthDecode(data);
            break;
          default:
            // An unknown filter leaves the bytes alone rather than losing them.
            break;
        }
      } catch (err) {
        this.repairs.push({
          code: `filter-failed:${name}`,
          detail: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      data = applyPredictor(data, parms[i] ?? null);
    }
    stream.decodedLength = data.length;
    return { data, imageCodec: null };
  }

  // -------------------------------------------------------------- convenience

  get catalog(): PdfDict | null {
    const root = this.resolve(this.trailer.get("Root") ?? null);
    if (root instanceof PdfDict) return root;
    for (const num of this.xref.keys()) {
      const o = this.getObject(num);
      if (o instanceof PdfDict && o.getName("Type") === "Catalog") return o;
    }
    return null;
  }

  get info(): PdfDict | null {
    const i = this.resolve(this.trailer.get("Info") ?? null);
    return i instanceof PdfDict ? i : null;
  }

  /** Count the pages by walking the page tree, which is the only honest count. */
  getPageCount(): number {
    const cat = this.catalog;
    const pagesRef = cat?.get("Pages") ?? null;
    return this.walkPageTree(pagesRef, 0, new Set()).count;
  }

  walkPageTree(
    node: PdfObject,
    depth: number,
    seen: Set<number>,
  ): { count: number; pageRefs: PdfRef[]; depths: number[] } {
    if (depth > 64 || seen.size > 4096) return { count: 0, pageRefs: [], depths: [] };
    if (node instanceof PdfRef) {
      if (seen.has(node.num)) return { count: 0, pageRefs: [], depths: [] };
      seen.add(node.num);
    }
    const dict = this.resolve(node);
    if (!(dict instanceof PdfDict)) return { count: 0, pageRefs: [], depths: [] };
    const type = dict.getName("Type");
    const kidsObj = dict.get("Kids");
    if (type === "Page" || !isArray(kidsObj)) {
      const count = dict.getNumber("Count") ?? (type === "Page" ? 1 : 0);
      if (count > 0 && type !== "Page") {
        return { count, pageRefs: [], depths: [] };
      }
      return {
        count: 1,
        pageRefs: node instanceof PdfRef ? [node] : [],
        depths: [depth],
      };
    }
    let count = 0;
    const pageRefs: PdfRef[] = [];
    const depths: number[] = [];
    for (const kid of kidsObj) {
      const sub = this.walkPageTree(kid, depth + 1, seen);
      count += sub.count;
      pageRefs.push(...sub.pageRefs);
      depths.push(...sub.depths);
    }
    return { count, pageRefs, depths };
  }

  /** Every object that resolved, for the structure view in the UI. */
  inventory(): Array<{ num: number; type: string; subtype: string | null; kind: XrefEntry["type"] }> {
    const out: Array<{ num: number; type: string; subtype: string | null; kind: XrefEntry["type"] }> = [];
    const nums = [...this.xref.keys()].sort((a, b) => a - b);
    for (const num of nums) {
      const entry = this.xref.get(num) as XrefEntry;
      const obj = this.getObject(num);
      let type = "scalar";
      let subtype: string | null = null;
      if (obj instanceof PdfDict) {
        type = "dict";
        subtype = obj.getName("Type");
      } else if (obj instanceof PdfStream) {
        type = "stream";
        subtype = obj.dict.getName("Type");
      } else if (isArray(obj)) {
        type = "array";
      } else if (obj === null) {
        type = "null";
      }
      out.push({ num, type, subtype, kind: entry.type });
    }
    return out;
  }
}

// ------------------------------------------------------------------- helpers

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isSpaceByte(c: number): boolean {
  return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function isWhiteOrDelim(c: number): boolean {
  return (
    c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20 ||
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
    c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  );
}

function isNumberLike(v: PdfObject | undefined): v is number {
  return typeof v === "number";
}

function seenOffset(list: number[], value: number): boolean {
  return list.includes(value);
}

function readVersion(buf: Uint8Array): string {
  const head = latin1(buf.subarray(0, Math.min(1024, buf.length)));
  const m = /%PDF-(\d+\.\d+)/.exec(head);
  return m?.[1] ?? "unknown";
}

/** Find the last `startxref` in the file, searching backwards. */
function findLastStartXref(buf: Uint8Array): number {
  const tailStart = Math.max(0, buf.length - 2048);
  const tail = latin1(buf.subarray(tailStart));
  const at = tail.lastIndexOf("startxref");
  if (at < 0) return -1;
  const lex = new Lexer(buf, tailStart + at + 9);
  const t = lex.nextToken();
  return t.type === "num" ? (t.value as number) : -1;
}

export { PdfError };
