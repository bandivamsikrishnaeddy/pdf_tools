/**
 * Fonts: the widths and the character map.
 *
 * Two jobs live here. Widths decide where the next glyph lands, so a cursor
 * position can be reported. The character map turns byte codes into text, so a
 * search can find a word. Both are read from the file; neither is guessed.
 */

import { Matrix } from "./graphics";
import { Lexer } from "./lexer";
import { PdfDict, PdfName, isArray, isDict, isStream, type PdfObject } from "./objects";
import type { PdfDocument } from "./document";

export interface GlyphMetrics {
  /** Width in text-space units, already divided by 1000. */
  width: number;
  /** Code points the glyph draws, from ToUnicode when present. */
  unicode: string;
}

export class FontInfo {
  readonly subtype: string;
  readonly baseFont: string;
  readonly name: string;

  /** The font matrix, defaulting to the usual 1/1000 scale. */
  readonly fontMatrix: Matrix;
  readonly firstChar: number;
  readonly defaultWidth: number;
  /** Index in text space is code - firstChar. */
  readonly widths: number[];

  private readonly toUnicode = new Map<number, string>();
  private readonly differences = new Map<number, string>();
  private readonly baseEncoding = new Map<number, string>();

  constructor(name: string, dict: PdfDict, doc: PdfDocument) {
    this.name = name;
    this.subtype = dict.getName("Subtype") ?? "Type1";
    this.baseFont = dict.getName("BaseFont") ?? "";
    this.firstChar = dict.getNumber("FirstChar") ?? 0;
    this.defaultWidth = 0;

    const desc = doc.resolve(dict.get("FontDescriptor") ?? null);
    const descDict = isDict(desc) ? desc : null;
    const mw = descDict?.getNumber("MissingWidth") ?? 0;
    this.defaultWidth = mw / 1000;

    const wArr = doc.resolve(dict.get("Widths") ?? null);
    const raw: number[] = [];
    if (isArray(wArr)) {
      for (const w of wArr) if (typeof w === "number") raw.push(w / 1000);
    }
    this.widths = raw;

    const fm = doc.resolve(dict.get("FontMatrix") ?? null);
    if (isArray(fm) && fm.length === 6 && fm.every((v) => typeof v === "number")) {
      const n = fm as number[];
      this.fontMatrix = new Matrix(n[0] as number, n[1] as number, n[2] as number, n[3] as number, n[4] as number, n[5] as number);
    } else {
      this.fontMatrix = new Matrix(0.001, 0, 0, 0.001, 0, 0);
    }

    this.readBaseEncoding(doc, dict);
    this.readDifferences(doc, dict);
    this.readToUnicode(doc, dict);
  }

  /**
   * The base encoding comes from the font program, not the file, for the 14
   * standard fonts. Those tables are fixed by the spec, so they are listed
   * here rather than parsed out of a font file.
   */
  private readBaseEncoding(doc: PdfDocument, dict: PdfDict): void {
    if (this.isOneOf("Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats")) {
      return; // the tables below only matter for text fonts
    }
    this.baseEncoding.set(32, "space");
    for (let c = 65; c <= 90; c++) this.baseEncoding.set(c, String.fromCharCode(c));
    for (let c = 97; c <= 122; c++) this.baseEncoding.set(c, String.fromCharCode(c));
    for (const c of "0123456789") this.baseEncoding.set(c.charCodeAt(0), c);
    for (const [code, glyph] of Object.entries(STANDARD_ENCODING)) {
      if (glyph === "bullet") {
        // The bullet lives at 0xB7 in WinAnsi and at 0x2D in Standard.
        this.baseEncoding.set(0x2d, "bullet");
        continue;
      }
      if (glyph === "") continue;
      this.baseEncoding.set(code.charCodeAt(0), glyph);
    }
    void doc;
    void dict;
  }

