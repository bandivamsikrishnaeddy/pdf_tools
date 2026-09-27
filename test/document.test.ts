import { describe, expect, it } from "vitest";
import { fixture, load, tree, allText } from "./helpers";
import { PdfDocument } from "../src/pdf/document";
import { PdfWriter } from "../src/pdf/writer";
import { PageTree } from "../src/pdf/page-tree";
import { isDict, isStream, PdfString } from "../src/pdf/objects";
import { ContentStream } from "../src/pdf/content-stream";
import { latin1 } from "../src/pdf/lexer";

describe("document: classic cross-reference table", () => {
  it("reads the version, the page count and every page's text", () => {
    const { pages } = tree("simple.pdf");
    expect(pages.count).toBe(2);
    expect(allText(pages)).toBe("Page One Heading\nPage Two Heading");
  });

  it("needs no repair on a well-formed file", () => {
    const doc = load("simple.pdf");
    expect(doc.repairs).toEqual([]);
    expect(doc.encrypted).toBe(false);
  });

  it("reads the catalog through the trailer", () => {
    const doc = load("simple.pdf");
    expect(doc.catalog?.getName("Type")).toBe("Catalog");
  });

  it("reads the info dictionary", () => {
    const doc = load("simple.pdf");
    expect(doc.info?.get("Title")?.toString()).toBe("(Simple Fixture)");
  });

  it("decodes a content stream into the operators it holds", () => {
    const { pages } = tree("simple.pdf");
    const cs = pages.contentOf(0);
    const tj = cs.ops.find((o) => o.op === "Tj");
    expect(tj?.operands[0]).toBeInstanceOf(PdfString);
    expect((tj!.operands[0] as PdfString).asText()).toBe("Page One Heading");
  });

  it("counts the indexed objects and classifies them", () => {
    const doc = load("simple.pdf");
    const inv = doc.inventory();
    expect(inv.length).toBeGreaterThanOrEqual(8);
    const page = inv.find((o) => o.num === 3);
    expect(page?.type).toBe("dict");
    expect(page?.subtype).toBe("Page");
    const content = inv.find((o) => o.num === 4);
    expect(content?.type).toBe("stream");
  });

  it("gives the same answer twice in a row", () => {
    const first = allText(tree("simple.pdf").pages);
    const second = allText(tree("simple.pdf").pages);
    expect(first).toBe(second);
  });
});

describe("document: filters", () => {
  it("decompresses a Flate content stream to the same text", () => {
    const { pages } = tree("flate.pdf");
    expect(allText(pages)).toBe("Page One Heading\nPage Two Heading");
  });
});

describe("document: object streams and xref streams", () => {
  it("reads objects that live inside an object stream", () => {
    const { pages } = tree("objstm.pdf");
    expect(pages.count).toBe(2);
    expect(allText(pages)).toBe("Page One Heading\nPage Two Heading");
  });

  it("indexes the compressed objects as type 2 entries", () => {
    const doc = load("objstm.pdf");
    // 1,2,3,5,7 live inside object stream 8; 9 and 10 are ordinary objects.
    for (const num of [1, 2, 3, 5, 7]) expect(doc.xref.get(num)?.type).toBe(2);
    for (const num of [8, 9, 10, 11]) expect(doc.xref.get(num)?.type).toBe(1);
  });

  it("resolves a compressed object to a real dictionary", () => {
    const doc = load("objstm.pdf");
    const cat = doc.catalog;
    expect(cat).not.toBeNull();
    expect(isDict(cat) && cat.getName("Type")).toBe("Catalog");
  });
});

