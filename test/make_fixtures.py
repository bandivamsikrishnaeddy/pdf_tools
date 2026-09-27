#!/usr/bin/env python3
"""Build the PDF fixtures the test suite reads.

This is deliberately a separate implementation from the TypeScript engine: a
file produced by the code under test cannot fail it. Every offset here is
computed by locating the bytes, and `verify.py` checks the result again with a
different method.
"""
import os
import zlib
import pathlib

OUT = pathlib.Path(__file__).resolve().parent / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


def build(objects, root=1, extra_trailer=b"", header=b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
          trailer_size=None, xref_stream=False, objstm=False, startxref_override=None):
    """Assemble a PDF. `objects` is a list of (num, body bytes)."""
    out = bytearray(header)
    offsets = {}
    for num, body in objects:
        offsets[num] = len(out)
        out += b"%d 0 obj\n" % num
        out += body
        out += b"\nendobj\n"

    size = trailer_size or (max(offsets) + 1)
    start = len(out)

    if xref_stream:
        # The xref stream is object `size`, holding the table for 0..size-1.
        rows = bytearray()
        for n in range(size):
            if n in offsets:
                rows += bytes([1]) + offsets[n].to_bytes(4, "big") + b"\x00\x00"
            elif n == size:
                rows += bytes([1]) + start.to_bytes(4, "big") + b"\x00\x00"
            else:
                rows += bytes([0]) + (0).to_bytes(4, "big") + b"\xff\xff"
        payload = zlib.compress(bytes(rows))
        xref_num = size
        xref_off = len(out)
        out += b"%d 0 obj\n" % xref_num
        out += b"<< /Type /XRef /Size %d /W [1 4 2] /Root %d 0 R" % (size, root)
        out += extra_trailer
        out += b" /Filter /FlateDecode /Length %d >>\nstream\n" % len(payload)
        out += payload
        out += b"\nendstream\nendobj\n"
        out += b"startxref\n%d\n%%%%EOF\n" % xref_off
        return bytes(out)

    out += b"xref\n"
    # One subsection covering every object we wrote, plus the free head.
    written = sorted(offsets)
    out += b"0 %d\n" % (max(written) + 1)
    out += b"0000000000 65535 f \n"
    for n in range(1, max(written) + 1):
        if n in offsets:
            out += b"%010d 00000 n \n" % offsets[n]
        else:
            out += b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root %d 0 R" % (size, root)
    out += extra_trailer
    out += b" >>\nstartxref\n%d\n%%%%EOF\n" % (startxref_override if startxref_override is not None else start)
    return bytes(out)


def stream_obj(dict_extra, data):
    return b"<< %s /Length %d >>\nstream\n" % (dict_extra, len(data)) + data + b"\nendstream"


HELVETICA_WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
FONT = (b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding"
        b" /FirstChar 32 /LastChar 126 /Widths [" + b" ".join(str(w).encode() for w in HELVETICA_WIDTHS) + b"] >>")

PAGE1_TEXT = b"BT /F1 24 Tf 72 700 Td (Page One Heading) Tj ET"
PAGE2_TEXT = b"BT /F1 18 Tf 72 600 Td (Page Two Heading) Tj ET"

