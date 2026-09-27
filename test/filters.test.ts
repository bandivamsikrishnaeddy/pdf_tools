import { describe, expect, it } from "vitest";
import {
  applyPredictor,
  ascii85Decode,
  asciiHexDecode,
  flateDecode,
  flateEncode,
  lzwDecode,
  runLengthDecode,
  runLengthEncode,
} from "../src/pdf/filters";
import { PdfDict } from "../src/pdf/objects";

/**
 * The encoders below are written from the spec, separately from the decoders
 * under test, so a round trip is a real check rather than a tautology.
 */
function ascii85Encode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    const pad = 4 - chunk.length;
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0);
    if (pad === 0 && v === 0) {
      out.push(0x7a); // 'z'
      continue;
    }
    const digits = [0, 0, 0, 0, 0];
    let t = v;
    for (let k = 4; k >= 0; k--) {
      digits[k] = (t % 85) + 0x21;
      t = Math.floor(t / 85);
    }
    for (let k = 0; k < 5 - pad; k++) out.push(digits[k] as number);
  }
  out.push(0x7e, 0x3e); // "~>"
  return Uint8Array.from(out);
}

function lzwEncode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const dict = new Map<string, number>();
  const resetDict = () => {
    dict.clear();
    for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  };
  resetDict();
  let next = 258;
  let width = 9;
  // Each code is recorded with the width that was in force when it was emitted.
  // Packing later at the final width would be wrong, because the width steps
  // part way through the stream.
  const codes: Array<[number, number]> = [];

  const emit = (code: number) => codes.push([code, width]);
  let w = "";
  for (const b of data) {
    const c = String.fromCharCode(b);
    const wc = w + c;
    if (w !== "" && dict.has(wc)) {
      w = wc;
      continue;
    }
    if (w !== "") {
      emit(dict.get(w) as number);
      dict.set(wc, next++);
      if (next + earlyChange >= 1 << width) width++;
    }
    w = c;
  }
  if (w !== "") emit(dict.get(w) as number);
  emit(257); // EOD

  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const [code, w2] of codes) {
    buf = (buf << w2) | code;
    bits += w2;
    while (bits >= 8) {
      out.push((buf >> (bits - 8)) & 0xff);
      bits -= 8;
      // Keep only what is left. Without this, `buf` passes 32 bits and the
      // shift silently truncates the codes already emitted.
      buf &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out.push((buf << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

const bytes = (...v: number[]) => Uint8Array.from(v);
const same = (a: Uint8Array, b: Uint8Array) => Array.from(a).join() === Array.from(b).join();

describe("ASCIIHexDecode", () => {
  it("reads pairs and stops at the terminator", () => {
    // The input is the text "4869>A", which decodes to two bytes then stops.
    expect(Array.from(asciiHexDecode(bytes(0x34, 0x38, 0x36, 0x39, 0x3e, 0x41)))).toEqual([0x48, 0x69]);
  });

  it("pads an odd final digit with zero", () => {
    expect(Array.from(asciiHexDecode(bytes(0x34, 0x41, 0x3e)))).toEqual([0x4a]);
  });

  it("skips whitespace inside the data", () => {
    // "48 69\n>" with whitespace inside the data.
    expect(Array.from(asciiHexDecode(bytes(0x34, 0x38, 0x20, 0x36, 0x39, 0x0a, 0x3e)))).toEqual([0x48, 0x69]);
  });

  it("handles a single byte", () => {
    // "7f>"
    expect(Array.from(asciiHexDecode(bytes(0x37, 0x66, 0x3e)))).toEqual([0x7f]);
  });
});

describe("ASCII85Decode", () => {
  it("round-trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(same(ascii85Decode(ascii85Encode(all)), all)).toBe(true);
  });

  it("round-trips each possible tail length", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const d = new Uint8Array(n);
      for (let i = 0; i < n; i++) d[i] = (i * 37 + 11) & 0xff;
      expect(same(ascii85Decode(ascii85Encode(d)), d)).toBe(true);
    }
  });

  it("uses the z shortcut for four zero bytes", () => {
    expect(ascii85Decode(bytes(0x7a, 0x7e, 0x3e))).toHaveLength(4);
  });

  it("ignores whitespace between groups", () => {
    const d = Uint8Array.of(0xff, 0xfe, 0x01, 0x80, 0x33);
    const enc = ascii85Encode(d);
    // The same digits with a line break in the middle.
    const wrapped = new Uint8Array(enc.length + 1);
    wrapped.set(enc.subarray(0, 3), 0);
    wrapped[3] = 0x0a;
    wrapped.set(enc.subarray(3), 4);
    expect(same(ascii85Decode(wrapped), d)).toBe(true);
  });
});

describe("RunLengthDecode", () => {
  it("reads a literal run", () => {
    expect(Array.from(runLengthDecode(bytes(2, 0x61, 0x62, 0x63, 128)))).toEqual([0x61, 0x62, 0x63]);
  });

  it("reads a repeat run, where 257 minus n is the count", () => {
    // 257 - 254 = 3 copies of 'z'.
    expect(Array.from(runLengthDecode(bytes(254, 0x7a, 128)))).toEqual([0x7a, 0x7a, 0x7a]);
  });

  it("round-trips a run of identical bytes", () => {
    const d = new Uint8Array(300).fill(0x41);
    expect(same(runLengthDecode(runLengthEncode(d)), d)).toBe(true);
  });

  it("round-trips mixed data", () => {
    const d = Uint8Array.from({ length: 500 }, (_, i) => (i % 7 === 0 ? 0x5a : (i * 13) & 0xff));
    expect(same(runLengthDecode(runLengthEncode(d)), d)).toBe(true);
  });

  it("round-trips random-looking data", () => {
    const d = new Uint8Array(1000);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed >> 16) & 0xff;
    }
    expect(same(runLengthDecode(runLengthEncode(d)), d)).toBe(true);
  });
});

