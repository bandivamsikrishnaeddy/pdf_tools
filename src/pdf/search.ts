/**
 * Search across pages, with the rectangle of every match.
 *
 * A viewer is expected to highlight EVERY occurrence, not the first one per
 * page, and to be able to step through them. That needs the box of each matched
 * glyph, not the box of the whole text run, because glyph widths are not
 * equal and a run can be far wider than the word inside it.
 *
 * The rectangles come back in whichever space the caller asks for. `"page"`
 * gives raw PDF user space with y growing upward, which is what an annotation
 * has to be written in. `"screen"` gives the display space at `scale`, ready
 * to draw on a canvas.
 */

import { Matrix } from "./graphics";
import type { TextRun, TextResult } from "./content-stream";
import type { PageTree } from "./page-tree";

export interface HighlightRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Match {
  page: number;
  /** Character offset of the match in that page's text. */
  start: number;
  end: number;
  text: string;
  /** One box per line of matched glyphs. */
  rects: HighlightRect[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Cap the number of matches so a one-letter query cannot stall the UI. */
  limit?: number;
  /** Which space the rectangles are in. Default `"screen"`. */
  space?: "page" | "screen";
  /** Display scale, used only in `"screen"` space. */
  scale?: number;
}

export interface SearchResult {
  query: string;
  matches: Match[];
  /** True when the limit cut the search short. */
  truncated: boolean;
  pagesSearched: number;
}

const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

/**
 * The boxes of the glyphs that a character range covers, merged per line.
 *
 * `yDown` says which way the y axis grows in the space being reported. The
 * padding around the baseline has to follow it, or a highlight drawn on a
 * canvas lands under the text instead of over it.
 */
function rectsForRange(
  run: TextRun,
  from: number,
  to: number,
  lineHeight: number,
  yDown: boolean,
): HighlightRect[] {
  const out: HighlightRect[] = [];
  let current: HighlightRect | null = null;
  // +1 when y grows upward, -1 when it grows downward.
  const dir = yDown ? -1 : 1;

  for (const g of run.glyphs) {
    // A glyph covers the characters [g.start, g.start + n). Touch it when the
    // ranges overlap at all.
    const glyphEnd = g.start + 1;
    if (glyphEnd <= from || g.start >= to) continue;
    const box: HighlightRect = {
      x0: g.x,
      y0: g.y - dir * lineHeight * 0.82,
      x1: g.x + g.width,
      y1: g.y + dir * lineHeight * 0.22,
    };
    if (
      current &&
      Math.abs(current.y0 - box.y0) < 0.6 &&
      Math.abs(current.y1 - box.y1) < 0.6 &&
      box.x0 <= current.x1 + lineHeight * 0.6
    ) {
      current.x1 = Math.max(current.x1, box.x1);
      current.y0 = Math.min(current.y0, box.y0);
      current.y1 = Math.max(current.y1, box.y1);
    } else {
      if (current) out.push(current);
      current = box;
    }
  }
  if (current) out.push(current);
  // Callers get y0 as the top and y1 as the bottom whichever way the axis
  // grew, so a rectangle can be handed straight to an annotation.
  return out.map((r) => ({
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  }));
}

/**
 * Find every occurrence of `query` in the document.
 *
 * The text of a page is the concatenation of its runs, so a match is located in
 * that string and then mapped back onto the runs it covers. A match that
 * straddles two runs is still found, because the offsets are global to the page.
 */
export function search(pages: PageTree, query: string, opts: SearchOptions = {}): SearchResult {
  const limit = opts.limit ?? 2000;
  const matches: Match[] = [];
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  let truncated = false;
  let pagesSearched = 0;

  if (needle.length === 0) {
    return { query, matches, truncated: false, pagesSearched: 0 };
  }

  const scale = opts.scale ?? 1;
  const userSpace = opts.space === "page";
  const textAt = (p: number): TextResult =>
    userSpace ? pages.textOf(p, 1, Matrix.identity) : pages.textOf(p, scale);

  for (let p = 0; p < pages.count; p++) {
    pagesSearched++;
    const result = textAt(p);
    const haystack = opts.caseSensitive ? result.text : result.text.toLowerCase();
    if (!haystack.includes(needle)) continue;

    // Record where each run starts in the page string, so a match can be
    // attributed to the runs it actually covers.
    const spans: Array<{ run: TextRun; from: number; to: number }> = [];
    let at = 0;
    for (const run of result.runs) {
      spans.push({ run, from: at, to: at + run.text.length });
      at += run.text.length;
    }

    // Matches do not overlap, the same as a browser's find-in-page: stepping
    // forward one character would report "aa" inside a match already shown.
    let from = 0;
    for (;;) {
      const hit = haystack.indexOf(needle, from);
      if (hit < 0) break;
      from = hit + needle.length;

      if (opts.wholeWord) {
        if (isWordChar(haystack[hit - 1]) || isWordChar(haystack[hit + needle.length])) continue;
      }

      const start = hit;
      const end = hit + needle.length;
      const rects: HighlightRect[] = [];
      for (const s of spans) {
        if (s.to <= start || s.from >= end) continue;
        rects.push(...rectsForRange(s.run, start, end, Math.max(1, s.run.height), !userSpace));
      }
      if (rects.length === 0) continue;

      matches.push({ page: p, start, end, text: result.text.slice(start, end), rects });
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return { query, matches, truncated, pagesSearched };
}

/** The index of the first match on or after `from`, wrapping to the start. */
export function stepMatch(matches: Match[], current: number, delta: number): number {
  if (matches.length === 0) return -1;
  const next = current + delta;
  if (next < 0) return matches.length - 1;
  if (next >= matches.length) return 0;
  return next;
}
