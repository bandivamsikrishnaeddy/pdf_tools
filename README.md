# PDF Tools

A PDF application with its own PDF engine. There is no PDF library in this
repository — the lexer, parser, writer, stream filters, font metrics and page
tree are written from the file format up, and the app runs entirely in the
browser.

**Live:** https://pdftools-three-rouge.vercel.app

Nothing is uploaded. A file is read with `File.arrayBuffer()` and never leaves
the device.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 172 tests
npm run typecheck  # tsc --noEmit, strict
npm run build      # production bundle into dist/
```

Node 20 or newer. No other tooling, no native modules, no API keys.

---

## What it does today

| | |
|---|---|
| Opens | classic xref tables, xref streams, object streams, incremental updates |
| Recovers | files whose index is damaged, by scanning for object headers |
| Filters | Flate, LZW, ASCIIHex, ASCII85, RunLength, PNG and TIFF predictors |
| Pages | add, delete, duplicate, reorder, rotate, resize, scale content with the page |
| Structure | bookmarks, printed page labels, inherited page attributes |
| Text | extracts every run with its real position, widths from the file's own font metrics |
| Search | every occurrence, highlighted in place, with a counter, next/previous, whole-word and match-case |
| Saves | a full rewrite, or an append that leaves every original byte untouched |

### Not yet

- **No OCR.** A scanned page has no text layer, so it stays blank. The app says
  so rather than showing an empty page.
- **No encryption.** `/Encrypt` is detected and reported; strings and streams
  stay locked.
- **No image or vector rendering.** The page view draws the text layer only,
  positioned from the file's own font widths. A monospace face stands in for
  the document's fonts, stretched to each run's real box.
- **No writing of object streams or xref streams.** Saving emits a classic
  index, even when the input used a stream index.
- No font program parsing, so Type1 and TrueType programs are not inspected;
  widths come from `/Widths` and `/MissingWidth`.
- No outline writing, no named destinations.

---

## How it is put together

```
src/pdf/
  lexer.ts          bytes -> tokens
  parser.ts         tokens -> the eight object types, indirect objects, streams
  objects.ts        the object model
  filters.ts        stream filters and predictors
  document.ts       xref chains, object streams, repair
  writer.ts         serialisation, full rewrite, incremental append
  graphics.ts       affine transforms in PDF composition order
  fonts.ts          widths, encodings, ToUnicode CMaps
  content-stream.ts content-stream state machine, text with per-glyph boxes
  page-tree.ts      inheritance, page operations, outline, page labels
  search.ts         every occurrence, with the rectangle of each match
```

The engine has no DOM dependency and no Node dependency. `tsconfig` sets
`"types": []` so no ambient globals leak in, and the app layer is the only
place that touches a browser API.

### Two decisions worth knowing

**An incremental save appends; it does not rewrite.** The output starts with
the original bytes, unchanged, and the new index section points back at the old
one with `/Prev`. That is what keeps a large file quick to save and what would
keep an existing signature valid. There is a test that compares the first
`original.length` bytes one at a time.

**A page's inherited keys are resolved, not read raw.** `/Resources` and
`/MediaBox` are very often indirect references. Returning the pointer instead
of the object means no font is found and every text operator bails out, so a
page full of text reports zero text with no error anywhere.

---

## Testing

189 tests, all of them reading real PDF bytes.

**The fixtures are not produced by the code under test.** `test/make_fixtures.py`
is a separate implementation in Python. A suite built from the engine's own
writer can only prove the writer agrees with itself.

**The fixtures are real PDFs.** Every one is opened by macOS CoreGraphics via
`qlmanage`, which is an entirely separate implementation. A file the engine
produces and CoreGraphics rejects is a broken fixture, not a broken engine.

**Every fix is checked against a mutation.** Reverting the inherited-key fix
fails 5 of the tests added for it. A check that cannot fail is not a check.

The generated fixtures between them cover: a classic index, Flate-compressed
streams, an object stream with an xref stream, an incremental update, every
cross-reference offset shifted by 5000 bytes, a nested page tree with an
intermediate node, every inheritable key behind an indirect reference, a page
built from many text runs advanced with `TL` and `T*`, page labels in three
formats, and a two-level bookmark tree.

**`public/sample.pdf` is not generated.** It is a real PDF 1.3 file from a real
producer, and it is both the demo the app opens and the specimen the suite reads
in `test/real-world.test.ts`. It does three things no generated fixture did:

- every inherited key arrives as an indirect reference
- every font is declared at 1pt and scaled with `Tm`
- 781 text runs sit on one page

A suite built only from easy fixtures agreed with itself for a long time. Two
of the bugs in the table above were invisible to every one of them, because a
hand-built page has a single text run per page and a match at offset 0 of its
run happens to share its page offset.

---

## Bugs this project found in itself

Each of these produced a file that still opened, so none of them would have
shown up as a crash.

| Bug | Why it was invisible |
|---|---|
| Incremental save did not seed the original bytes | produced a valid standalone file, just not an append |
| PDF strings written without their parentheses | wrote a corrupt but parseable file |
| First xref entry consumed 1 byte instead of a 20-byte record | shifted every entry by one object, and the repair pass silently hid it |
| A *free* xref entry triggered a full index rebuild | the rebuild cleared the object cache and discarded edits |
| Flate written as raw DEFLATE, read as zlib | nothing the writer compressed could be read back |
| Glyph size ignored the text matrix | a 1pt font scaled by `Tm` drew one pixel tall; positions were already correct |
| Highlight rectangles inverted in screen space | the box sat below the baseline instead of over the text |
| Inherited keys returned unresolved | 26 parts parsed, 0 repairs, 0 characters |
| Match offsets compared page-wide against run-local glyph indices | every match after the first run found no glyphs, so search reported "no page contains" for words plainly on the page |
| `Tj` advanced the line matrix as well as the text matrix | every following `T*` started where the last line ended, so text walked diagonally off the page |

---

## Stack

TypeScript (strict, `noUncheckedIndexedAccess`), Vite, Vitest, and `fflate` for
zlib. `fflate` is the only runtime dependency. Neobrutalist interface on three
colours — `#3F8AB1`, `#FBE449`, `#F62731` — with black ink and hard shadows.
