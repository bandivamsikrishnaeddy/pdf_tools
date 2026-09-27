/**
 * The page tree.
 *
 * Pages live in a tree, not a list. A node can hold other nodes or pages, and
 * attributes such as `/MediaBox` and `/Resources` are inherited from the
 * nearest ancestor that sets them. Any edit that ignores that inheritance
 * produces a file that renders differently in another reader, so the tree is
 * always read as a tree here, never flattened to an array.
 */

import { Matrix } from "./graphics";
import { ContentStream, Resources, extractText, type TextResult } from "./content-stream";
import {
  PdfDict,
  PdfName,
  PdfRef,
  PdfString,
  isArray,
  isDict,
  isStream,
  type PdfObject,
} from "./objects";
import type { PdfDocument } from "./document";
import type { PdfWriter } from "./writer";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Slot {
  parentRef: PdfRef | null;
  parent: PdfDict;
  kidIndex: number;
}

export interface OutlineNode {
  title: string;
  pageIndex: number | null;
  children: OutlineNode[];
}

export class PageTree {
  constructor(
    readonly doc: PdfDocument,
    readonly writer: PdfWriter,
  ) {}

  /**
   * Resolve through the writer first. A page the writer has just allocated is
   * not in the document's index yet, and looking only at the document would
   * make a newly inserted page invisible to the very tree that inserted it.
   */
  private resolve(value: PdfObject): PdfObject {
    if (value instanceof PdfRef && this.writer.owns(value.num)) {
      return this.writer.get(value);
    }
    return this.doc.resolve(value);
  }

  /** The `/Pages` node under the catalog. */
  get root(): PdfDict | null {
    const cat = this.doc.catalog;
    const pages = cat ? this.resolve(cat.get("Pages") ?? null) : null;
    return isDict(pages) ? pages : null;
  }

  get rootRef(): PdfRef | null {
    const cat = this.doc.catalog;
    if (!cat) return null;
    const ref = cat.get("Pages");
    return ref instanceof PdfRef ? ref : null;
  }

  get count(): number {
    const root = this.root;
    if (!root) return 0;
    const n = root.getNumber("Count");
    if (n !== null) return n;
    return this.slots().length;
  }

  /** One slot per page, in reading order. */
  private slots(): Slot[] {
    const out: Slot[] = [];
    const seen = new Set<number>();
    const root = this.root;
    if (!root) return out;
    const visit = (node: PdfObject, depth: number): void => {
      if (depth > 64) return;
      if (node instanceof PdfRef) {
        if (seen.has(node.num)) return;
        seen.add(node.num);
      }
      const dict = this.resolve(node);
      if (!isDict(dict)) return;
      const kids = this.resolve(dict.get("Kids") ?? null);
      if (!isArray(kids)) {
        out.push({ parentRef: null, parent: dict, kidIndex: out.length });
        return;
      }
      kids.forEach((kid, i) => {
        const kd = this.resolve(kid);
        if (isDict(kd) && kd.getName("Type") === "Page") {
          out.push({
            parentRef: node instanceof PdfRef ? node : null,
            parent: dict,
            kidIndex: i,
          });
          return;
        }
        // A middle node: record its first leaf slot position later, so a leaf
        // insert lands in the right subtree rather than always in the root.
        visit(kid, depth + 1);
      });
    };
    visit(rootRefOf(root) ?? root, 0);
    return out;
  }

  /** The page dictionary at an index, or null. */
  getPage(index: number): PdfDict | null {
    const ref = this.pageRef(index);
    if (!ref) return null;
    const d = this.resolve(ref);
    return isDict(d) ? d : null;
  }

  pageRef(index: number): PdfRef | null {
    const all = this.pageRefs();
    return all[index] ?? null;
  }

  /** Every page reference in reading order. */
  pageRefs(): PdfRef[] {
    const out: PdfRef[] = [];
    const seen = new Set<number>();
    const root = this.root;
    if (!root) return out;
    const visit = (node: PdfObject, depth: number): void => {
      if (depth > 64) return;
      if (node instanceof PdfRef) {
        if (seen.has(node.num)) return;
        seen.add(node.num);
      }
      const dict = this.resolve(node);
      if (!isDict(dict)) return;
      const kids = this.resolve(dict.get("Kids") ?? null);
      if (isArray(kids)) {
        for (const kid of kids) visit(kid, depth + 1);
        return;
      }
      if (node instanceof PdfRef) out.push(node);
    };
    visit(this.rootRef ?? root, 0);
    return out;
  }

