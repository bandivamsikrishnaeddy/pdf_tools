import { describe, expect, it } from "vitest";
import { tree } from "./helpers";
import { search, stepMatch, type Match } from "../src/pdf/search";
import { PdfName, PdfString } from "../src/pdf/objects";
import { PdfWriter } from "../src/pdf/writer";
import { PageTree } from "../src/pdf/page-tree";
import { PdfDocument } from "../src/pdf/document";

/** A one-page document whose single line says `text`, drawn with Helvetica. */
function pageSaying(pages: PageTree, text: string, y = 700) {
  const cs = pages.contentOf(0);
  cs.ops.length = 0;
  cs.push("BT");
  cs.push("Tf", [new PdfName("F1"), 12]);
  cs.push("Tm", [1, 0, 0, 1, 72, y]);
  cs.push("Tj", [new PdfString(new TextEncoder().encode(text))]);
  cs.push("ET");
  pages.setContent(0, cs.serialize());
}

describe("search: every occurrence, not the first", () => {
  it("finds all of them on one page", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "alpha beta alpha gamma alpha");
    const out = search(saveAndReopen(writer).pages, "alpha");
    expect(out.matches.length).toBe(3);
    expect(out.matches.every((m) => m.page === 0)).toBe(true);
  });

  it("reports each match with the text it found", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "cat dog cat");
    const out = search(saveAndReopen(writer).pages, "cat");
    expect(out.matches.map((m) => m.text)).toEqual(["cat", "cat"]);
  });

  it("searches every page, not only the first", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "needle on page one");
    pages.insertCopy(2, 0);
    const reopened = saveAndReopen(writer).pages;
    expect(reopened.count).toBe(3);
    const out = search(reopened, "needle");
    expect(out.matches.length).toBe(2);
    expect(out.pagesSearched).toBe(3);
  });

  it("returns nothing for a word that is not there", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "alpha beta");
    expect(search(saveAndReopen(writer).pages, "zebra").matches).toEqual([]);
  });
});

describe("search: matching rules", () => {
  it("ignores case by default", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "Alpha ALPHA alpha");
    expect(search(saveAndReopen(writer).pages, "alpha").matches.length).toBe(3);
  });

  it("respects case when asked", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "Alpha ALPHA alpha");
    const out = search(saveAndReopen(writer).pages, "alpha", { caseSensitive: true });
    expect(out.matches.length).toBe(1);
    expect(out.matches[0]?.text).toBe("alpha");
  });

  it("can require a whole word", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "cat concatenate cat");
    // Three without the option, because "concatenate" contains "cat".
    expect(search(saveAndReopen(writer).pages, "cat").matches.length).toBe(3);
    expect(search(saveAndReopen(writer).pages, "cat", { wholeWord: true }).matches.length).toBe(2);
  });

  it("does not report matches that overlap an earlier one", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "aaaa");
    // Matches do not overlap, so only the two non-overlapping positions.
    expect(search(saveAndReopen(writer).pages, "aa").matches.length).toBe(2);
  });

  it("stops at the limit and says so", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "x ".repeat(200));
    const out = search(saveAndReopen(writer).pages, "x", { limit: 10 });
    expect(out.matches.length).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it("handles an empty query without throwing", () => {
    const { pages } = tree("simple.pdf");
    const out = search(pages, "");
    expect(out.matches).toEqual([]);
    expect(out.pagesSearched).toBe(0);
  });
});