describe("LZWDecode", () => {
  it("round-trips short data with the default EarlyChange", () => {
    const d = bytes(0x41, 0x42, 0x43);
    expect(same(lzwDecode(lzwEncode(d)), d)).toBe(true);
  });

  it("round-trips a run of one byte, which is all dictionary entries", () => {
    const d = new Uint8Array(600).fill(0x5a);
    expect(same(lzwDecode(lzwEncode(d)), d)).toBe(true);
  });

  it("round-trips data that fills the table and steps the code width", () => {
    const d = new Uint8Array(5000);
    for (let i = 0; i < d.length; i++) d[i] = (i * 31 + (i >> 3)) & 0xff;
    expect(same(lzwDecode(lzwEncode(d)), d)).toBe(true);
  });

  it("round-trips with EarlyChange off", () => {
    const d = new Uint8Array(2000);
    for (let i = 0; i < d.length; i++) d[i] = (i * 17) & 0xff;
    expect(same(lzwDecode(lzwEncode(d, 0), 0), d)).toBe(true);
  });

  it("stops at the end-of-data code and ignores what follows", () => {
    const d = bytes(0x41, 0x42);
    const enc = lzwEncode(d);
    const padded = new Uint8Array(enc.length + 4);
    padded.set(enc);
    padded.fill(0xff, enc.length);
    expect(same(lzwDecode(padded), d)).toBe(true);
  });
});

describe("Flate", () => {
  it("round-trips text", () => {
    const d = new TextEncoder().encode("BT /F1 24 Tf 72 700 Td (Page One Heading) Tj ET");
    expect(same(flateDecode(flateEncode(d)), d)).toBe(true);
  });

  it("writes the zlib container, not raw deflate", () => {
    const d = new TextEncoder().encode("hello ".repeat(200));
    const z = flateEncode(d);
    // A zlib stream starts 0x78; raw deflate would start with the block bits.
    expect(z[0]).toBe(0x78);
    expect(flateDecode(z)).toHaveLength(d.length);
  });

  it("shrinks repetitive data a lot", () => {
    const d = new Uint8Array(20000).fill(0x41);
    expect(flateEncode(d).length).toBeLessThan(200);
  });
});

