/**
 * Content streams: the instructions that draw a page.
 *
 * A page is a flat list of operations, each a stack of operands then an
 * operator. There is no tree, so the useful work is the state machine: `q` and
 * `Q` push and pop graphics state, and text position rides in two matrices
 * that only the operators move. Walking that machine is what makes text
 * findable, which is the base for search, compare and real text editing.
 */

import { Matrix } from "./graphics";
import { Lexer } from "./lexer";
import { parseObject } from "./parser";
import { FontInfo } from "./fonts";
import { PdfDict, PdfName, PdfStream, PdfString, isArray, isDict, isStream, type PdfObject } from "./objects";
import { serializeObject } from "./writer";
import type { PdfDocument } from "./document";

export type Operand = PdfObject | InlineImage;

export interface Operation {
  op: string;
  operands: Operand[];
}

/** An inline image is kept as the bytes from `BI` to `EI`, untouched. */
export interface InlineImage {
  raw: Uint8Array;
}

function isInlineImage(v: Operand): v is InlineImage {
  return typeof v === "object" && v !== null && "raw" in v;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class ContentStream {
  readonly ops: Operation[] = [];

  get count(): number {
    return this.ops.length;
  }

  static parse(data: Uint8Array): ContentStream {
    const cs = new ContentStream();
    const lex = new Lexer(data);
    let operands: Operand[] = [];

    for (;;) {
      const save = lex.pos;
      let t;
      try {
        t = lex.nextToken();
      } catch {
        break;
      }
      if (t.type === "eof") break;

      if (t.type === "num") {
        operands.push(t.value as number);
      } else if (t.type === "name") {
        operands.push(new PdfName(String(t.value)));
      } else if (t.type === "str") {
        operands.push(new PdfString(t.value as Uint8Array));
      } else if (t.type === "arrOpen" || t.type === "dictOpen") {
        // Hand the whole composite to the object parser, so nesting survives.
        try {
          operands.push(parseObject(lex, t));
        } catch {
          operands.push(null);
        }
      } else if (t.type === "arrClose" || t.type === "dictClose") {
        // A stray closer. Drop it rather than corrupting the operand stack.
        continue;
      } else {
        const op = String(t.value);
        if (op === "true" || op === "false") {
          operands.push(op === "true");
          continue;
        }
        if (op === "null") {
          operands.push(null);
          continue;
        }
        if (op === "BI") {
          const end = findInlineImageEnd(data, lex.pos);
          const raw = data.subarray(save, end);
          cs.ops.push({ op: "BI", operands: [{ raw }] });
          lex.pos = end;
          operands = [];
          continue;
        }
        cs.ops.push({ op, operands });
        operands = [];
      }
      // A damaged stream can push operands forever. Drop the excess.
      if (operands.length > 64) operands = [];
    }
    return cs;
  }

  serialize(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const { op, operands } of this.ops) {
      if (op === "BI") {
        const first = operands[0];
        if (first !== undefined && isInlineImage(first)) parts.push(first.raw);
        continue;
      }
      let len = op.length + 1; // operator plus the newline
      const rendered = operands
        .filter((v): v is PdfObject => !isInlineImage(v))
        .map((v) => serializeObject(v));
      for (const r of rendered) len += r.length + 1; // operand plus a space
      const buf = new Uint8Array(len);
      let p = 0;
      for (const r of rendered) {
        buf.set(r, p);
        p += r.length;
        buf[p++] = 0x20;
      }
      for (let i = 0; i < op.length; i++) buf[p++] = op.charCodeAt(i) & 0xff;
      buf[p++] = 0x0a;
      parts.push(buf);
    }
    return concat(parts);
  }

  push(op: string, operands: Operand[] = []): this {
    this.ops.push({ op, operands });
    return this;
  }

  unshift(op: string, operands: Operand[] = []): this {
    this.ops.unshift({ op, operands });
    return this;
  }
}

/** `EI` must be preceded by whitespace, otherwise it may be image data. */
function findInlineImageEnd(data: Uint8Array, from: number): number {
  for (let i = Math.max(1, from); i + 1 < data.length; i++) {
    if (data[i] === 0x45 && data[i + 1] === 0x49) {
      const before = data[i - 1] as number;
      const isSpace = before === 0x20 || before === 0x0a || before === 0x0d || before === 0x09 || before === 0x00;
      if (!isSpace) continue;
      return Math.min(data.length, i + 2);
    }
  }
  return data.length;
}

// ----------------------------------------------------------------- resources

/** `/Resources`, with font programs read once and cached. */
export class Resources {
  private readonly fonts = new Map<string, FontInfo | null>();

  constructor(
    private readonly doc: PdfDocument,
    private readonly dict: PdfDict | null,
  ) {}