  /**
   * Read an attribute the way a viewer does: the page first, then each
   * ancestor in turn, and the first value found wins.
   */
  inherited(index: number, key: string): PdfObject | null {
    const chain: PdfDict[] = [];
    const seen = new Set<number>();
    const collect = (node: PdfObject, depth: number): void => {
      if (depth > 64) return;
      if (node instanceof PdfRef) {
        if (seen.has(node.num)) return;
        seen.add(node.num);
      }
      const dict = this.resolve(node);
      if (!isDict(dict)) return;
      chain.push(dict);
      const kids = this.resolve(dict.get("Kids") ?? null);
      if (isArray(kids)) {
        let pos = 0;
        for (const kid of kids) {
          const kd = this.resolve(kid);
          const n = isDict(kd) ? (kd.getNumber("Count") ?? 1) : 1;
          if (index >= pos && index < pos + n) {
            collect(kid, depth + 1);
            return;
          }
          pos += n;
        }
      }
    };
    collect(this.rootRef ?? this.root, 0);

    for (let i = chain.length - 1; i >= 0; i--) {
      // Nearest ancestor first: the page overrides anything it inherits. The
      // value is resolved, because an inherited key is very often an indirect
      // reference, and a caller asking for the effective box or resource
      // dictionary wants the object, not the pointer to it.
      const v = (chain[i] as PdfDict).get(key);
      if (v !== undefined && v !== null) return this.resolve(v);
    }
    return null;
  }

  resources(index: number): Resources {
    const res = this.inherited(index, "Resources");
    const dict = isDict(res) ? res : null;
    return new Resources(this.doc, dict);
  }

  mediaBox(index: number): Rect {
    return this.boxOf(this.inherited(index, "MediaBox")) ?? { x0: 0, y0: 0, x1: 612, y1: 792 };
  }

  cropBox(index: number): Rect {
    return this.boxOf(this.inherited(index, "CropBox")) ?? this.mediaBox(index);
  }

  rotation(index: number): number {
    const r = this.inherited(index, "Rotate");
    const v = typeof r === "number" ? r : 0;
    return ((Math.round(v / 90) * 90) % 360 + 360) % 360;
  }

  private boxOf(value: PdfObject | null): Rect | null {
    const arr = isArray(value) ? value : null;
    if (!arr || arr.length < 4) return null;
    const n = arr.map((v) => (typeof v === "number" ? v : 0));
    const x0 = Math.min(n[0] as number, n[2] as number);
    const y0 = Math.min(n[1] as number, n[3] as number);
    const x1 = Math.max(n[0] as number, n[2] as number);
    const y1 = Math.max(n[1] as number, n[3] as number);
    return { x0, y0, x1, y1 };
  }

  /**
   * The transform from PDF user space to screen space, where y grows downward
   * and the page sits in the positive quadrant. It folds in the page origin,
   * `/Rotate` and the scale, so a caller can place a point the engine reported
   * without knowing any of that.
   */
  displayMatrix(index: number, scale = 1): { matrix: Matrix; width: number; height: number } {
    const box = this.cropBox(index);
    const rot = this.rotation(index);
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const swap = rot === 90 || rot === 270;

    // `concat(a, b)` applies a to a point first, then b.
    let m = Matrix.translation(-box.x0, -box.y0);
    m = Matrix.concat(m, Matrix.scaling(1, -1)); // PDF y grows up, screen y grows down
    m = Matrix.concat(m, Matrix.translation(0, h)); // move the flipped page back to 0
    if (rot !== 0) m = Matrix.concat(m, Matrix.rotation(rot));
    // A quarter turn pushes content out of the positive quadrant, so shift it
    // back by the dimension it crossed.
    if (rot === 90) m = Matrix.concat(m, Matrix.translation(h, 0));
    else if (rot === 180) m = Matrix.concat(m, Matrix.translation(w, h));
    else if (rot === 270) m = Matrix.concat(m, Matrix.translation(0, w));
    m = Matrix.concat(m, Matrix.scaling(scale, scale));

    return { matrix: m, width: (swap ? h : w) * scale, height: (swap ? w : h) * scale };
  }