  private readDifferences(doc: PdfDocument, dict: PdfDict): void {
    const enc = doc.resolve(dict.get("Encoding") ?? null);
    let base: Map<number, string> | null = null;
    let diffs: PdfObject[] | null = null;
    if (enc instanceof PdfName) {
      base = ENCODING_PRESETS[enc.name] ?? null;
    } else if (isDict(enc)) {
      const be = doc.resolve(enc.get("BaseEncoding") ?? null);
      if (be instanceof PdfName) base = ENCODING_PRESETS[be.name] ?? null;
      const d = doc.resolve(enc.get("Differences") ?? null);
      if (isArray(d)) diffs = d;
    }
    if (base) for (const [k, v] of base) this.baseEncoding.set(k, v);

    if (!diffs) return;
    let code = 0;
    for (const item of diffs) {
      const r = doc.resolve(item);
      if (typeof r === "number") {
        code = r;
      } else if (r instanceof PdfName) {
        this.differences.set(code, glyphNameToText(r.name));
        code++;
      }
    }
  }

  private readToUnicode(doc: PdfDocument, dict: PdfObject): void {
    const tu = doc.resolve((isDict(dict) ? dict.get("ToUnicode") : null) ?? null);
    if (!isStream(tu)) return;
    let text: string;
    try {
      text = latin1(doc.streamBytes(tu));
    } catch {
      return;
    }
    for (const [code, value] of parseCMapMap(text)) this.toUnicode.set(code, value);
  }

  private isOneOf(...names: string[]): boolean {
    return names.includes(this.baseFont);
  }

  /** The width of one code in text-space units. */
  widthOf(code: number): number {
    const idx = code - this.firstChar;
    if (idx >= 0 && idx < this.widths.length) return this.widths[idx] as number;
    return this.defaultWidth;
  }

  /** The character a code stands for. */
  textOf(code: number): string {
    const mapped = this.toUnicode.get(code);
    if (mapped !== undefined) return mapped;
    const diff = this.differences.get(code);
    if (diff !== undefined) return diff;
    const base = this.baseEncoding.get(code);
    if (base !== undefined) return base;
    if (code >= 32 && code < 127) return String.fromCharCode(code);
    return "";
  }

  get hasToUnicode(): boolean {
    return this.toUnicode.size > 0;
  }

  get toUnicodeSize(): number {
    return this.toUnicode.size;
  }

  /** Every code the file can turn into a character, for the structure view. */
  mappedCodes(): number[] {
    return [...new Set([...this.toUnicode.keys(), ...this.differences.keys(), ...this.baseEncoding.keys()])].sort(
      (x, y) => x - y,
    );
  }
}

/** Glyph names carry meaning in a few cases that text extraction depends on. */
function glyphNameToText(name: string): string {
  if (name.startsWith("uni") && name.length >= 7) {
    const hex = name.slice(3);
    let out = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const v = parseInt(hex.slice(i, i + 4), 16);
      if (Number.isNaN(v)) break;
      out += String.fromCharCode(v);
    }
    return out;
  }
  const stripped = name.replace(/^[A-Za-z]+$/, "");
  void stripped;
  const known: Record<string, string> = {
    space: " ",
    exclam: "!",
    quotedbl: '"',
    numbersign: "#",
    dollar: "$",
    percent: "%",
    ampersand: "&",
    quotesingle: "'",
    parenleft: "(",
    parenright: ")",
    asterisk: "*",
    plus: "+",
    comma: ",",
    hyphen: "-",
    period: ".",
    slash: "/",
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    colon: ":",
    semicolon: ";",
    less: "<",
    equal: "=",
    greater: ">",
    question: "?",
    at: "@",
    bracketleft: "[",
    backslash: "\\",
    bracketright: "]",
    asciicircum: "^",
    underscore: "_",
    grave: "`",
    braceleft: "{",
    bar: "|",
    braceright: "}",
    asciitilde: "~",
    bullet: "•",
    endash: "–",
    emdash: "—",
    quotedblleft: "“",
    quotedblright: "”",
    quoteleft: "‘",
    quoteright: "’",
    fi: "fi",
    fl: "fl",
  };
  return known[name] ?? (name.length === 1 ? name : "");
}