describe("document: incremental updates", () => {
  it("prefers the newest revision", () => {
    const { pages } = tree("incremental.pdf");
    expect(pages.count).toBe(2);
    expect(pages.textOf(0).text).toBe("Page One Heading");
    expect(pages.textOf(1).text).toBe("Page Two Revised");
  });

  it("reads more than one cross-reference section", () => {
    const doc = load("incremental.pdf");
    expect(doc.sectionsRead.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps objects that only the older section defines", () => {
    const doc = load("incremental.pdf");
    // Object 7, the font, was never revised.
    const font = doc.getObject(7);
    expect(isDict(font) && font.getName("BaseFont")).toBe("Helvetica");
  });
});

describe("document: repair", () => {
  it("rebuilds the index when every offset is wrong", () => {
    const doc = load("broken.pdf");
    // The offsets are only used when an object is read, so ask for one first.
    expect(doc.getPageCount()).toBe(2);
    expect(doc.repairs.some((r) => r.code === "rebuilt-xref")).toBe(true);
  });

  it("still returns the right pages and text after a rebuild", () => {
    const { pages } = tree("broken.pdf");
    expect(pages.count).toBe(2);
    expect(allText(pages)).toBe("Page One Heading\nPage Two Heading");
  });

  it("recovers a file whose tail was cut off", () => {
    // Drop the startxref, the index and the trailer, leaving only objects.
    const bytes = fixture("simple.pdf");
    const at = latin1(bytes).indexOf("xref\n0 ");
    expect(at).toBeGreaterThan(0);
    const head = bytes.subarray(0, at);
    const doc = PdfDocument.parse(head);
    expect(doc.repairs.length).toBeGreaterThan(0);
    const pages = new PageTree(doc, new PdfWriter(doc));
    expect(pages.count).toBe(2);
    expect(pages.textOf(0).text).toBe("Page One Heading");
  });
});

describe("document: page tree inheritance", () => {
  it("reads a box from an ancestor when the page has none", () => {
    const { pages } = tree("nested.pdf");
    expect(pages.count).toBe(2);
    expect(pages.mediaBox(0)).toEqual({ x0: 0, y0: 0, x1: 400, y1: 400 });
  });

  it("lets a page override the box it would inherit", () => {
    const { pages } = tree("nested.pdf");
    expect(pages.mediaBox(1)).toEqual({ x0: 0, y0: 0, x1: 200, y1: 200 });
  });

  it("inherits the font resource down two levels", () => {
    const { pages } = tree("nested.pdf");
    expect(pages.textOf(0).text).toBe("Inherited Box Page");
    expect(pages.textOf(1).text).toBe("Own Box Page");
  });
});

describe("document: outline and page labels", () => {
  it("reads a two-level bookmark tree with page indices", () => {
    const { pages } = tree("labels.pdf");
    const outline = pages.outline();
    expect(outline.map((n) => n.title)).toEqual(["First Chapter", "Second Chapter"]);
    expect(outline[0]?.pageIndex).toBe(0);
    expect(outline[1]?.pageIndex).toBe(2);
    expect(outline[1]?.children.map((c) => c.title)).toEqual(["Nested Item"]);
    expect(outline[1]?.children[0]?.pageIndex).toBe(1);
  });

  it("formats page labels from the number tree", () => {
    const { pages } = tree("labels.pdf");
    expect(pages.labelFor(0)).toBe("i");
    expect(pages.labelFor(1)).toBe("5");
    expect(pages.labelFor(2)).toBe("6");
  });
});

describe("content stream parsing", () => {
  it("keeps nested arrays as nested arrays", () => {
    const cs = ContentStream.parse(Uint8Array.from([..."[ (a) 1 [ (b) 2 ] ] TJ"].map((c) => c.charCodeAt(0))));
    const arr = cs.ops[0]?.operands[0] as unknown[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(3);
    expect(Array.isArray(arr[2])).toBe(true);
    expect(((arr[2] as unknown[])[0] as PdfString).asText()).toBe("b");
  });

  it("counts operations, not tokens", () => {
    const { pages } = tree("simple.pdf");
    const cs = pages.contentOf(0);
    expect(cs.count).toBe(5); // BT, Tf, Td, Tj, ET
    expect(cs.ops.map((o) => o.op)).toEqual(["BT", "Tf", "Td", "Tj", "ET"]);
  });

  it("round-trips a parsed stream to the same operations", () => {
    const { pages } = tree("simple.pdf");
    const cs = pages.contentOf(0);
    const again = ContentStream.parse(cs.serialize());
    expect(again.ops.map((o) => o.op)).toEqual(cs.ops.map((o) => o.op));
    const a = cs.ops.find((o) => o.op === "Tj")!.operands[0] as PdfString;
    const b = again.ops.find((o) => o.op === "Tj")!.operands[0] as PdfString;
    expect(b.asText()).toBe(a.asText());
  });

  it("keeps an inline image as raw bytes", () => {
    const src = "q BI /W 2 /H 2 ID \u0000\u0001\u0002\u0003 EI Q";
    const cs = ContentStream.parse(Uint8Array.from([...src].map((c) => c.charCodeAt(0))));
    const bi = cs.ops.find((o) => o.op === "BI");
    expect(bi).toBeDefined();
    const raw = (bi!.operands[0] as unknown as { raw: Uint8Array }).raw;
    expect(latin1(raw)).toContain("ID");
    expect(cs.ops.map((o) => o.op)).toEqual(["q", "BI", "Q"]);
  });
});

describe("streams that carry an image codec", () => {
  it("returns the bytes as they are and names the codec", () => {
    const doc = load("simple.pdf");
    const obj = doc.getObject(4);
    expect(isStream(obj)).toBe(true);
    if (isStream(obj)) {
      const out = doc.getStreamData(obj);
      expect(out.imageCodec).toBe(null);
      expect(latin1(out.data)).toContain("Tj");
    }
  });
});