  // ------------------------------------------------------------- content

  /** The page's content streams joined, which is what a viewer executes. */
  contentOf(index: number): ContentStream {
    const page = this.getPage(index);
    if (!page) return new ContentStream();
    const parts: Uint8Array[] = [];
    const contents = this.resolve(page.get("Contents") ?? null);
    if (isStream(contents)) parts.push(this.doc.streamBytes(contents));
    else if (isArray(contents)) {
      for (const c of contents) {
        const s = this.resolve(c);
        if (isStream(s)) {
          parts.push(this.doc.streamBytes(s));
          parts.push(new Uint8Array([0x0a]));
        }
      }
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    return ContentStream.parse(joined);
  }

  /** Replace the page's content with one new stream. */
  setContent(index: number, bytes: Uint8Array): void {
    const page = this.getPage(index);
    if (!page) return;
    const ref = this.writer.alloc();
    const stream = this.writer.stream(new PdfDict(), bytes);
    this.writer.set(ref, stream);
    page.set("Contents", ref);
  }

  textOf(index: number, scale = 1): TextResult {
    const { matrix } = this.displayMatrix(index, scale);
    return extractText(this.contentOf(index), this.resources(index), matrix);
  }

  // ------------------------------------------------------------ mutations

  /** Append a blank page of a given size, and return its index. */
  insertBlank(at: number, width = 595.28, height = 841.89): number {
    const ref = this.writer.alloc();
    const dict = new PdfDict();
    dict.setName("Type", "Page");
    dict.set("MediaBox", [0, 0, width, height]);
    dict.set("Resources", new PdfDict());
    dict.set("Parent", this.rootRef ?? null);
    const content = this.writer.alloc();
    this.writer.set(content, this.writer.stream(new PdfDict(), new Uint8Array([0x0a])));
    dict.set("Contents", content);
    this.writer.set(ref, dict);
    this.insertRef(at, ref);
    return at;
  }

  /** Insert a deep copy of an existing page. */
  insertCopy(at: number, sourceIndex: number): number {
    const src = this.getPage(sourceIndex);
    if (!src) return this.insertBlank(at);
    const ref = this.writer.alloc();
    const copy = new PdfDict();
    for (const [k, v] of src.entries()) {
      if (k === "Parent" || k === "Type") continue;
      copy.set(k, v);
    }
    copy.setName("Type", "Page");
    copy.set("Parent", this.rootRef ?? null);
    this.writer.set(ref, copy);
    this.insertRef(at, ref);
    return at;
  }

  private insertRef(at: number, ref: PdfRef): void {
    const all = this.pageRefs();
    const clamped = Math.max(0, Math.min(at, all.length));
    const root = this.root;
    if (!root) return;

    // In a flat tree the root is the only parent, which is the common case.
    const kids = this.resolve(root.get("Kids") ?? null);
    if (isArray(kids) && kids.length === all.length) {
      // Splice the reference, not the dictionary. A page belongs in the tree
      // by reference so one page can be shared and so the tree stays uniform.
      kids.splice(clamped, 0, ref);
      this.writeKids(root, kids);
    } else {
      const slots = this.slots();
      const target = slots[clamped];
      const parent = target ? target.parent : root;
      const parentKids = this.resolve(parent.get("Kids") ?? null);
      if (isArray(parentKids)) {
        const at2 = target ? target.kidIndex : parentKids.length;
        parentKids.splice(at2, 0, ref);
        this.writeKids(parent, parentKids);
      }
    }
    this.commit();
  }

  private writeKids(node: PdfDict, kids: PdfObject[]): void {
    node.set("Kids", kids);
  }

  /** Delete pages by index, highest first so the earlier indices stay valid. */
  remove(indices: number[]): number {
    const sorted = [...new Set(indices)].filter((i) => i >= 0).sort((a, b) => b - a);
    let removed = 0;
    for (const index of sorted) {
      const slots = this.slots();
      const slot = slots[index];
      if (!slot) continue;
      const kids = this.resolve(slot.parent.get("Kids") ?? null);
      if (!isArray(kids)) continue;
      kids.splice(slot.kidIndex, 1);
      this.writeKids(slot.parent, kids);
      removed++;
    }
    if (removed > 0) this.commit();
    return removed;
  }

  /** Move the page at `from` so it sits at index `to`. */
  move(from: number, to: number): void {
    const all = this.pageRefs();
    if (from < 0 || from >= all.length) return;
    const target = Math.max(0, Math.min(to, all.length - 1));
    if (target === from) return;
    const root = this.root;
    if (!root) return;
    const kids = this.resolve(root.get("Kids") ?? null);
    if (!isArray(kids)) return;
    const [moved] = kids.splice(from, 1);
    if (moved === undefined) return;
    kids.splice(target, 0, moved);
    this.writeKids(root, kids);
    this.commit();
  }

  /** Turn a page. The value is stored on the page so it overrides any ancestor. */
  setRotation(index: number, degrees: number): void {
    const page = this.getPage(index);
    if (!page) return;
    page.setNumber("Rotate", ((Math.round(degrees / 90) * 90) % 360 + 360) % 360);
    this.commit();
  }

  /** Change the page box, and optionally scale the content to match. */
  setBox(index: number, key: "MediaBox" | "CropBox", box: Rect, scaleContent = false): void {
    const page = this.getPage(index);
    if (!page) return;
    // Read the old box first. Overwriting the page first would make the ratio
    // one, and the content would never move.
    const from = key === "MediaBox" ? this.mediaBox(index) : this.cropBox(index);
    page.set(key, [box.x0, box.y0, box.x1, box.y1]);
    if (scaleContent) {
      const sx = (box.x1 - box.x0) / (from.x1 - from.x0 || 1);
      const sy = (box.y1 - box.y0) / (from.y1 - from.y0 || 1);
      const s = Math.min(sx, sy);
      const cs = this.contentOf(index);
      // `q` has to be the first operation, so the transform cannot leak into
      // the graphics state the page's own content will run with.
      cs.unshift("cm", [s, 0, 0, s, -box.x0, -box.y0]);
      cs.unshift("q");
      cs.push("Q");
      this.setContent(index, cs.serialize());
    }
    this.commit();
  }

  /** Set a key on the page itself, so it stops inheriting that key. */
  setInherited(index: number, key: string, value: PdfObject): void {
    const page = this.getPage(index);
    if (!page) return;
    page.set(key, value);
    this.commit();
  }

  /**
   * Mark every node in the tree as changed, then fix the `/Count` values and
   * the `/Parent` links. A stale `/Count` is the classic way a page edit
   * produces a file that some readers accept and others reject.
   */
  private commit(): void {
    const root = this.root;
    const ref = this.rootRef;
    if (!root || !ref) return;
    this.rewrite(root, ref, ref, new Set());
  }

  private rewrite(node: PdfDict, selfRef: PdfRef, parentRef: PdfRef, seen: Set<PdfObject>): number {
    if (seen.has(node)) return 0;
    seen.add(node);

    const kidsObj = this.resolve(node.get("Kids") ?? null);
    let total: number;
    if (isArray(kidsObj)) {
      node.setName("Type", "Pages");
      total = 0;
      for (const kid of kidsObj) {
        const kd = this.resolve(kid);
        if (!isDict(kd)) continue;
        kd.set("Parent", parentRef);
        const kidRef = kid instanceof PdfRef ? kid : null;
        if (kidRef) total += this.rewrite(kd, kidRef, parentRef, seen);
        else total += 1;
      }
      node.setNumber("Count", total);
    } else {
      node.setName("Type", "Page");
      if (node.getNumber("Count") !== null) node.delete("Count");
      node.set("Parent", parentRef);
      total = 1;
    }
    // Every node on the path changed, so every one must be written out. An
    // incremental save only writes what the writer has been told about.
    this.writer.set(selfRef, node);
    return total;
  }

  // -------------------------------------------------------------- metadata

  /** The bookmark tree, with each item's page resolved to an index. */
  outline(): OutlineNode[] {
    const cat = this.doc.catalog;
    if (!cat) return [];
    const outlines = this.resolve(cat.get("Outlines") ?? null);
    if (!isDict(outlines)) return [];
    const pages = this.pageRefs();
    const indexOfPage = (dest: PdfObject | null): number | null => {
      const d = this.resolve(dest ?? null);
      // A destination is either an array whose first item is the page, or a
      // dictionary under /D. Resolving the array itself returns the array.
      if (isArray(d)) {
        const first = d[0];
        if (first instanceof PdfRef) {
          const i = pages.findIndex((r) => r.num === first.num);
          return i >= 0 ? i : null;
        }
        return null;
      }
      if (isDict(d)) {
        const p = this.resolve(d.get("D") ?? null);
        if (p instanceof PdfRef) {
          const i = pages.findIndex((r) => r.num === p.num);
          return i >= 0 ? i : null;
        }
        if (isArray(p) && p[0] instanceof PdfRef) {
          const i = pages.findIndex((r) => r.num === (p[0] as PdfRef).num);
          return i >= 0 ? i : null;
        }
      }
      return null;
    };

    const read = (firstRef: PdfObject | undefined, depth: number): OutlineNode[] => {
      if (depth > 32) return [];
      const out: OutlineNode[] = [];
      let cur = firstRef;
      let guard = 0;
      while (cur !== undefined && cur !== null && guard++ < 4096) {
        const item = this.resolve(cur);
        if (!isDict(item)) break;
        const titleObj = this.resolve(item.get("Title") ?? null);
        const dest = item.get("Dest") ?? null;
        const action = this.resolve(item.get("A") ?? null);
        const actionDest = isDict(action) ? action.get("D") : null;
        out.push({
          title: titleObj instanceof PdfString ? titleObj.asText() : "",
          pageIndex: indexOfPage(dest ?? actionDest ?? null),
          children: read(item.get("First") ?? null, depth + 1),
        });
        cur = this.resolve(item.get("Next") ?? null);
      }
      return out;
    };

    return read(outlines.get("First") ?? null, 0);
  }

  /** Read every leaf of the `/PageLabels` number tree. */
  pageLabels(): Array<{ from: number; style: string | null; prefix: string | null; start: number }> {
    const cat = this.doc.catalog;
    if (!cat) return [];
    const node = this.resolve(cat.get("PageLabels") ?? null);
    if (!isDict(node)) return [];
    const out: Array<{ from: number; style: string | null; prefix: string | null; start: number }> = [];
    const seen = new Set<number>();
    const walk = (n: PdfObject, depth: number): void => {
      if (depth > 32) return;
      if (n instanceof PdfRef) {
        if (seen.has(n.num)) return;
        seen.add(n.num);
      }
      const d = this.resolve(n);
      if (!isDict(d)) return;
      const nums = this.resolve(d.get("Nums") ?? null);
      if (isArray(nums)) {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const from = this.resolve(nums[i] ?? null);
          const entry = this.resolve(nums[i + 1] ?? null);
          if (typeof from !== "number" || !isDict(entry)) continue;
          const s = entry.get("S");
          out.push({
            from,
            style: s instanceof PdfName ? s.name : null,
            prefix: entry.get("P") instanceof PdfString ? (entry.get("P") as PdfString).asText() : null,
            // /St is the first value of the range, so a range can begin at 5.
            start: entry.getNumber("St") ?? 1,
          });
        }
      }
      const kids = this.resolve(d.get("Kids") ?? null);
      if (isArray(kids)) for (const k of kids) walk(k, depth + 1);
    };
    walk(node, 0);
    out.sort((a, b) => a.from - b.from);
    return out;
  }

  /** The label a reader would print for a page index. */
  labelFor(index: number): string {
    const labels = this.pageLabels();
    if (labels.length === 0) return String(index + 1);
    let rule = labels[0] as { from: number; style: string | null; prefix: string | null; start: number };
    for (const l of labels) if (l.from <= index) rule = l;
    const n = index - rule.from + rule.start;
    const prefix = rule.prefix ?? "";
    if (rule.style === null) return "";
    if (rule.style === "D") return prefix + String(n);
    if (rule.style === "R") return prefix + toRoman(n).toUpperCase();
    if (rule.style === "r") return prefix + toRoman(n);
    if (rule.style === "A") return prefix + toLetters(n, true);
    if (rule.style === "a") return prefix + toLetters(n, false);
    return prefix + String(n);
  }
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  let rest = n;
  for (const [v, s] of table) {
    while (rest >= v) {
      out += s;
      rest -= v;
    }
  }
  return out;
}

function toLetters(n: number, upper: boolean): string {
  let out = "";
  let rest = n;
  while (rest > 0) {
    rest--;
    out = String.fromCharCode((rest % 26) + (upper ? 65 : 97)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

function rootRefOf(root: PdfDict): PdfObject | null {
  return root;
}