describe("PNG predictors", () => {
  const parms = (predictor: number, columns: number, colors = 1, bpc = 8) => {
    const d = new PdfDict();
    d.setNumber("Predictor", predictor);
    d.setNumber("Colors", colors);
    d.setNumber("BitsPerComponent", bpc);
    d.setNumber("Columns", columns);
    return d;
  };

  it("leaves the data alone when the predictor is 1", () => {
    const d = bytes(1, 2, 3, 4);
    expect(same(applyPredictor(d, parms(1, 4)), d)).toBe(true);
  });

  it("undoes the None filter, which changes nothing", () => {
    // filter byte 0 then four data bytes.
    const d = bytes(0, 10, 20, 30, 40);
    expect(Array.from(applyPredictor(d, parms(12, 4)))).toEqual([10, 20, 30, 40]);
  });

  it("undoes the Up filter by adding the row above", () => {
    // Row 1: filter 2, then differences. Row 2: filter 2, then differences.
    const d = bytes(2, 1, 2, 3, 2, 10, 20, 30);
    expect(Array.from(applyPredictor(d, parms(12, 3)))).toEqual([1, 2, 3, 11, 22, 33]);
  });

  it("undoes the Sub filter by adding the pixel to the left", () => {
    const d = bytes(1, 10, 5, 5, 5);
    expect(Array.from(applyPredictor(d, parms(12, 4)))).toEqual([10, 15, 20, 25]);
  });

  it("undoes the Average filter", () => {
    // Row 1 is unfiltered. Row 2 uses filter 3, floor((left + above) / 2).
    const d = bytes(0, 4, 6, 8, 3, 2, 0, 2);
    expect(Array.from(applyPredictor(d, parms(12, 3)))).toEqual([4, 6, 8, 4, 5, 8]);
  });

  it("undoes the Paeth filter", () => {
    // One row of four, filter 4, differences of 1 with nothing to the left.
    const d = bytes(4, 1, 1, 1, 1);
    expect(Array.from(applyPredictor(d, parms(12, 4)))).toEqual([1, 2, 3, 4]);
  });

  it("uses the pixel distance from the bit depth, not one byte", () => {
    // 3 colours at 8 bits is 3 bytes per pixel.
    const d = bytes(1, 1, 1, 1, 0, 0, 0);
    expect(Array.from(applyPredictor(d, parms(12, 2, 3)))).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("leaves an unknown filter type unfiltered", () => {
    const d = bytes(9, 1, 2, 3);
    expect(Array.from(applyPredictor(d, parms(12, 3)))).toEqual([1, 2, 3]);
  });
});

describe("TIFF predictor", () => {
  const parms = (columns: number, colors = 1, bpc = 8) => {
    const d = new PdfDict();
    d.setNumber("Predictor", 2);
    d.setNumber("Colors", colors);
    d.setNumber("BitsPerComponent", bpc);
    d.setNumber("Columns", columns);
    return d;
  };

  it("undoes horizontal differencing across one byte per sample", () => {
    const d = bytes(10, 5, 5, 5);
    expect(Array.from(applyPredictor(d, parms(4)))).toEqual([10, 15, 20, 25]);
  });

  it("keeps three colour components separate", () => {
    const d = bytes(10, 20, 30, 5, 5, 5);
    expect(Array.from(applyPredictor(d, parms(2, 3)))).toEqual([10, 20, 30, 15, 25, 35]);
  });

  it("accumulates sixteen bit samples as sixteen bit values", () => {
    // Two samples: 0x0100 then a difference of 0x0002.
    const d = bytes(0x01, 0x00, 0x00, 0x02);
    expect(Array.from(applyPredictor(d, parms(2, 1, 16)))).toEqual([0x01, 0x00, 0x01, 0x02]);
  });

  it("leaves a sub-byte depth alone, because the filter is undefined there", () => {
    const d = bytes(0x0f, 0xf0);
    expect(same(applyPredictor(d, parms(2, 1, 4)), d)).toBe(true);
  });
});

describe("a filter chain", () => {
  it("undoes Flate and then a PNG Up predictor, in that order", () => {
    // The row is [1,2,3] then [11,22,33] as differences, PNG Up filtered.
    const filtered = bytes(2, 1, 2, 3, 2, 10, 20, 30);
    const d = new PdfDict();
    d.setNumber("Predictor", 12);
    d.setNumber("Columns", 3);
    const encoded = flateEncode(filtered);
    const out = applyPredictor(flateDecode(encoded), d);
    expect(Array.from(out)).toEqual([1, 2, 3, 11, 22, 33]);
  });
});
