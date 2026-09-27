import { describe, expect, it } from "vitest";
import { fixture, tree } from "./helpers";
import { PdfDocument } from "../src/pdf/document";
import { PdfWriter } from "../src/pdf/writer";
import { PageTree } from "../src/pdf/page-tree";
import { isDict, PdfName, PdfString } from "../src/pdf/objects";

/** Save, read back, and hand the result over. This is the real assertion. */
function saveAndReopen(writer: PdfWriter, incremental = false): { doc: PdfDocument; pages: PageTree } {
  const bytes = writer.save({ incremental });
  const doc = PdfDocument.parse(bytes);
  return { doc, pages: new PageTree(doc, new PdfWriter(doc)) };
}

describe("page tree: reading", () => {
  it("lists pages in reading order", () => {
    const { pages } = tree("simple.pdf");
    expect(pages.pageRefs().map((r) => r.num)).toEqual([3, 5]);
  });

  it("walks a nested tree in order", () => {
    const { pages } = tree("nested.pdf");
    expect(pages.count).toBe(2);
    expect(pages.pageRefs().map((r) => r.num)).toEqual([3, 5]);
  });

  it("reads the crop box from the media box when there is none", () => {
    const { pages } = tree("simple.pdf");
    expect(pages.cropBox(0)).toEqual(pages.mediaBox(0));
  });

  it("defaults rotation to zero", () => {
    const { pages } = tree("simple.pdf");
    expect(pages.rotation(0)).toBe(0);
  });

  it("finds a font through an inherited resource dictionary", () => {
    const { pages } = tree("simple.pdf");
    expect(pages.resources(0).fontNames()).toEqual(["F1"]);
  });
});

describe("page tree: text positions", () => {
  it("puts a run at the point Td asked for, in screen coordinates", () => {
    const { pages } = tree("simple.pdf");
    const { runs } = pages.textOf(0);
    expect(runs).toHaveLength(1);
    // The content says 72 700 Td on a 612x792 page, so 700 from the bottom
    // is 92 from the top.
    expect(runs[0]?.x).toBeCloseTo(72, 6);
    expect(runs[0]?.y).toBeCloseTo(92, 6);
  });

  it("scales the reported box by the real font widths", () => {
    const { pages } = tree("simple.pdf");
    const { runs } = pages.textOf(0);
    // Helvetica "Page One Heading" is 8505/1000 em at 24pt = 204.12pt.
    expect(runs[0]?.width).toBeCloseTo(204.12, 2);
    expect(runs[0]?.height).toBeCloseTo(24, 6);
  });

  it("scales positions with the scale argument", () => {
    const { pages } = tree("simple.pdf");
    const { runs } = pages.textOf(0, 2);
    expect(runs[0]?.x).toBeCloseTo(144, 6);
    expect(runs[0]?.y).toBeCloseTo(184, 6);
  });

  it("honours Tm, which sets both text matrices at once", () => {
    const { writer, pages } = tree("simple.pdf");
    const cs = pages.contentOf(0);
    cs.ops.length = 0;
    cs.push("BT");
    cs.push("Tf", [new PdfName("F1"), 10]);
    cs.push("Tm", [1, 0, 0, 1, 100, 200]);
    cs.push("Tj", [new PdfString(Uint8Array.of(0x41))]);
    cs.push("ET");
    pages.setContent(0, cs.serialize());
    const out = saveAndReopen(writer);
    const run = out.pages.textOf(0).runs[0]!;
    expect(run.text).toBe("A");
    expect(run.x).toBeCloseTo(100, 4);
    expect(run.y).toBeCloseTo(792 - 200, 4);
    // Helvetica 'A' is 667/1000 em, so 6.67pt at 10pt.
    expect(run.width).toBeCloseTo(6.67, 3);
  });
});

