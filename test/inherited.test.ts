import { describe, expect, it } from "vitest";
import { tree } from "./helpers";
import { isDict } from "../src/pdf/objects";

/**
 * Every key a page can inherit may arrive as an INDIRECT REFERENCE, and real
 * producers do exactly that. Reading the raw value instead of resolving it
 * finds no font dictionary, so a page full of text reports zero text and the
 * document looks blank. The fixtures in this file all have `/Resources` and
 * `/MediaBox` as references for that reason.
 */
describe("page tree: inherited keys that are indirect references", () => {
  it("resolves an inherited /Resources to a real dictionary", () => {
    const { pages } = tree("indirect.pdf");
    expect(pages.resources(0).raw).not.toBeNull();
    expect(isDict(pages.resources(0).raw)).toBe(true);
  });

  it("finds the font that lives in the referenced resource dictionary", () => {
    const { pages } = tree("indirect.pdf");
    expect(pages.resources(0).fontNames()).toEqual(["F1"]);
  });

  it("reads the text on the page instead of reporting an empty one", () => {
    const { pages } = tree("indirect.pdf");
    const t = pages.textOf(0);
    expect(t.runs.length).toBeGreaterThan(0);
    expect(t.text).toBe("Indirect Resource Page");
  });

  it("places that text at the position the content stream asked for", () => {
    const { pages } = tree("indirect.pdf");
    const run = pages.textOf(0).runs[0];
    expect(run?.x).toBeCloseTo(72, 4);
    expect(run?.y).toBeCloseTo(792 - 700, 4);
  });

  it("resolves an inherited /MediaBox that is a reference to an array", () => {
    const { pages } = tree("indirect.pdf");
    expect(pages.mediaBox(0)).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it("needs no repair to get there", () => {
    const { doc } = tree("indirect.pdf");
    expect(doc.repairs).toEqual([]);
  });
});

describe("page tree: the same keys written directly", () => {
  it("gives the same answer, so the fix is not a special case", () => {
    const direct = tree("simple.pdf");
    const indirect = tree("indirect.pdf");
    expect(indirect.pages.resources(0).fontNames()).toEqual(["F1"]);
    expect(indirect.pages.mediaBox(0)).toEqual(direct.pages.mediaBox(0));
    expect(indirect.pages.rotation(0)).toBe(direct.pages.rotation(0));
  });
});