/** Pull `code -> string` pairs out of a ToUnicode CMap. */
export function parseCMapMap(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const lex = new Lexer(utf8ToBytes(text));
  const stack: Array<{ op: string; operands: Array<number | string | Uint8Array> }> = [];
  for (;;) {
    let t;
    try {
      t = lex.nextToken();
    } catch {
      break;
    }
    if (t.type === "eof") break;
    if (t.type === "num") {
      const top = stack[stack.length - 1];
      if (top) top.operands.push(t.value as number);
      continue;
    }
    if (t.type === "str") {
      const top = stack[stack.length - 1];
      if (top) top.operands.push(t.value as Uint8Array);
      continue;
    }
    const op = typeof t.value === "string" ? t.value : "";
    if (op === "[" || op === "]" || op === "<<" || op === ">>" || op === "beginbfchar" || op === "beginbfrange") {
      stack.push({ op, operands: [] });
      continue;
    }
    if (op === "endbfchar" || op === "endbfrange") {
      const block = popBlock(stack, "beginbfchar", "beginbfrange");
      if (block) for (const [code, value] of block) out.push([code, value]);
      continue;
    }
    if (op === "begincodespacerange") {
      popBlock(stack, "begincodespacerange");
      continue;
    }
    if (op === "endcodespacerange") continue;
  }
  return out;
}

function popBlock(
  stack: Array<{ op: string; operands: Array<number | string | Uint8Array> }>,
  ...names: string[]
): Array<[number, string]> | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!names.includes(stack[i]!.op)) continue;
    const operands = stack[i]!.operands;
    stack.length = i;
    const out: Array<[number, string]> = [];
    if (names.includes("beginbfchar")) {
      for (let k = 0; k + 1 < operands.length; k += 2) {
        const src = operands[k];
        const dst = operands[k + 1];
        if (typeof src !== "number") continue;
        out.push([src, dst instanceof Uint8Array ? utf16beToString(dst) : String(dst)]);
      }
    } else if (names.includes("beginbfrange")) {
      for (let k = 0; k + 2 < operands.length; k += 3) {
        const lo = operands[k];
        const mid = operands[k + 1];
        const hi = operands[k + 2];
        if (typeof lo !== "number" || typeof hi !== "number") continue;
        if (mid instanceof Uint8Array) {
          const base = utf16beToString(mid);
          const lastChar = base.length ? base.charCodeAt(base.length - 1) : 0;
          for (let c = lo; c <= hi && c - lo < 65536; c++) {
            out.push([c, base.slice(0, -1) + String.fromCharCode(lastChar + (c - lo))]);
          }
        }
      }
    }
    return out;
  }
  return null;
}

function utf16beToString(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < b.length; i += 2) {
      out += String.fromCharCode(((b[i] as number) << 8) | (b[i + 1] as number));
    }
    return out;
  }
  if (b.length === 1) return String.fromCharCode(b[0] as number);
  let out = "";
  for (const c of b) out += String.fromCharCode(c);
  return out;
}

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function latin1(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return out;
}

/** Latin-1 encoding of the PDF standard encoding, for `/Differences` defaults. */
const STANDARD_ENCODING: Record<string, string> = {
  " ": "space",
  "!": "exclam",
  '"': "quotedbl",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "&": "ampersand",
  "'": "quotesingle",
  "(": "parenleft",
  ")": "parenright",
  "*": "asterisk",
  "+": "plus",
  ",": "comma",
  "-": "hyphen",
  ".": "period",
  "/": "slash",
  ":": "colon",
  ";": "semicolon",
  "<": "less",
  "=": "equal",
  ">": "greater",
  "?": "question",
  "@": "at",
  "[": "bracketleft",
  "\\": "backslash",
  "]": "bracketright",
  "^": "asciicircum",
  _: "underscore",
  "`": "grave",
  "{": "braceleft",
  "|": "bar",
  "}": "braceright",
  "~": "asciitilde",
  bullet: "bullet",
};