describe("display matrix", () => {
  it("returns the page size unrotated", () => {
    const { pages } = tree("simple.pdf");
    const d = pages.displayMatrix(0, 1);
    expect(d.width).toBeCloseTo(612, 6);
    expect(d.height).toBeCloseTo(792, 6);
  });

  it("swaps the page size for a quarter turn", () => {
    const { pages } = tree("simple.pdf");
    pages.setRotation(0, 90);
    const d = pages.displayMatrix(0, 1);
    expect(d.width).toBeCloseTo(792, 6);
    expect(d.height).toBeCloseTo(612, 6);
  });

  it("keeps every page corner inside the reported box", () => {
    const { pages } = tree("simple.pdf");
    for (const rot of [0, 90, 180, 270]) {
      pages.setRotation(0, rot);
      const d = pages.displayMatrix(0, 1);
      const box = pages.cropBox(0);
      const corners: Array<[number, number]> = [
        [box.x0, box.y0],
        [box.x1, box.y0],
        [box.x0, box.y1],
        [box.x1, box.y1],
      ];
      for (const [ux, uy] of corners) {
        const c = d.matrix.apply(ux, uy);
        expect(c.x).toBeGreaterThanOrEqual(-0.001);
        expect(c.y).toBeGreaterThanOrEqual(-0.001);
        expect(c.x).toBeLessThanOrEqual(d.width + 0.001);
        expect(c.y).toBeLessThanOrEqual(d.height + 0.001);
      }
    }
  });

  it("puts a rotated run inside the reported box", () => {
    const { pages } = tree("simple.pdf");
    pages.setRotation(0, 90);
    const d = pages.displayMatrix(0, 1);
    const { runs } = pages.textOf(0, 1);
    const r = runs[0]!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x).toBeLessThanOrEqual(d.width + 0.001);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeLessThanOrEqual(d.height + 0.001);
  });
});

describe("page tree: inserting", () => {
  it("appends a blank page and the count follows", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertBlank(2);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(3);
    expect(out.pages.mediaBox(2)).toEqual({ x0: 0, y0: 0, x1: 595.28, y1: 841.89 });
  });

  it("inserts a blank page at the front", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertBlank(0, 200, 300);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(3);
    expect(out.pages.mediaBox(0)).toEqual({ x0: 0, y0: 0, x1: 200, y1: 300 });
    expect(out.pages.textOf(1).text).toBe("Page One Heading");
  });

  it("inserts in the middle and keeps the order", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertBlank(1);
    const out = saveAndReopen(writer);
    expect(out.pages.textOf(0).text).toBe("Page One Heading");
    expect(out.pages.textOf(1).text).toBe("");
    expect(out.pages.textOf(2).text).toBe("Page Two Heading");
  });

  it("keeps a correct Count in the saved tree", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertBlank(0);
    const out = saveAndReopen(writer);
    const root = out.pages.root;
    expect(root?.getNumber("Count")).toBe(3);
  });

  it("copies a page rather than sharing it", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertCopy(2, 0);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(3);
    expect(out.pages.textOf(2).text).toBe("Page One Heading");
    // Editing the copy must not touch the original.
    out.pages.setRotation(2, 180);
    expect(out.pages.rotation(0)).toBe(0);
  });

  it("inserts into a nested tree at the right position", () => {
    const { writer, pages } = tree("nested.pdf");
    pages.insertBlank(0);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(3);
    expect(out.pages.textOf(0).text).toBe("");
    expect(out.pages.textOf(1).text).toBe("Inherited Box Page");
  });
});

describe("page tree: removing and moving", () => {
  it("removes one page", () => {
    const { writer, pages } = tree("simple.pdf");
    expect(pages.remove([0])).toBe(1);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(1);
    expect(out.pages.textOf(0).text).toBe("Page Two Heading");
  });

  it("removes several pages at once", () => {
    const { writer, pages } = tree("nested.pdf");
    expect(pages.remove([0, 1])).toBe(2);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(0);
    expect(out.pages.pageRefs()).toEqual([]);
  });

  it("refuses an index that is out of range", () => {
    const { pages } = tree("simple.pdf");
    expect(pages.remove([9])).toBe(0);
    expect(pages.count).toBe(2);
  });

  it("moves a page to the end", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.move(0, 1);
    const out = saveAndReopen(writer);
    expect(out.pages.textOf(0).text).toBe("Page Two Heading");
    expect(out.pages.textOf(1).text).toBe("Page One Heading");
  });

  it("moves a page to the start", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.move(1, 0);
    const out = saveAndReopen(writer);
    expect(out.pages.textOf(0).text).toBe("Page Two Heading");
  });
});

