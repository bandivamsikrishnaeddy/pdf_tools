import { describe, expect, it } from "vitest";
import { demo } from "./helpers";
import { PdfDocument } from "../src/pdf/document";
import { PdfWriter } from "../src/pdf/writer";
import { PageTree } from "../src/pdf/page-tree";
import { search } from "../src/pdf/search";

/**
 * The deployed demo file, read as a real consumer would.
 *
 * Everything here is a bug this file actually caused. It is a PDF 1.3 from a
 * real producer, and it does three things the hand-built fixtures do not:
 * indirect references for every inherited key, a 1pt font scaled by `Tm`, and
 * hundreds of text runs on one page.
 */
function open() {
  const bytes = demo();
  const doc = PdfDocument.parse(bytes);
  const pages = new PageTree(doc, new PdfWriter(doc));
  return { bytes, doc, pages };
}

describe("the real demo document", () => {
  it("opens with no repairs and no false alarms", () => {
    const { doc, pages } = open();
    expect(doc.encrypted).toBe(false);
    expect(doc.repairs).toEqual([]);
    expect(pages.count).toBeGreaterThan(0);
  });

  it("finds text, which it did not before inherited keys were resolved", () => {
    const { pages } = open();
    const total = pages.textOf(0).runs.reduce((n, r) => n + r.text.length, 0);
    expect(total).toBeGreaterThan(1000);
  });

  it("resolves the font dictionary through an indirect /Resources", () => {
    const { pages } = open();
    // Every font here is reachable only by following a reference.
    expect(pages.resources(0).fontNames().length).toBeGreaterThan(0);
  });

  it("scales a 1pt font up to the size it is really drawn at", () => {
    const { pages } = open();
    const runs = pages.textOf(0).runs;
    // This file declares every font at 1pt and scales with Tm. Trusting the
    // declared size drew the whole page one pixel tall.
    expect(runs.every((r) => r.fontSize === 1)).toBe(true);
    const heights = runs.map((r) => r.height);
    const biggest = Math.max(...heights);
    expect(biggest).toBeGreaterThan(20);
    expect(Math.min(...heights)).toBeGreaterThan(2);
  });

  it("keeps every run on the page", () => {
    const { pages } = open();
    const d = pages.displayMatrix(0, 1);
    for (const run of pages.textOf(0).runs) {
      // A text operator that advances the line matrix instead of the text
      // matrix walks text diagonally off the right edge of the page.
      expect(run.x).toBeGreaterThanOrEqual(-1);
      expect(run.x).toBeLessThanOrEqual(d.width + 1);
      expect(run.y).toBeGreaterThanOrEqual(-1);
      expect(run.y).toBeLessThanOrEqual(d.height + 1);
    }
  });

  it("gives every run a glyph box per character", () => {
    const { pages } = open();
    for (const run of pages.textOf(0).runs.slice(0, 50)) {
      expect(run.glyphs.length).toBeGreaterThan(0);
      // The boxes have to run forwards, or a highlight cannot be placed.
      for (let i = 1; i < run.glyphs.length; i++) {
        expect(run.glyphs[i]!.start).toBeGreaterThanOrEqual(run.glyphs[i - 1]!.start);
      }
    }
  });
});

describe("search over the real demo document", () => {
  it("finds a word in the middle of the page, not just the first run", () => {
    const { pages } = open();
    const out = search(pages, "Morbi");
    expect(out.matches.length).toBe(1);
    expect(out.matches[0]!.rects.length).toBeGreaterThan(0);
  });

  it("finds a word that is hundreds of characters into the page", () => {
    const { pages } = open();
    const text = pages.textOf(0).text;
    // Pick a word from the last third, so it cannot land in an early run.
    const tail = text.slice(Math.floor(text.length * 0.7));
    const word = /[A-Za-z]{5,}/.exec(tail);
    expect(word).not.toBeNull();
    const out = search(pages, word![0]);
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches[0]!.rects.length).toBeGreaterThan(0);
  });

  it("finds every occurrence of a repeated word across the page", () => {
    const { pages } = open();
    const text = pages.textOf(0).text;
    const counts = new Map<string, number>();
    for (const w of text.split(/\s+/)) {
      const k = w.toLowerCase();
      if (k.length >= 5) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const repeated = [...counts.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])[0];
    expect(repeated).toBeDefined();
    const needle = repeated![0].toLowerCase();

    // Counted the way search counts: case-insensitive, non-overlapping. A page
    // whose text is several runs joined has no spaces between runs, so counting
    // whitespace-separated tokens would disagree.
    const expected = text.toLowerCase().split(needle).length - 1;
    expect(expected).toBeGreaterThanOrEqual(repeated![1]);

    const out = search(pages, repeated![0]);
    expect(out.matches.length).toBe(expected);
    // The real point: every occurrence comes back with a rectangle, not just
    // the first. Before the run-local fix, all but the first came back empty.
    expect(out.matches.every((m) => m.rects.length > 0)).toBe(true);
  });

  it("boxes a match inside the page rather than at the run origin", () => {
    const { pages } = open();
    const d = pages.displayMatrix(0, 1);
    const m = search(pages, "Morbi").matches[0]!;
    for (const r of m.rects) {
      expect(r.x0).toBeGreaterThanOrEqual(0);
      expect(r.x1).toBeLessThanOrEqual(d.width);
    }
  });
});

describe("the real demo document survives a rewrite", () => {
  it("keeps its page count, its text and its layout", () => {
    const { doc, pages, bytes } = open();
    const before = pages.textOf(0);
    const out = PdfDocument.parse(new PdfWriter(doc).save({ incremental: false }));
    const after = new PageTree(out, new PdfWriter(out));
    expect(after.count).toBe(pages.count);
    const now = after.textOf(0);
    expect(now.text).toBe(before.text);
    expect(now.runs.length).toBe(before.runs.length);
    // The text must not move: same run count and the same first run origin.
    expect(now.runs[0]!.x).toBeCloseTo(before.runs[0]!.x, 4);
    expect(now.runs[0]!.y).toBeCloseTo(before.runs[0]!.y, 4);
    expect(now.runs[0]!.height).toBeCloseTo(before.runs[0]!.height, 4);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