const ENCODING_PRESETS: Record<string, Map<number, string>> = {
  WinAnsiEncoding: buildPreset({
    128: "Euro", 130: "quotesinglbase", 131: "florin", 132: "quotedblbase",
    133: "ellipsis", 134: "dagger", 135: "daggerdbl", 136: "circumflex",
    137: "perthousand", 138: "Scaron", 139: "guilsinglleft", 140: "OE",
    142: "Zcaron", 145: "quoteleft", 146: "quoteright", 147: "quotedblleft",
    148: "quotedblright", 149: "bullet", 150: "endash", 151: "emdash",
    152: "tilde", 153: "trademark", 154: "scaron", 155: "guilsinglright",
    156: "oe", 158: "zcaron", 159: "Ydieresis", 160: "space",
  }),
  MacRomanEncoding: buildPreset({
    128: "Adieresis", 129: "Aring", 130: "Ccedilla", 131: "Eacute",
    132: "Ntilde", 133: "Odieresis", 134: "Udieresis", 135: "aacute",
    136: "agrave", 137: "acircumflex", 138: "adieresis", 139: "atilde",
    140: "aring", 141: "ccedilla", 142: "eacute", 143: "egrave",
    144: "ecircumflex", 145: "edieresis", 146: "iacute", 147: "igrave",
    148: "icircumflex", 149: "idieresis", 150: "ntilde", 151: "oacute",
    152: "ograve", 153: "ocircumflex", 154: "odieresis", 155: "otilde",
    156: "uacute", 157: "ugrave", 158: "ucircumflex", 159: "udieresis",
    160: "dagger", 161: "degree", 162: "cent", 163: "sterling",
    164: "section", 165: "bullet", 166: "paragraph", 167: "germandbls",
    168: "registered", 169: "copyright", 170: "trademark", 171: "acute",
    172: "dieresis", 173: "notequal", 174: "AE", 175: "Oslash",
    176: "infinity", 177: "plusminus", 178: "lessequal", 179: "greaterequal",
    180: "yen", 181: "mu", 182: "partialdiff", 183: "summation",
    184: "product", 185: "pi", 186: "integral", 187: "ordfeminine",
    188: "ordmasculine", 189: "Omega", 190: "ae", 191: "oslash",
    192: "questiondown", 193: "Agrave", 194: "Atilde", 195: "Otilde",
    196: "OE", 197: "ordfeminine", 198: "logicalnot", 199: "radical",
    200: "florin", 201: "circumflex", 202: "tilde", 203: "macron",
    204: "breve", 205: "dotaccent", 206: "ring", 207: "cedilla",
    208: "hungarumlaut", 209: "ogonek", 210: "caron", 211: "Lslash",
    212: "Scaron", 213: "Zcaron", 214: "brokenbar", 215: "Ydieresis",
  }),
  StandardEncoding: buildPreset({
    39: "quoteright", 96: "quoteleft", 164: "exclamdown", 166: "cent",
    168: "currency", 169: "yen", 170: "brokenbar", 172: "section",
    174: "degree", 175: "plusminus", 177: "paragraph", 180: "acute",
    184: "mu", 185: "paragraph", 186: "periodcentered", 187: "cedilla",
    188: "onequarter", 189: "onehalf", 190: "threequarters",
    191: "questiondown", 208: "multiply", 234: "germandbls",
  }),
  MacExpertEncoding: new Map(),
  PDFDocEncoding: new Map(),
  SymbolEncoding: new Map(),
  ZapfDingbatsEncoding: new Map(),
};

function buildPreset(overrides: Record<number, string>): Map<number, string> {
  const m = new Map<number, string>();
  for (let c = 32; c < 127; c++) m.set(c, glyphNameToText(String.fromCharCode(c)));
  m.set(9, "\t");
  for (const [code, glyph] of Object.entries(overrides)) m.set(Number(code), glyphNameToText(glyph));
  return m;
}

export { glyphNameToText };
