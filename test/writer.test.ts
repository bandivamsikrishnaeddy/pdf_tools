import { describe, expect, it } from "vitest";
import { PdfWriter, formatNumber, serializeObject } from "../src/pdf/writer";
import { PdfDocument } from "../src/pdf/document";
import { PdfDict, PdfName, PdfRef, PdfStream, PdfString, isDict, isStream } from "../src/pdf/objects";
import { Lexer, latin1 } from "../src/pdf/lexer";
import { PageTree } from "../src/pdf/page-tree";
import { fixture, load, tree } from "./helpers";

const text = (bytes: Uint8Array) => latin1(bytes);

describe("writer: serialising single objects", () => {
  it("writes scalars in their PDF form", () => {
    expect(text(serializeObject(null))).toBe("null");
    expect(text(serializeObject(true))).toBe("true");
    expect(text(serializeObject(42))).toBe("42");
    expect(text(serializeObject(-3.5))).toBe("-3.5");
    expect(text(serializeObject(new PdfName("Type")))).toBe("/Type");
    expect(text(serializeObject(new PdfRef(7, 0)))).toBe("7 0 R");
  });

  it("wraps a string in parentheses, which the data itself does not carry", () => {
    expect(text(serializeObject(new PdfString(Uint8Array.of(0x61, 0x62))))).toBe("(ab)");
  });

  it("escapes the bytes a string may not contain raw", () => {
    const out = text(serializeObject(new PdfString(Uint8Array.of(0x28, 0x29, 0x5c, 0x0a))));
    expect(out).toBe("(\\(\\)\\\\\\n)".replace("\\n", "\\n"));
  });

  it("writes a dictionary with one space between every token", () => {
    const d = new PdfDict();
    d.setName("Type", "Page");
    d.setNumber("Rotate", 90);
    expect(text(serializeObject(d))).toBe("<< /Type /Page /Rotate 90 >>");
  });

  it("writes an empty dictionary as <<>> with no stray space", () => {
    expect(text(serializeObject(new PdfDict()))).toBe("<<>>");
  });

  it("writes an empty array", () => {
    expect(text(serializeObject([]))).toBe("[]");
  });

  it("never writes exponent notation, which PDF has no syntax for", () => {
    expect(formatNumber(1e21)).toBe("1000000000000000000000");
    expect(formatNumber(0.0000001)).toBe("0");
    expect(formatNumber(-0)).toBe("0");
  });
});

describe("writer: a string survives a full round trip", () => {
  const tricky = new PdfString(Uint8Array.of(0x28, 0x5c, 0x29, 0x0a, 0x00, 0xff, 0x0d));

  it("comes back byte for byte", () => {
    const writer = new PdfWriter();
    const ref = writer.alloc();
    writer.set(ref, tricky);
    const bytes = writer.save({ incremental: false });
    const doc = PdfDocument.parse(bytes);
    const back = doc.getObject(ref.num);
    expect(back).toBeInstanceOf(PdfString);
    expect(Array.from((back as PdfString).bytes)).toEqual(Array.from(tricky.bytes));
  });
});

describe("writer: full rewrite", () => {
  it("keeps the page count and every page's text", () => {
    const doc = load("simple.pdf");
    const writer = new PdfWriter(doc);
    const bytes = writer.save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    expect(again.getPageCount()).toBe(2);
    const pages = new PageTree(again, new PdfWriter(again));
    expect(pages.textOf(0).text).toBe("Page One Heading");
    expect(pages.textOf(1).text).toBe("Page Two Heading");
  });

  it("keeps a document that used object streams", () => {
    const doc = load("objstm.pdf");
    const bytes = new PdfWriter(doc).save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    expect(again.getPageCount()).toBe(2);
    const pages = new PageTree(again, new PdfWriter(again));
    expect(pages.textOf(1).text).toBe("Page Two Heading");
  });

  it("writes a stream with a Length that matches the bytes", () => {
    const doc = load("simple.pdf");
    const bytes = new PdfWriter(doc).save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    const obj = again.getObject(4);
    expect(isStream(obj)).toBe(true);
    if (isStream(obj)) {
      expect(obj.dict.getNumber("Length")).toBe(obj.raw.length);
      expect(text(again.streamBytes(obj))).toContain("Page One Heading");
    }
  });

  it("starts a file a fresh reader can follow", () => {
    const doc = load("simple.pdf");
    const bytes = new PdfWriter(doc).save({ incremental: false });
    expect(text(bytes.subarray(0, 8))).toBe("%PDF-1.7");
    expect(text(bytes.subarray(-6))).toBe("%%EOF\n");
  });
});

