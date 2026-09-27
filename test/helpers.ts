import { readFileSync } from "node:fs";
import { PdfDocument } from "../src/pdf/document";
import { PdfWriter } from "../src/pdf/writer";
import { PageTree } from "../src/pdf/page-tree";
import { ContentStream, Resources, extractText } from "../src/pdf/content-stream";

/** Read a fixture produced by `test/make_fixtures.py`, not by this engine. */
export function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/**
 * The document the app ships as its demo. It is a real PDF 1.3 file from a real
 * producer, and it is the specimen that found two engine bugs, so the suite
 * reads the very file that is deployed.
 */
export function demo(): Uint8Array {
  return readFileSync(new URL("../public/sample.pdf", import.meta.url));
}

export function load(name: string): PdfDocument {
  return PdfDocument.parse(fixture(name));
}

export function tree(name: string): { doc: PdfDocument; writer: PdfWriter; pages: PageTree } {
  const doc = load(name);
  const writer = new PdfWriter(doc);
  return { doc, writer, pages: new PageTree(doc, writer) };
}

/** The text of every page, joined, which is the assertion most tests want. */
export function allText(pages: PageTree): string {
  const out: string[] = [];
  for (let i = 0; i < pages.count; i++) out.push(pages.textOf(i).text);
  return out.join("\n");
}

export { PdfDocument, PdfWriter, PageTree, ContentStream, Resources, extractText };
