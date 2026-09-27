/**
 * Stream filters.
 *
 * A PDF stream is stored compressed and optionally predicted. Both steps are
 * reversible without a model, so they belong in the engine. Image codecs such
 * as DCTDecode are not filters we decode; those streams are handed back as the
 * bytes they are, because the bytes are already a usable image file.
 */

import { unzlibSync, zlibSync } from "fflate";
import { PdfDict } from "./objects";

/** True when the named filter is one that produces image bytes, not data. */
export function isImageFilter(name: string): boolean {
  return name === "DCTDecode" || name === "DCT" || name === "JPXDecode" || name === "CCITTFaxDecode" || name === "JBIG2Decode";
}

export function flateDecode(data: Uint8Array): Uint8Array {
  return unzlibSync(data);
}

export function flateEncode(data: Uint8Array): Uint8Array {
  // PDF's FlateDecode is the zlib container, not raw DEFLATE, so the wrapper
  // has to be written as well as the compressed bytes.
  return zlibSync(data, { level: 6 });
}

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break; // '>'
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
    else continue;
    if (hi < 0) hi = v;
    else {
      out.push((hi << 4) | v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (c === 0x7e) break; // '~' starts the `~>` terminator
    if (isAsciiSpace(c)) continue;
    if (c === 0x7a && count === 0) {
      // `z` stands for four zero bytes.
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 1) {
    // A short final group holds count-1 bytes.
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let i = 0; i < count - 1; i++) out.push(bytes[i] as number);
  }
  return Uint8Array.from(out);
}

function isAsciiSpace(c: number): boolean {
  return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i] as number;
    i++;
    if (n === 128) break; // EOD
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++] as number);
    } else {
      const b = data[i] as number;
      i++;
      const repeat = 257 - n;
      for (let k = 0; k < repeat; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

export function runLengthEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    // Count a run of equal bytes.
    let run = 1;
    while (i + run < data.length && data[i + run] === data[i] && run < 127) run++;
    if (run > 1) {
      out.push(257 - run, data[i] as number);
      i += run;
    } else {
      // Otherwise copy a literal span.
      let start = i;
      let len = 0;
      while (i < data.length && len < 127) {
        if (i + 2 < data.length && data[i] === data[i + 1] && data[i] === data[i + 2]) break;
        i++;
        len++;
      }
      out.push(len - 1);
      for (let k = 0; k < len; k++) out.push(data[start + k] as number);
    }
  }
  out.push(128);
  return Uint8Array.from(out);
}

/**
 * LZW as PDF uses it. Not TIFF LZW: the code width steps one code early unless
 * `/EarlyChange` is 0, and the table is reset rather than reused in place.
 */
export function lzwDecode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  let dict: Uint8Array[] = [];
  const resetDict = () => {
    // A plain array, not `new Array(4096)`. Its `length` has to be the next free
    // code, because that is what decides when the code width steps up.
    dict = [];
    for (let i = 0; i < 256; i++) dict[i] = Uint8Array.of(i);
    dict[256] = new Uint8Array(0); // clear table
    dict[257] = new Uint8Array(0); // EOD
  };
  resetDict();

  let width = 9;
  let prev: Uint8Array | null = null;
  let bitBuf = 0;
  let bitCount = 0;

  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      bitBuf = (bitBuf << 8) | (data[i] as number);
      bitCount += 8;
    } else if (bitCount < width) {
      break; // pad the last byte with zeros, then stop
    }
    while (bitCount >= width) {
      const code = (bitBuf >> (bitCount - width)) & ((1 << width) - 1);
      bitCount -= width;
      // Keep only the bits that have not been consumed. Without this the
      // accumulator passes 32 bits, and JavaScript's shift silently drops the
      // codes already read.
      bitBuf &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
      if (code === 257) return Uint8Array.from(out);
      if (code === 256) {
        resetDict();
        width = 9;
        prev = null;
        continue;
      }
      let entry: Uint8Array;
      if (code < dict.length && dict[code]) {
        entry = dict[code] as Uint8Array;
      } else if (prev) {
        entry = new Uint8Array(prev.length + 1);
        entry.set(prev, 0);
        entry[prev.length] = prev[0] as number;
      } else {
        return Uint8Array.from(out); // damaged stream
      }
      for (const b of entry) out.push(b);
      if (prev && dict.length < 4096) {
        const add = new Uint8Array(prev.length + 1);
        add.set(prev, 0);
        add[prev.length] = entry[0] as number;
        dict[dict.length] = add;
      }
      prev = entry;
      // The decoder cannot add an entry for the very first code, because there
      // is no earlier entry to extend. So its table is one entry behind the
      // encoder's, and the width has to step up one code later to match.
      const limit = dict.length + earlyChange + 1;
      if (limit >= 512 && width === 9) width = 10;
      else if (limit >= 1024 && width === 10) width = 11;
      else if (limit >= 2048 && width === 11) width = 12;
    }
  }
  return Uint8Array.from(out);
}

/** Undo a `/Predictor` entry. This must run straight after its own filter. */
export function applyPredictor(data: Uint8Array, parms: PdfDict | null): Uint8Array {
  const predictor = parms?.getNumber("Predictor") ?? 1;
  if (predictor <= 1 || data.length === 0) return data;

  const colors = parms?.getNumber("Colors") ?? 1;
  const bpc = parms?.getNumber("BitsPerComponent") ?? 8;
  const columns = parms?.getNumber("Columns") ?? 1;
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (rowLen <= 0) return data;

  if (predictor === 2) return tiffPredictor(data, colors, bpc, rowLen);
  return pngPredictor(data, Math.ceil((colors * bpc) / 8) || 1, rowLen);
}

function tiffPredictor(data: Uint8Array, colors: number, bpc: number, rowLen: number): Uint8Array {
  if (bpc !== 8 && bpc !== 16) return data; // undefined for sub-byte samples
  const out = new Uint8Array(data.length);
  const rows = Math.floor(data.length / rowLen);
  for (let r = 0; r < rows; r++) {
    const src = r * rowLen;
    const dst = src;
    out.set(data.subarray(src, src + rowLen), dst);
    if (bpc === 8) {
      for (let i = colors; i < rowLen; i++) {
        out[dst + i] = ((out[dst + i] as number) + (out[dst + i - colors] as number)) & 0xff;
      }
    } else {
      // 16-bit samples accumulate as 16-bit values, not as bytes.
      const samples = rowLen >> 1;
      for (let i = colors; i < samples; i++) {
        const prevI = dst + (i - colors) * 2;
        const curI = dst + i * 2;
        const v = (((out[curI] as number) << 8) | (out[curI + 1] as number)) +
          (((out[prevI] as number) << 8) | (out[prevI + 1] as number));
        out[curI] = (v >> 8) & 0xff;
        out[curI + 1] = v & 0xff;
      }
    }
  }
  return out.subarray(0, rows * rowLen);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function pngPredictor(data: Uint8Array, bpp: number, rowLen: number): Uint8Array {
  const stride = rowLen + 1; // each row carries a filter-type byte
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * stride] as number;
    const src = r * stride + 1;
    const dst = r * rowLen;
    const up = dst - rowLen;
    for (let i = 0; i < rowLen; i++) {
      const raw = data[src + i] as number;
      const a = i >= bpp ? (out[dst + i - bpp] as number) : 0;
      const b = r > 0 ? (out[up + i] as number) : 0;
      const c = r > 0 && i >= bpp ? (out[up + i - bpp] as number) : 0;
      let v: number;
      switch (ft) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: v = raw; break; // an unknown filter type means no filtering
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}
