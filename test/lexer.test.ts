import { describe, expect, it } from "vitest";
import { Lexer, latin1 } from "../src/pdf/lexer";
import { parseIndirectObjectAt, parseObject } from "../src/pdf/parser";
import { PdfDict, PdfName, PdfRef, PdfString, isArray, isDict, isStream } from "../src/pdf/objects";
import { fixture } from "./helpers";

const lex = (s: string) => new Lexer(Uint8Array.from([...s].map((c) => c.charCodeAt(0))));

describe("lexer", () => {
  it("reads numbers in every form PDF allows", () => {
    const l = lex("0 34.5 -3.02 +17 4. -.002 0.0");
    const vals: number[] = [];
    for (;;) {
      const t = l.nextToken();
      if (t.type === "eof") break;
      vals.push(t.value as number);
    }
    expect(vals).toEqual([0, 34.5, -3.02, 17, 4, -0.002, 0]);
  });

  it("keeps a malformed run instead of losing the position", () => {
    const l = lex("--3 ");
    const t = l.nextToken();
    expect(t.type).toBe("num");
    expect(t.value).toBe(-3);
  });

  it("decodes hex escapes in a name", () => {
    const t = lex("/A#20B#2f").nextToken();
    expect(t.type).toBe("name");
    expect(t.value).toBe("A B/");
  });

  it("treats a hash that is not two hex digits as a literal", () => {
    expect((lex("/a#zz").nextToken() as { value: string }).value).toBe("a#zz");
  });

  it("reads a literal string with escapes and nested parentheses", () => {
    const l = lex("(a\\(b\\)c(d)e\\n\\101\\t)");
    const t = l.nextToken();
    const bytes = t.value as Uint8Array;
    // a ( b ) c ( d ) e LF A TAB
    expect(Array.from(bytes)).toEqual([
      0x61, 0x28, 0x62, 0x29, 0x63, 0x28, 0x64, 0x29, 0x65, 0x0a, 0x41, 0x09,
    ]);
  });

  it("folds an escaped CRLF inside a string into nothing", () => {
    const l = lex("(a\\\r\nb)");
    const t = l.nextToken();
    expect(Array.from(t.value as Uint8Array)).toEqual([0x61, 0x62]);
  });

  it("stores a bare end-of-line inside a string as a single LF", () => {
    const l = lex("(a\r\nb)");
    expect(Array.from((l.nextToken().value as Uint8Array))).toEqual([0x61, 0x0a, 0x62]);
  });

  it("masks a three-digit octal escape down to one byte", () => {
    // \\777 is 511 and keeps its low byte, \\#77 is 63 unchanged.
    expect(Array.from((lex("(\\777)").nextToken().value as Uint8Array))).toEqual([0xff]);
    expect(Array.from((lex("(\\477)").nextToken().value as Uint8Array))).toEqual([0x3f]);
    expect(Array.from((lex("(\\101)").nextToken().value as Uint8Array))).toEqual([0x41]);
  });

  it("pads an odd final hex digit with zero", () => {
    expect(Array.from((lex("<4A7>").nextToken().value as Uint8Array))).toEqual([0x4a, 0x70]);
  });

  it("skips whitespace and comments", () => {
    const l = lex("  % a comment\n\0\t42");
    expect(l.nextToken().value).toBe(42);
  });

  it("peeks without consuming", () => {
    const l = lex("7 0 R");
    expect(l.peekToken().value).toBe(7);
    expect(l.pos).toBe(0);
    expect(l.nextToken().value).toBe(7);
  });
});

describe("object parser", () => {
  it("builds every object type", () => {
    const obj = parseObject(lex("<< /A 1 /B (x) /C [1 2] /D << /E true >> >>"));
    expect(isDict(obj)).toBe(true);
    const d = obj as PdfDict;
    expect(d.getName("A")).toBe(null);
    expect(d.get("A")).toBe(1);
    expect(d.get("B")).toBeInstanceOf(PdfString);
    expect(isArray(d.get("C"))).toBe(true);
    expect(isDict(d.get("D"))).toBe(true);
  });

  it("reads a reference, not two numbers", () => {
    const obj = parseObject(lex("12 0 R"));
    expect(obj).toBeInstanceOf(PdfRef);
    expect((obj as PdfRef).num).toBe(12);
    expect((obj as PdfRef).gen).toBe(0);
  });

  it("does not read a number as a reference when the third token is not R", () => {
    expect(parseObject(lex("12 0 obj"))).toBe(12);
  });

  it("keeps a dict whose key is damaged", () => {
    const d = parseObject(lex("<< 5 /Good 7 >>")) as PdfDict;
    expect(d.get("Good")).toBe(7);
  });

  it("reads a stream and fixes a wrong Length", () => {
    // The declared length is 999, so the parser must search for endstream.
    const buf = fixture("simple.pdf");
    const d = parseIndirectObjectAt(buf, latin1(buf).indexOf("4 0 obj"));
    expect(d).not.toBeNull();
    const s = d!.value;
    expect(isStream(s)).toBe(true);
    if (isStream(s)) {
      expect(latin1(s.raw)).toBe("BT /F1 24 Tf 72 700 Td (Page One Heading) Tj ET");
    }
  });
});

describe("object model", () => {
  it("decodes UTF-16 with a byte-order mark and Latin-1 without one", () => {
    expect(new PdfString(Uint8Array.of(0xfe, 0xff, 0x00, 0x48, 0x00, 0x69)).asText()).toBe("Hi");
    expect(new PdfString(Uint8Array.of(0x48, 0x69)).asText()).toBe("Hi");
  });

  it("reads a name value as a string", () => {
    expect(new PdfName("Type").toString()).toBe("/Type");
    expect(new PdfRef(4, 0).toString()).toBe("4 0 R");
  });
});