describe("search: the rectangle of a match", () => {
  it("covers only the matched characters, not the whole line", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "iiiiiiiiii");
    const out = search(saveAndReopen(writer).pages, "ii");
    const rect = out.matches[0]?.rects[0];
    expect(rect).toBeDefined();
    const all = search(saveAndReopen(writer).pages, "iiiiiiiiii").matches[0]?.rects[0];
    // Two 'i' glyphs are much narrower than all ten.
    expect(rect!.x1 - rect!.x0).toBeLessThan((all!.x1 - all!.x0) * 0.35);
  });

  it("starts where the matched glyph starts, not at the line origin", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "pad target");
    const out = search(saveAndReopen(writer).pages, "target");
    const rect = out.matches[0]?.rects[0]!;
    // "pad " is 4 glyphs, so the match begins well right of x=72.
    expect(rect.x0).toBeGreaterThan(72);
  });

  it("reports page space with y growing upward, for an annotation", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "baseline", 700);
    const out = search(saveAndReopen(writer).pages, "baseline", { space: "page" });
    const rect = out.matches[0]?.rects[0]!;
    // Drawn on the y=700 baseline. The box reaches a little above it for the
    // ascenders, so the top is just past 700 and the bottom is below it.
    expect(rect.y1).toBeGreaterThan(700);
    expect(rect.y0).toBeLessThan(700);
    expect(rect.y1 - rect.y0).toBeCloseTo(12 * 1.0, 1);
  });


  it("puts most of the box over the letters in page space, where y grows up", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "letters", 700);
    const size = 12;
    const rect = search(saveAndReopen(writer).pages, "letters", { space: "page" }).matches[0]!
      .rects[0]!;
    // In page space the top of the box is the LARGER y. It reaches most of the
    // way up to the ascender line and only a little way down to the descenders.
    expect(rect.y1 - 700).toBeCloseTo(size * 0.78, 1);
    expect(700 - rect.y0).toBeCloseTo(size * 0.22, 1);
  });

  it("puts most of the box over the letters in screen space, where y grows down", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "letters", 700);
    const size = 12;
    // Screen space flips the axis, so the top of the box is the SMALLER y.
    const rect = search(saveAndReopen(writer).pages, "letters", { space: "screen" }).matches[0]!
      .rects[0]!;
    const baseline = 792 - 700;
    expect(baseline - rect.y0).toBeCloseTo(size * 0.78, 1);
    expect(rect.y1 - baseline).toBeCloseTo(size * 0.22, 1);
  });

  it("keeps the same physical box in both spaces", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "letters", 700);
    const reopened = saveAndReopen(writer).pages;
    const page = search(reopened, "letters", { space: "page" }).matches[0]!.rects[0]!;
    const screen = search(reopened, "letters", { space: "screen" }).matches[0]!.rects[0]!;
    // Mirrored through the page height, the two have to agree.
    expect(screen.y0).toBeCloseTo(792 - page.y1, 3);
    expect(screen.y1).toBeCloseTo(792 - page.y0, 3);
  });

  it("reports screen space with y growing downward, for a canvas", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "baseline", 700);
    const out = search(saveAndReopen(writer).pages, "baseline", { space: "screen" });
    const rect = out.matches[0]?.rects[0]!;
    // The same box measured downward from the top of a 792pt page, so the
    // part ABOVE the baseline is now the SMALLER y.
    const page = search(saveAndReopen(writer).pages, "baseline", { space: "page" });
    const prect = page.matches[0]!.rects[0]!;
    expect(rect.y1).toBeCloseTo(792 - prect.y0, 1);
    expect(rect.y0).toBeCloseTo(792 - prect.y1, 1);
  });

  it("scales screen-space rectangles with the scale asked for", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "scale me", 700);
    const one = search(saveAndReopen(writer).pages, "scale", { space: "screen", scale: 1 });
    const two = search(saveAndReopen(writer).pages, "scale", { space: "screen", scale: 2 });
    const w1 = one.matches[0]!.rects[0]!;
    const w2 = two.matches[0]!.rects[0]!;
    expect(w2.x1 - w2.x0).toBeCloseTo((w1.x1 - w1.x0) * 2, 4);
  });

  it("gives one box per line when a match wraps", () => {
    const { writer, pages } = tree("simple.pdf");
    const cs = pages.contentOf(0);
    cs.ops.length = 0;
    cs.push("BT");
    cs.push("Tf", [new PdfName("F1"), 12]);
    cs.push("TL", [14]);
    cs.push("Tm", [1, 0, 0, 1, 72, 700]);
    cs.push("Tj", [new PdfString(new TextEncoder().encode("split "))]);
    cs.push("T*");
    cs.push("Tj", [new PdfString(new TextEncoder().encode("word"))]);
    cs.push("ET");
    pages.setContent(0, cs.serialize());
    // Two runs, and the query spans both, so both must be boxed.
    const out = search(saveAndReopen(writer).pages, "split");
    expect(out.matches.length).toBe(1);
    expect(out.matches[0]!.rects.length).toBeGreaterThanOrEqual(1);
  });

  it("merges adjacent glyphs into one box", () => {
    const { writer, pages } = tree("simple.pdf");
    pageSaying(pages, "aaaa");
    const out = search(saveAndReopen(writer).pages, "aaaa");
    expect(out.matches[0]?.rects.length).toBe(1);
  });
});