  get raw(): PdfDict | null {
    return this.dict;
  }

  font(name: string): FontInfo | null {
    if (this.fonts.has(name)) return this.fonts.get(name) ?? null;
    let info: FontInfo | null = null;
    const fonts = this.dict ? this.doc.resolve(this.dict.get("Font") ?? null) : null;
    if (isDict(fonts)) {
      const fd = this.doc.resolve(fonts.get(name) ?? null);
      if (isDict(fd)) {
        try {
          info = new FontInfo(name, fd, this.doc);
        } catch {
          info = null;
        }
      }
    }
    this.fonts.set(name, info);
    return info;
  }

  xObject(name: string): PdfStream | null {
    const xs = this.dict ? this.doc.resolve(this.dict.get("XObject") ?? null) : null;
    if (!isDict(xs)) return null;
    const v = this.doc.resolve(xs.get(name) ?? null);
    return isStream(v) ? v : null;
  }

  extGState(name: string): PdfDict | null {
    const gs = this.dict ? this.doc.resolve(this.dict.get("ExtGState") ?? null) : null;
    if (!isDict(gs)) return null;
    const v = this.doc.resolve(gs.get(name) ?? null);
    return isDict(v) ? v : null;
  }

  fontNames(): string[] {
    const fonts = this.dict ? this.doc.resolve(this.dict.get("Font") ?? null) : null;
    return isDict(fonts) ? [...fonts.keys()] : [];
  }
}

// ---------------------------------------------------------------------- state

export class GraphicsState {
  ctm: Matrix;
  strokeColor: number[] = [0, 0, 0];
  fillColor: number[] = [0, 0, 0];
  lineWidth = 1;
  fontName: string | null = null;
  fontSize = 0;
  font: FontInfo | null = null;
  charSpacing = 0;
  wordSpacing = 0;
  horizontalScale = 1;
  leading = 0;
  rise = 0;
  renderMode = 0;
  textMatrix: Matrix;
  lineMatrix: Matrix;

  constructor(ctm: Matrix = Matrix.identity) {
    this.ctm = ctm;
    this.textMatrix = Matrix.identity;
    this.lineMatrix = Matrix.identity;
  }

  /** `Td` moves the line origin, and the text position follows it. */
  moveLine(tx: number, ty: number): void {
    this.lineMatrix = Matrix.concat(Matrix.translation(tx, ty), this.lineMatrix);
    this.textMatrix = this.lineMatrix;
  }

  clone(): GraphicsState {
    const g = new GraphicsState(this.ctm);
    g.strokeColor = this.strokeColor.slice();
    g.fillColor = this.fillColor.slice();
    g.lineWidth = this.lineWidth;
    g.fontName = this.fontName;
    g.fontSize = this.fontSize;
    g.font = this.font;
    g.charSpacing = this.charSpacing;
    g.wordSpacing = this.wordSpacing;
    g.horizontalScale = this.horizontalScale;
    g.leading = this.leading;
    g.rise = this.rise;
    g.renderMode = this.renderMode;
    g.textMatrix = this.textMatrix;
    g.lineMatrix = this.lineMatrix;
    return g;
  }
}