describe("writer: incremental save", () => {
  it("keeps every original byte up to the point of the append", () => {
    const original = fixture("simple.pdf");
    const doc = PdfDocument.parse(original);
    const writer = new PdfWriter(doc);
    const ref = writer.alloc();
    writer.set(ref, new PdfString(Uint8Array.of(0x78)));
    const bytes = writer.save({ incremental: true });
    expect(bytes.length).toBeGreaterThan(original.length);
    // The first original.length bytes must be untouched.
    for (let i = 0; i < original.length; i++) {
      if (bytes[i] !== original[i]) {
        throw new Error(`byte ${i} changed: ${bytes[i]} vs ${original[i]}`);
      }
    }
  });

  it("appends a new section that points back at the old one", () => {
    const doc = PdfDocument.parse(fixture("simple.pdf"));
    const writer = new PdfWriter(doc);
    const ref = writer.alloc();
    writer.set(ref, new PdfName("Extra"));
    const bytes = writer.save({ incremental: true });
    const again = PdfDocument.parse(bytes);
    expect(again.sectionsRead.length).toBe(2);
    expect(again.repairs).toEqual([]);
    expect(again.getPageCount()).toBe(2);
  });

  it("only writes the objects that changed", () => {
    const doc = PdfDocument.parse(fixture("simple.pdf"));
    const writer = new PdfWriter(doc);
    const ref = writer.alloc();
    writer.set(ref, new PdfName("Extra"));
    const bytes = writer.save({ incremental: true });
    const tail = text(bytes.subarray(fixture("simple.pdf").length));
    // One object, then one index subsection naming it.
    expect(tail).toContain(`${ref.num} 0 obj`);
    expect(tail).toContain(`${ref.num} 1`);
  });
});

describe("writer: stream compression on save", () => {
  it("deflates a stream when asked, and the reader gets it back", () => {
    const doc = load("simple.pdf");
    const writer = new PdfWriter(doc);
    const payload = new Uint8Array(4096).fill(0x41);
    const ref = writer.alloc();
    writer.set(ref, writer.stream(new PdfDict(), payload, true));
    const bytes = writer.save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    const back = again.getObject(ref.num);
    expect(isStream(back)).toBe(true);
    if (isStream(back)) {
      expect(back.dict.getName("Filter")).toBe("FlateDecode");
      // 4096 identical bytes must not occupy 4096 bytes in the file.
      expect(back.raw.length).toBeLessThan(200);
      expect(again.streamBytes(back).length).toBe(payload.length);
    }
  });

  it("drops the filter when the bytes are replaced with plain ones", () => {
    const doc = load("simple.pdf");
    const obj = doc.getObject(4);
    expect(isStream(obj)).toBe(true);
    if (!isStream(obj)) return;
    const stream = obj as PdfStream;
    stream.dict.setName("Filter", "FlateDecode");
    stream.setPlainData(Uint8Array.of(1, 2, 3));
    expect(stream.dict.get("Filter")).toBeUndefined();
    expect(stream.dict.getNumber("Length")).toBe(3);
  });
});

describe("writer: an edited document survives the write", () => {
  it("keeps a page rotation set through the page tree", () => {
    const { writer, pages } = tree("simple.pdf");
    pages.setRotation(0, 90);
    const bytes = writer.save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    const t2 = new PageTree(again, new PdfWriter(again));
    expect(t2.rotation(0)).toBe(90);
    expect(t2.rotation(1)).toBe(0);
  });

  it("keeps a replaced content stream", () => {
    // The same writer has to be used, because it owns the new object number.
    const { writer, pages } = tree("simple.pdf");
    const cs = pages.contentOf(0);
    cs.push("Tj", [new PdfString(Uint8Array.of(0x41, 0x42, 0x43))]);
    pages.setContent(0, cs.serialize());
    const bytes = writer.save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    const t2 = new PageTree(again, new PdfWriter(again));
    expect(t2.contentOf(0).count).toBe(cs.count);
  });

  it("leaves an untouched page's content stream byte for byte equal", () => {
    const original = fixture("simple.pdf");
    const doc = PdfDocument.parse(original);
    const before = doc.getObject(6);
    const bytes = new PdfWriter(doc).save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    const after = again.getObject(6);
    if (!isStream(before) || !isStream(after)) throw new Error("not a stream");
    expect(text(after.raw)).toBe(text(before.raw));
  });
});

describe("writer: a name is escaped on the way out", () => {
  it("writes a name with a space as a hex escape", () => {
    expect(text(serializeObject(new PdfName("A B")))).toBe("/A#20B");
  });

  it("round-trips a name with a space through a file", () => {
    const writer = new PdfWriter();
    const ref = writer.alloc();
    const d = new PdfDict();
    d.setName("Odd Key", "v");
    writer.set(ref, d);
    const bytes = writer.save({ incremental: false });
    const again = PdfDocument.parse(bytes);
    const back = again.getObject(ref.num);
    expect(isDict(back) && back.getName("Odd Key")).toBe("v");
  });
});

describe("lexer and writer agree on the number syntax", () => {
  it("reads back every number the writer produced", () => {
    for (const n of [0, 1, -1, 3.14159, -0.5, 792, 612, 0.5, 1e-3, 12345.6789]) {
      const lex = new Lexer(serializeObject(n));
      const t = lex.nextToken();
      expect(t.type).toBe("num");
      expect(Math.abs((t.value as number) - n)).toBeLessThan(1e-9);
    }
  });
});