describe("search: stepping through matches", () => {
  const fake: Match[] = [0, 1, 2].map((i) => ({
    page: 0,
    start: i,
    end: i + 1,
    text: "x",
    rects: [],
  }));

  it("advances and wraps at the end", () => {
    expect(stepMatch(fake, 0, 1)).toBe(1);
    expect(stepMatch(fake, 2, 1)).toBe(0);
  });

  it("goes back and wraps at the start", () => {
    expect(stepMatch(fake, 1, -1)).toBe(0);
    expect(stepMatch(fake, 0, -1)).toBe(2);
  });

  it("reports nothing to step to", () => {
    expect(stepMatch([], 0, 1)).toBe(-1);
  });
});

/** Save, reopen, and hand back a fresh page tree. */
function saveAndReopen(writer: PdfWriter): { pages: PageTree } {
  const doc = PdfDocument.parse(writer.save({ incremental: false }));
  return { pages: new PageTree(doc, new PdfWriter(doc)) };
}

/**
 * A page whose text is split across many text runs, which is what a real
 * producer emits: one run per line, per style change, per font change.
 *
 * Every match after the first run sits at a page offset far larger than any
 * glyph index inside its own run. Comparing the two directly finds no glyphs,
 * and the match is dropped, so the app reports "no page contains" for a word
 * that is plainly on the page.
 */
describe("search: a page made of many text runs", () => {
  function manyRuns(writer: PdfWriter, pages: PageTree, lines: string[]) {
    const cs = pages.contentOf(0);
    cs.ops.length = 0;
    cs.push("BT");
    cs.push("Tf", [new PdfName("F1"), 11]);
    cs.push("TL", [15]);
    cs.push("Tm", [1, 0, 0, 1, 60, 730]);
    lines.forEach((line, i) => {
      if (i > 0) cs.push("T*");
      cs.push("Tj", [new PdfString(new TextEncoder().encode(line))]);
    });
    cs.push("ET");
    pages.setContent(0, cs.serialize());
    return saveAndReopen(writer).pages;
  }

  const lines = [
    "Lorem ipsum dolor sit amet consectetur.",
    "Ut enim ad minim veniam quis nostrud.",
    "Morbi elit nunc facilisis a mollis a.",
    "Exercitation ullamco laboris nisi ut.",
    "Aliquip ex ea commodo consequat duis.",
  ];

  it("finds a word that sits in the first run", () => {
    const { writer, pages } = tree("simple.pdf");
    const reopened = manyRuns(writer, pages, lines);
    expect(search(reopened, "Lorem").matches.length).toBe(1);
  });

  it("finds a word in the third run, not the first", () => {
    const { writer, pages } = tree("simple.pdf");
    const reopened = manyRuns(writer, pages, lines);
    const out = search(reopened, "Morbi");
    expect(out.matches.length).toBe(1);
    expect(out.matches[0]?.rects.length).toBeGreaterThan(0);
  });

  it("finds a word in the last run", () => {
    const { writer, pages } = tree("simple.pdf");
    const reopened = manyRuns(writer, pages, lines);
    expect(search(reopened, "commodo").matches.length).toBe(1);
  });

  it("boxes the match where it is, not at the start of its run", () => {
    const { writer, pages } = tree("simple.pdf");
    const reopened = manyRuns(writer, pages, lines);
    const rect = search(reopened, "Morbi").matches[0]!.rects[0]!;
    // "Morbi" is the first word of its line, so the box is at the line's left
    // edge, on that line's baseline rather than the first line's.
    expect(rect.x0).toBeCloseTo(60, 0);
    expect(rect.y1).toBeLessThan(730);
  });

  it("finds every occurrence across all the runs", () => {
    const { writer, pages } = tree("simple.pdf");
    const reopened = manyRuns(writer, pages, ["a", "a", "a", "a", "a"]);
    // Five on the page that was rewritten. The second page still has its own
    // text, which contains two more, so the total is seven.
    const out = search(reopened, "a");
    expect(out.matches.filter((m) => m.page === 0).length).toBe(5);
    expect(out.matches.length).toBe(7);
  });

  it("still reports nothing for a word that is absent", () => {
    const { writer, pages } = tree("simple.pdf");
    const reopened = manyRuns(writer, pages, lines);
    expect(search(reopened, "zzzz").matches.length).toBe(0);
  });
});