export interface TextRun {
  text: string;
  /** Device-space origin of the run. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  ctm: Matrix;
}

export interface TextResult {
  runs: TextRun[];
  text: string;
}

/** Operators that end the current line of text. */
const TEXT_BREAK = new Set([
  "m", "l", "c", "v", "y", "h", "re",
  "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*",
  "Tj", "TJ", "'", '"',
]);

export function breaksTextLine(op: string): boolean {
  return TEXT_BREAK.has(op);
}

/**
 * Run the state machine and collect the text with its position on the page.
 * `baseCtm` is the page-to-device transform, so a page can be run scaled or
 * rotated and the coordinates come back in the space the caller asked for.
 */
export function extractText(cs: ContentStream, resources: Resources, baseCtm: Matrix = Matrix.identity): TextResult {
  const stack: GraphicsState[] = [];
  let gs = new GraphicsState(baseCtm);
  const runs: TextRun[] = [];
  let out = "";

  for (const { op, operands } of cs.ops) {
    switch (op) {
      case "q":
        stack.push(gs.clone());
        break;
      case "Q": {
        const prev = stack.pop();
        if (prev) gs = prev;
        break;
      }
      case "cm":
        if (hasNumbers(operands, 6)) gs.ctm = Matrix.concat(matrixOf(operands), gs.ctm);
        break;
      case "BT":
        gs.textMatrix = Matrix.identity;
        gs.lineMatrix = Matrix.identity;
        break;
      case "Tf": {
        const name = operands[0];
        const size = operands[1];
        if (name instanceof PdfName) {
          gs.fontName = name.name;
          gs.font = resources.font(name.name);
        }
        if (typeof size === "number") gs.fontSize = size;
        break;
      }
      case "Tc":
        if (typeof operands[0] === "number") gs.charSpacing = operands[0];
        break;
      case "Tw":
        if (typeof operands[0] === "number") gs.wordSpacing = operands[0];
        break;
      case "Tz":
        if (typeof operands[0] === "number") gs.horizontalScale = operands[0] / 100;
        break;
      case "TL":
        if (typeof operands[0] === "number") gs.leading = operands[0];
        break;
      case "Ts":
        if (typeof operands[0] === "number") gs.rise = operands[0];
        break;
      case "Tr":
        if (typeof operands[0] === "number") gs.renderMode = operands[0];
        break;
      case "Tm":
        if (hasNumbers(operands, 6)) {
          gs.textMatrix = matrixOf(operands);
          gs.lineMatrix = gs.textMatrix;
        }
        break;
      case "Td":
        if (hasNumbers(operands, 2)) gs.moveLine(operands[0] as number, operands[1] as number);
        break;
      case "TD":
        if (hasNumbers(operands, 2)) {
          gs.leading = -(operands[1] as number);
          gs.moveLine(operands[0] as number, operands[1] as number);
        }
        break;
      case "T*":
        gs.moveLine(0, -gs.leading);
        break;
      case "Tj": {
        const s = operands[0];
        if (s instanceof PdfString) out += showText(s.bytes, gs, runs);
        break;
      }
      case "TJ": {
        const arr = operands[0];
        if (isArray(arr)) {
          for (const item of arr) {
            if (item instanceof PdfString) {
              out += showText(item.bytes, gs, runs);
            } else if (typeof item === "number") {
              // A number is a gap in thousandths of the font size, moved left.
              const shift = (-item / 1000) * gs.fontSize * gs.horizontalScale;
              gs.moveLine(shift, 0);
            }
          }
        }
        break;
      }
      case "'": {
        gs.moveLine(0, -gs.leading);
        const s = operands[0];
        if (s instanceof PdfString) out += showText(s.bytes, gs, runs);
        break;
      }
      case '"': {
        if (typeof operands[0] === "number") gs.wordSpacing = operands[0];
        if (typeof operands[1] === "number") gs.charSpacing = operands[1];
        gs.moveLine(0, -gs.leading);
        const s = operands[2];
        if (s instanceof PdfString) out += showText(s.bytes, gs, runs);
        break;
      }
      default:
        break;
    }
  }

  return { runs, text: out };
}

/**
 * Show one string, record where it landed, and advance the text position.
 *
 * The advance already carries the font size, because `w0` is in em and the
 * spec's displacement multiplies it by the font size. So the rendering matrix
 * here is `Tm x CTM` and nothing else: folding the font size in a second time
 * would scale every run box by the square of it.
 */
function showText(bytes: Uint8Array, gs: GraphicsState, runs: TextRun[]): string {
  const font = gs.font;
  if (!font) return "";

  // A Type0 font addresses glyphs with two bytes, a simple font with one.
  const twoByte = font.subtype === "Type0";
  let text = "";
  let advance = 0;

  for (let i = 0; i < bytes.length; ) {
    let code: number;
    if (twoByte) {
      code = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
      i += 2;
    } else {
      code = bytes[i] as number;
      i += 1;
    }
    const w0 = font.widthOf(code);
    const wordSpacing = code === 32 && !twoByte ? gs.wordSpacing : 0;
    advance += (w0 * gs.fontSize + gs.charSpacing + wordSpacing) * gs.horizontalScale;
    text += font.textOf(code);
  }

  const trm = Matrix.concat(gs.textMatrix, gs.ctm);
  const start = trm.apply(0, gs.rise);
  const end = trm.apply(advance, gs.rise);

  if (text.length > 0) {
    runs.push({
      text,
      x: start.x,
      y: start.y,
      width: Math.hypot(end.x - start.x, end.y - start.y),
      height: gs.fontSize * gs.ctm.scaleFactor(),
      fontName: gs.fontName ?? "",
      fontSize: gs.fontSize,
      ctm: gs.ctm,
    });
  }

  gs.moveLine(advance, 0);
  return text;
}

function hasNumbers(operands: Operand[], n: number): boolean {
  if (operands.length < n) return false;
  for (let i = 0; i < n; i++) if (typeof operands[i] !== "number") return false;
  return true;
}

function matrixOf(operands: Operand[]): Matrix {
  return new Matrix(
    operands[0] as number,
    operands[1] as number,
    operands[2] as number,
    operands[3] as number,
    operands[4] as number,
    operands[5] as number,
  );
}