# ---------------------------------------------------------------- simple.pdf
simple = build([
    (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    (2, b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"),
    (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"),
    (4, stream_obj(b"", PAGE1_TEXT)),
    (5, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"),
    (6, stream_obj(b"", PAGE2_TEXT)),
    (7, FONT),
], extra_trailer=b" /Info 8 0 R", trailer_size=9)
(OUT / "simple.pdf").write_bytes(simple)

# Add an Info object by regenerating with it present.
info = b"<< /Producer (fixture-builder) /Title (Simple Fixture) >>"
simple = build([
    (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    (2, b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"),
    (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"),
    (4, stream_obj(b"", PAGE1_TEXT)),
    (5, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"),
    (6, stream_obj(b"", PAGE2_TEXT)),
    (7, FONT),
    (8, info),
], extra_trailer=b" /Info 8 0 R", trailer_size=9)
(OUT / "simple.pdf").write_bytes(simple)

# ----------------------------------------------------------------- flate.pdf
c1 = zlib.compress(PAGE1_TEXT)
c2 = zlib.compress(PAGE2_TEXT)
flate = build([
    (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    (2, b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"),
    (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"),
    (4, stream_obj(b"/Filter /FlateDecode", c1)),
    (5, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"),
    (6, stream_obj(b"/Filter /FlateDecode", c2)),
    (7, FONT),
], trailer_size=8)
(OUT / "flate.pdf").write_bytes(flate)

# -------------------------------------------------- objstm + xref stream.pdf
# Objects 1,2,3,5,7 go into an object stream; 4 and 6 stay as content streams.
inner = [
    (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    (2, b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"),
    (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 9 0 R >>"),
    (5, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 10 0 R >>"),
    (7, FONT),
]
offsets_blob = b""
body = b""
for num, data in inner:
    offsets_blob += b"%d %d " % (num, len(body))
    body += data + b" "
objstm_payload = offsets_blob + body
first = len(offsets_blob)
compressed = zlib.compress(objstm_payload)

# Object 8 is the object stream, 9 and 10 the content streams.
head = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = {}
offsets[9] = len(head)
head += b"9 0 obj\n" + stream_obj(b"", PAGE1_TEXT) + b"\nendobj\n"
offsets[10] = len(head)
head += b"10 0 obj\n" + stream_obj(b"", PAGE2_TEXT) + b"\nendobj\n"
offsets[8] = len(head)
head += b"8 0 obj\n" + stream_obj(b"/Type /ObjStm /N %d /First %d /Filter /FlateDecode" % (len(inner), first), compressed) + b"\nendobj\n"

xref_off = len(head)
rows = bytearray()
for n in range(11):
    if n in offsets:
        rows += bytes([1]) + offsets[n].to_bytes(4, "big") + b"\x00\x00"
    elif n in [i[0] for i in inner]:
        # type 2: which object stream, and the index inside it
        idx = [i[0] for i in inner].index(n)
        rows += bytes([2]) + (8).to_bytes(4, "big") + idx.to_bytes(2, "big")
    elif n == xref_num if (xref_num := 11) else False:
        rows += bytes([1]) + xref_off.to_bytes(4, "big") + b"\x00\x00"
    else:
        rows += bytes([0]) + (0).to_bytes(4, "big") + b"\xff\xff"
# the xref stream is object 11
rows = bytearray()
for n in range(12):
    if n == 11:
        rows += bytes([1]) + xref_off.to_bytes(4, "big") + b"\x00\x00"
    elif n in offsets:
        rows += bytes([1]) + offsets[n].to_bytes(4, "big") + b"\x00\x00"
    elif n in [i[0] for i in inner]:
        idx = [i[0] for i in inner].index(n)
        rows += bytes([2]) + (8).to_bytes(4, "big") + idx.to_bytes(2, "big")
    else:
        rows += bytes([0]) + (0).to_bytes(4, "big") + b"\xff\xff"
payload = zlib.compress(bytes(rows))
head += b"11 0 obj\n<< /Type /XRef /Size 12 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length %d >>\nstream\n" % len(payload)
head += payload
head += b"\nendstream\nendobj\n"
head += b"startxref\n%d\n%%%%EOF\n" % xref_off
(OUT / "objstm.pdf").write_bytes(bytes(head))

# ----------------------------------------------------------- incremental.pdf
# simple.pdf, then an appended revision that changes page 2's content.
inc = bytearray(simple)
prev_xref = int(simple.split(b"startxref\n")[-1].split(b"\n")[0])
new_text = b"BT /F1 18 Tf 72 600 Td (Page Two Revised) Tj ET"
obj_off = len(inc)
inc += b"11 0 obj\n" + stream_obj(b"", new_text) + b"\nendobj\n"
# page 2 points at the new content
p2_off = int(simple.split(b"5 0 obj")[0].rfind(b"\n", 0, 0) or 0)
# recompute page 2's offset by locating its header
idx5 = simple.find(b"5 0 obj")
page2_off = simple.rfind(b"", 0, idx5)
# find the start of the line containing "5 0 obj"
line_start = simple.rfind(b"\n", 0, idx5) + 1
page2_off = line_start
new_page2 = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
             b"/Resources << /Font << /F1 7 0 R >> >> /Contents 11 0 R >>")
inc += b"5 0 obj\n" + new_page2 + b"\nendobj\n"
page2_new_off = len(inc) - (len(b"5 0 obj\n" + new_page2 + b"\nendobj\n"))
xref2_off = len(inc)
inc += b"xref\n0 1\n0000000000 65535 f \n"
inc += b"5 1\n%010d 00000 n \n" % page2_new_off
inc += b"11 1\n%010d 00000 n \n" % obj_off
inc += b"trailer\n<< /Size 12 /Root 1 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n" % (prev_xref, xref2_off)
(OUT / "incremental.pdf").write_bytes(bytes(inc))

# --------------------------------------------------------------- broken.pdf
# simple.pdf with every xref offset shifted, which is what a truncated save
# or a bad byte-level edit looks like.
broken = bytearray(simple)
x = broken.find(b"xref\n0 ")
tail = broken[x:]
fixed = bytearray()
changed = 0
for line in tail.split(b"\n"):
    # split() removed the newline, so a record is 19 bytes here.
    if len(line) == 19 and line[10:11] == b" " and line[17:18] in (b"n", b"f"):
        num = int(line[:10])
        if num != 0:
            fixed += b"%010d 00000 n \n" % (num + 5000)
            changed += 1
            continue
    fixed += line + b"\n"
assert changed == 8, "expected to shift 8 offsets, shifted %d" % changed
broken = broken[:x] + fixed
(OUT / "broken.pdf").write_bytes(bytes(broken))

# --------------------------------------------------------------- nested.pdf
# A page tree with an intermediate node, so inheritance has to be walked.
nested = build([
    (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    (2, b"<< /Type /Pages /Kids [9 0 R] /Count 2 /MediaBox [0 0 400 400] >>"),
    (9, b"<< /Type /Pages /Parent 2 0 R /Kids [3 0 R 5 0 R] /Count 2 >>"),
    (3, b"<< /Type /Page /Parent 9 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"),
    (4, stream_obj(b"", b"BT /F1 12 Tf 20 380 Td (Inherited Box Page) Tj ET")),
    (5, b"<< /Type /Page /Parent 9 0 R /MediaBox [0 0 200 200] "
        b"/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"),
    (6, stream_obj(b"", b"BT /F1 12 Tf 20 180 Td (Own Box Page) Tj ET")),
    (7, FONT),
], trailer_size=10)
(OUT / "nested.pdf").write_bytes(nested)

# ---------------------------------------------------------- indirect.pdf
# Every inheritable key is an INDIRECT reference. Real producers do this
# constantly, and a page tree that reads the raw value instead of resolving it
# finds no font dictionary and reports zero text on a page full of text.
indirect = build([
    (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
    (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox 6 0 R /Resources 7 0 R >>"),
    (3, b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
    (4, stream_obj(b"", b"BT /F1 24 Tf 72 700 Td (Indirect Resource Page) Tj ET")),
    (5, FONT.replace(b"/FirstChar", b"/IndirectResources /FirstChar")),
    (6, b"[0 0 612 792]"),
    (7, b"<< /Font << /F1 5 0 R >> >>"),
], trailer_size=8)
(OUT / "indirect.pdf").write_bytes(indirect)

# ------------------------------------------------------------- labels.pdf
labels = build([
    (1, b"<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 5 >>] >> "
        b"/Outlines 10 0 R >>"),
    (2, b"<< /Type /Pages /Kids [3 0 R 5 0 R 11 0 R] /Count 3 >>"),
    (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"),
    (4, stream_obj(b"", b"BT ET")),
    (5, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>"),
    (6, stream_obj(b"", b"BT ET")),
    (11, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 12 0 R >>"),
    (12, stream_obj(b"", b"BT ET")),
    (10, b"<< /Type /Outlines /First 13 0 R /Last 14 0 R /Count 2 >>"),
    (13, b"<< /Title (First Chapter) /Parent 10 0 R /Next 14 0 R /Dest [3 0 R /Fit] >>"),
    (14, b"<< /Title (Second Chapter) /Parent 10 0 R /Prev 13 0 R /First 15 0 R /Last 15 0 R /Count 1 "
         b"/Dest [11 0 R /Fit] >>"),
    (15, b"<< /Title (Nested Item) /Parent 14 0 R /Dest [5 0 R /Fit] >>"),
], trailer_size=16)
(OUT / "labels.pdf").write_bytes(labels)

# The demo file the app loads on arrival. It lives in public/ so Vite serves it
# at a fixed URL in both dev and the built site.
demo = OUT.parent.parent / "public"
demo.mkdir(parents=True, exist_ok=True)
(demo / "sample.pdf").write_bytes((OUT / "simple.pdf").read_bytes())

for f in sorted(OUT.glob("*.pdf")):
    print(f"{f.name:20s} {f.stat().st_size:6d} bytes")
print(f"{'public/sample.pdf':20s} {(demo / 'sample.pdf').stat().st_size:6d} bytes")