describe("page tree: page attributes", () => {
  it("sets a rotation that survives the write", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.setRotation(1, 270);
    const out = saveAndReopen(writer);
    expect(out.pages.rotation(1)).toBe(270);
    expect(out.pages.rotation(0)).toBe(0);
  });

  it("normalises a rotation to a quarter turn", () => {
    const { pages } = tree("simple.pdf");
    pages.setRotation(0, 450);
    expect(pages.rotation(0)).toBe(90);
  });

  it("changes a media box", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.setBox(0, "MediaBox", { x0: 0, y0: 0, x1: 400, y1: 500 });
    const out = saveAndReopen(writer);
    expect(out.pages.mediaBox(0)).toEqual({ x0: 0, y0: 0, x1: 400, y1: 500 });
    expect(out.pages.mediaBox(1)).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it("leaves the content alone when not scaling", () => {
    const { writer, pages } = tree("simple.pdf");
    const before = pages.textOf(0).text;
    pages.setBox(0, "MediaBox", { x0: 0, y0: 0, x1: 400, y1: 500 });
    const out = saveAndReopen(writer);
    expect(out.pages.textOf(0).text).toBe(before);
  });

  it("moves the content when scaling the box", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.setBox(0, "MediaBox", { x0: 0, y0: 0, x1: 306, y1: 396 }, true);
    const out = saveAndReopen(writer);
    const run = out.pages.textOf(0).runs[0]!;
    // The 72 700 position was halved along with the page.
    expect(run.x).toBeCloseTo(36, 4);
    expect(run.y).toBeCloseTo(396 - 350, 4);
  });
});

describe("page tree: an incremental save carries the edit", () => {
  it("appends only the tree and the page it changed", () => {
    const original = fixture("simple.pdf");
    const doc = PdfDocument.parse(original);
    const writer = new PdfWriter(doc);
    const pages = new PageTree(doc, writer);
    pages.setRotation(0, 90);
    const bytes = writer.save({ incremental: true });
    expect(bytes.length).toBeGreaterThan(original.length);
    const again = PdfDocument.parse(bytes);
    expect(again.repairs).toEqual([]);
    const t2 = new PageTree(again, new PdfWriter(again));
    expect(t2.rotation(0)).toBe(90);
    expect(t2.count).toBe(2);
  });

  it("keeps the original bytes as a prefix", () => {
    const original = fixture("simple.pdf");
    const doc = PdfDocument.parse(original);
    const writer = new PdfWriter(doc);
    const pages = new PageTree(doc, writer);
    pages.setRotation(0, 90);
    const bytes = writer.save({ incremental: true });
    for (let i = 0; i < original.length; i++) {
      if (bytes[i] !== original[i]) throw new Error(`byte ${i} differs`);
    }
  });
});

describe("page tree: a chain of edits still reads back", () => {
  it("insert, rotate, reorder, remove and resize in one go", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertBlank(0, 300, 400);
    pages.setRotation(1, 90);
    pages.move(0, 2);
    pages.remove([1]);
    pages.setBox(0, "MediaBox", { x0: 0, y0: 0, x1: 500, y1: 600 }, true);
    const out = saveAndReopen(writer);
    expect(out.pages.count).toBe(2);
    expect(out.doc.repairs).toEqual([]);
    // After insert, move and remove the order is page one, then the blank.
    expect(out.pages.rotation(0)).toBe(90);
    expect(out.pages.mediaBox(0)).toEqual({ x0: 0, y0: 0, x1: 500, y1: 600 });
    expect(out.pages.mediaBox(1)).toEqual({ x0: 0, y0: 0, x1: 300, y1: 400 });
    expect(out.pages.textOf(0).text).toBe("Page One Heading");
  });

  it("leaves no page without a parent link", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.insertBlank(0);
    const out = saveAndReopen(writer);
    for (let i = 0; i < out.pages.count; i++) {
      const page = out.pages.getPage(i);
      expect(isDict(page) && page.get("Parent")).toBeTruthy();
    }
  });
});
