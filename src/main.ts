/**
 * The app shell.
 *
 * Everything on screen is measured by our own engine: the page count, the
 * object inventory, the text and the position of every run. There is no PDF
 * library here, and nothing on the page is a placeholder.
 */

import "./ui/styles.css";
import { PdfDocument } from "./pdf/document";
import { PdfWriter } from "./pdf/writer";
import { PageTree } from "./pdf/page-tree";
import { isStream } from "./pdf/objects";

interface Loaded {
  name: string;
  bytes: Uint8Array;
  doc: PdfDocument;
  writer: PdfWriter;
  pages: PageTree;
  selected: number;
}

let current: Loaded | null = null;

/**
 * The engine's own words are not a user's words. These tables turn the
 * internal names into something a person opening a file would recognise.
 */
const KIND_WORDS: Record<string, string> = {
  dict: "settings",
  stream: "content",
  array: "a list of values",
  scalar: "a single value",
  null: "empty",
};

const SUBTYPE_WORDS: Record<string, string> = {
  Catalog: "the whole document",
  Pages: "a group of pages",
  Page: "one page",
  Font: "a font",
  FontDescriptor: "font details",
  ObjStm: "other parts, packed together",
  XRef: "the file index",
  XObject: "an image or shape",
  Annot: "a comment or stamp",
  Annots: "comments and stamps",
  Metadata: "file information",
  MetadataStream: "file information",
  StructTreeRoot: "reading order",
  Outlines: "the bookmarks",
  AcroForm: "a fillable form",
};

const FILTER_WORDS: Record<string, string> = {
  FlateDecode: "standard (zlib)",
  Fl: "standard (zlib)",
  LZWDecode: "LZW",
  LZW: "LZW",
  ASCIIHexDecode: "hex",
  AHx: "hex",
  ASCII85Decode: "ASCII85",
  A85: "ASCII85",
  RunLengthDecode: "run length",
  RL: "run length",
  DCTDecode: "JPEG image",
  DCT: "JPEG image",
  JPXDecode: "JPEG 2000 image",
  CCITTFaxDecode: "fax image",
  JBIG2Decode: "JBIG2 image",
};

function whatItIs(row: { type: string; subtype: string | null }): string {
  if (row.subtype) return SUBTYPE_WORDS[row.subtype] ?? row.subtype;
  return KIND_WORDS[row.type] ?? row.type;
}

function howItIsStored(kind: 0 | 1 | 2): string {
  if (kind === 1) return "in the file";
  if (kind === 2) return "packed away";
  return "not used";
}



const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const drop = $<HTMLElement>("drop");
const fileInput = $<HTMLInputElement>("file");
const pagesEl = $<HTMLElement>("pages");
const factsEl = $<HTMLElement>("facts");
const inventoryEl = $<HTMLElement>("inventory");
const outlineEl = $<HTMLElement>("outline");
const hitsEl = $<HTMLElement>("hits");
const qEl = $<HTMLInputElement>("q");
const pageNote = $<HTMLElement>("page-note");
const pageCount = $<HTMLElement>("page-count");
const verdict = $<HTMLElement>("verdict");
const viewerTitle = $<HTMLElement>("viewer-title");
const advice = $<HTMLElement>("advice");

// ------------------------------------------------------------------ toast

let toastTimer = 0;
function toast(message: string, bad = false): void {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = bad ? "toast bad" : "toast";
  el.textContent = message;
  document.body.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 4200);
}

// ------------------------------------------------------------------ loading

async function open(file: File): Promise<void> {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length < 8) {
      toast("That file is too small to be a PDF.", true);
      return;
    }
    const doc = PdfDocument.parse(buf);
    if (doc.encrypted) {
      toast("This file is password protected. It will open read-only.", true);
    }
    const writer = new PdfWriter(doc);
    const pages = new PageTree(doc, writer);
    current = { name: file.name, bytes: buf, doc, writer, pages, selected: 0 };
    render();
    if (doc.encrypted) {
      toast("Opened the structure, but the text stays locked.", true);
    } else {
      toast(`${file.name} · ${pages.count} page${pages.count === 1 ? "" : "s"}`);
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    toast(`Could not read that file: ${why}`, true);
  }
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void open(f);
});

for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) void open(f);
});

// ------------------------------------------------------------------ render

function setFacts(rows: Array<[string, string, boolean?]>): void {
  const nodes = factsEl.querySelectorAll("dt");
  factsEl.replaceChildren();
  for (const [k, v, hot] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    if (hot) dd.className = "hot";
    factsEl.append(dt, dd);
  }
  void nodes;
}

function render(): void {
  if (!current) return;
  const { doc, pages } = current;

  let runs = 0;
  let chars = 0;
  const filters = new Set<string>();
  for (const row of doc.inventory()) {
    const obj = doc.getObject(row.num);
    if (!isStream(obj)) continue;
    for (const f of filtersOf(obj.dict)) filters.add(f);
  }
  const perPage: string[] = [];
  for (let i = 0; i < pages.count; i++) {
    const t = pages.textOf(i);
    perPage.push(t.text);
    runs += t.runs.length;
    chars += t.text.length;
  }

  setFacts([
    ["Format version", doc.version],
    ["Pages", String(pages.count)],
    ["Parts in the file", String(doc.xref.size)],
    // One index section is the ordinary case and says nothing on its own, so
    // this row counts the saves layered on top of the original instead.
    ["Later saves on top", String(Math.max(0, doc.sectionsRead.length - 1))],
    ["Text blocks", String(runs)],
    ["Characters", String(chars)],
    ["Compression", filters.size ? [...filters].join(", ") : "none"],
    [
      "Automatic fixes",
      doc.repairs.length === 0 ? "none needed" : String(doc.repairs.length),
      doc.repairs.length > 0,
    ],
    ["Password protected", doc.encrypted ? "yes" : "no", doc.encrypted],
  ]);

  // A zero here is the one number a user cannot interpret on its own, so the
  // panel says what it means rather than leaving a bare 0 on screen.
  if (chars === 0 && pages.count > 0) {
    advice.hidden = false;
    advice.textContent = doc.encrypted
      ? "No text could be read, because this file is password protected."
      : "No text found. That usually means the pages are scans or photos. Reading those needs text recognition, which this app does not have yet.";
  } else {
    advice.hidden = true;
  }

  if (doc.encrypted) {
    verdict.textContent = "Password protected";
    verdict.className = "badge badge-red";
  } else if (doc.repairs.length) {
    verdict.textContent = `Repaired (${doc.repairs.length})`;
    verdict.className = "badge badge-red";
  } else {
    verdict.textContent = "Opened cleanly";
    verdict.className = "badge badge-blue";
  }

  pageCount.textContent = `${pages.count} page${pages.count === 1 ? "" : "s"}`;
  viewerTitle.textContent = current.name;
  renderPages(perPage);
  renderInventory();
  renderOutline();
  syncButtons();
  qEl.disabled = false;
}

function filtersOf(dict: { get(k: string): unknown }): string[] {
  const raw = dict.get("Filter");
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const names = list.map((v) => {
    const r = current?.doc.resolve(v as never);
    if (r && typeof r === "object" && "name" in r) return String((r as { name: string }).name);
    return "unknown";
  });
  return [...new Set(names.map((n) => FILTER_WORDS[n] ?? n))];
}

/**
 * Choose a scale that fits the column.
 *
 * One page per row is preferred, because a page-geometry tool is useless if
 * the page is cropped. When two fit side by side without going below a legible
 * size, two are shown, so a wide window is not wasted.
 */
function chooseScale(pages: PageTree): number {
  const avail = Math.max(220, pagesEl.clientWidth - 36);
  let widest = 1;
  for (let i = 0; i < pages.count; i++) {
    const b = pages.cropBox(i);
    const swap = pages.rotation(i) === 90 || pages.rotation(i) === 270;
    widest = Math.max(widest, swap ? b.y1 - b.y0 : b.x1 - b.x0);
  }
  const single = Math.min(1.1, avail / widest);
  const pair = (avail - 18) / (2 * widest);
  return pair >= 0.55 ? pair : single;
}

function renderPages(perPage: string[]): void {
  if (!current) return;
  const { pages } = current;
  pagesEl.replaceChildren();
  if (pages.count === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "This file reports no pages.";
    pagesEl.appendChild(note);
    return;
  }

  const scale = chooseScale(pages);
  for (let i = 0; i < pages.count; i++) {
    const d = pages.displayMatrix(i, scale);
    const sheet = document.createElement("div");
    sheet.className = "sheet" + (i === current.selected ? " sel" : "");
    sheet.setAttribute("role", "button");
    sheet.tabIndex = 0;

    const canvas = document.createElement("canvas");
    const w = Math.max(1, Math.round(d.width));
    const h = Math.max(1, Math.round(d.height));
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    drawTextLayer(canvas, i, scale);
    sheet.appendChild(canvas);

    const tag = document.createElement("div");
    tag.className = "tagline";
    const left = document.createElement("span");
    const rot = pages.rotation(i);
    left.textContent = `${i + 1}${rot ? ` · ${rot}°` : ""}`;
    const right = document.createElement("span");
    const box = pages.cropBox(i);
    right.textContent = `${Math.round(box.x1 - box.x0)}×${Math.round(box.y1 - box.y0)}`;
    tag.append(left, right);
    sheet.appendChild(tag);

    const pick = () => {
      if (!current) return;
      current.selected = i;
      renderPages(perPage);
      syncButtons();
    };
    sheet.addEventListener("click", pick);
    sheet.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
    pagesEl.appendChild(sheet);
  }
}

/**
 * Draw the page's text at the positions the engine reported, in a monospace
 * face that stands in for the document's own fonts. Images and vector shapes
 * are not drawn, which the panel beside it says out loud.
 */
function drawTextLayer(canvas: HTMLCanvasElement, pageIndex: number, scale: number): void {
  if (!current) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const result = current.pages.textOf(pageIndex, scale);
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "alphabetic";
  for (const run of result.runs) {
    // The size comes from the transformation matrix, not from `Tf`. A file
    // that declares a 1pt font and scales it up with `cm` would otherwise
    // draw its whole page one pixel tall.
    const size = run.height;
    if (size <= 0.5) continue;
    ctx.save();
    ctx.translate(run.x, run.y);
    ctx.rotate(run.angle);
    // A monospace face stands in for the document's own fonts. The box comes
    // from the file's real glyph widths, so the fallback face is stretched to
    // fit it and the text lands where the document says it does.
    ctx.font = `${size}px ui-monospace, Menlo, monospace`;
    const natural = ctx.measureText(run.text).width;
    if (natural > 0 && run.width > 0) ctx.scale(run.width / natural, 1);
    ctx.fillText(run.text, 0, 0);
    ctx.restore();
  }
}

function renderInventory(): void {
  if (!current) return;
  const rows = current.doc.inventory();
  if (rows.length === 0) {
    inventoryEl.innerHTML = '<p class="note">Nothing could be read from this file.</p>';
    return;
  }
  const table = document.createElement("table");
  table.className = "grid-table";
  const head = document.createElement("tr");
  for (const h of ["#", "What it is", "Stored as"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [String(r.num), whatItIs(r), howItIsStored(r.kind)];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  inventoryEl.replaceChildren(table);
}

function renderOutline(): void {
  if (!current) return;
  const items: string[] = [];
  const walk = (nodes: ReturnType<PageTree["outline"]>, depth: number) => {
    for (const n of nodes) {
      const pad = 10 + depth * 14;
      items.push(
        `<div style="padding:${pad === 10 ? "8px 10px" : "5px 10px 5px " + pad + "px"};border-top:2px solid var(--ink)">` +
          `<b>${escapeHtml(n.title || "(untitled)")}</b>` +
          `<span style="float:right">${n.pageIndex === null ? "—" : "p" + (n.pageIndex + 1)}</span>` +
          `</div>`,
      );
      walk(n.children, depth + 1);
    }
  };
  walk(current.pages.outline(), 0);

  const labels: string[] = [];
  for (let i = 0; i < Math.min(current.pages.count, 24); i++) {
    labels.push(
      `<div style="padding:5px 10px;border-top:2px solid var(--ink)">` +
        `<span style="float:right;font-weight:800">${escapeHtml(current.pages.labelFor(i) || String(i + 1))}</span>` +
        `page ${i + 1}</div>`,
    );
  }

  inventorySafe(outlineEl, items, labels);
}

function inventorySafe(host: HTMLElement, items: string[], labels: string[]): void {
  host.replaceChildren();
  if (items.length === 0 && labels.length === 0) {
    host.innerHTML = '<p class="note">This file has no bookmarks.</p>';
    return;
  }
  if (items.length > 0) {
    const h = document.createElement("div");
    h.className = "sub-head";
    h.textContent = "Outline";
    host.appendChild(h);
    host.insertAdjacentHTML("beforeend", items.join(""));
  }
  if (labels.length > 0) {
    const h = document.createElement("div");
    h.className = "sub-head";
    h.textContent = "Page labels";
    host.appendChild(h);
    host.insertAdjacentHTML("beforeend", labels.join(""));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

// ----------------------------------------------------------------- search

qEl.addEventListener("input", () => {
  if (!current) return;
  const needle = qEl.value.trim().toLowerCase();
  hitsEl.replaceChildren();
  if (needle.length < 2) return;
  const found: Array<{ page: number; before: string; hit: string; after: string }> = [];
  for (let i = 0; i < current.pages.count; i++) {
    const text = current.pages.textOf(i).text;
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    found.push({
      page: i,
      before: text.slice(Math.max(0, at - 28), at),
      hit: text.slice(at, at + needle.length),
      after: text.slice(at + needle.length, at + needle.length + 28),
    });
  }
  if (found.length === 0) {
    hitsEl.innerHTML = `<div class="miss">No page contains &ldquo;${escapeHtml(needle)}&rdquo;</div>`;
    return;
  }
  hitsEl.insertAdjacentHTML(
    "beforeend",
    found
      .map(
        (f) =>
          `<div class="hit">p${f.page + 1} &nbsp;…${escapeHtml(f.before)}` +
          `<mark style="background:var(--red);color:var(--yellow)">${escapeHtml(f.hit)}</mark>` +
          `${escapeHtml(f.after)}…</div>`,
      )
      .join(""),
  );
});

// ------------------------------------------------------------------ actions

const buttons = {
  rotLeft: $<HTMLButtonElement>("rot-left"),
  rotRight: $<HTMLButtonElement>("rot-right"),
  moveUp: $<HTMLButtonElement>("move-up"),
  moveDown: $<HTMLButtonElement>("move-down"),
  insert: $<HTMLButtonElement>("insert"),
  dup: $<HTMLButtonElement>("dup"),
  del: $<HTMLButtonElement>("del"),
  saveFull: $<HTMLButtonElement>("save-full"),
  saveInc: $<HTMLButtonElement>("save-inc"),
};

function syncButtons(): void {
  const on = current !== null && !current.doc.encrypted;
  const n = current?.pages.count ?? 0;
  const sel = current?.selected ?? 0;
  for (const b of Object.values(buttons)) b.disabled = !on;
  buttons.moveUp.disabled = !on || sel <= 0;
  buttons.moveDown.disabled = !on || sel >= n - 1;
  buttons.del.disabled = !on || n <= 1;
  if (current) {
    pageNote.textContent = `Page ${sel + 1} of ${n} · ${current.pages.rotation(sel)}° rotation`;
  }
}

function act(what: string, fn: () => void): void {
  if (!current) return;
  try {
    fn();
    render();
    toast(what);
  } catch (err) {
    toast(`${what} failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

buttons.rotLeft.addEventListener("click", () =>
  act("Rotated left", () => {
    if (!current) return;
    const i = current.selected;
    current.pages.setRotation(i, current.pages.rotation(i) - 90);
  }),
);
buttons.rotRight.addEventListener("click", () =>
  act("Rotated right", () => {
    if (!current) return;
    const i = current.selected;
    current.pages.setRotation(i, current.pages.rotation(i) + 90);
  }),
);
buttons.moveUp.addEventListener("click", () =>
  act("Moved up", () => {
    if (!current) return;
    const i = current.selected;
    current.pages.move(i, i - 1);
    current.selected = i - 1;
  }),
);
buttons.moveDown.addEventListener("click", () =>
  act("Moved down", () => {
    if (!current) return;
    const i = current.selected;
    current.pages.move(i, i + 1);
    current.selected = i + 1;
  }),
);
buttons.insert.addEventListener("click", () =>
  act("Inserted a blank page", () => {
    if (!current) return;
    current.selected = current.pages.insertBlank(current.selected + 1);
  }),
);
buttons.dup.addEventListener("click", () =>
  act("Duplicated the page", () => {
    if (!current) return;
    current.selected = current.pages.insertCopy(current.selected + 1, current.selected);
  }),
);
buttons.del.addEventListener("click", () =>
  act("Deleted the page", () => {
    if (!current) return;
    const i = current.selected;
    current.pages.remove([i]);
    current.selected = Math.max(0, Math.min(i, current.pages.count - 1));
  }),
);

// -------------------------------------------------------------------- save

function download(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, "");
}

buttons.saveFull.addEventListener("click", () => {
  if (!current) return;
  try {
    const bytes = current.writer.save({ incremental: false });
    download(bytes, `${baseName(current.name)}-rewritten.pdf`);
    toast(`Saved · ${current.bytes.length.toLocaleString()} → ${bytes.length.toLocaleString()} bytes`);
  } catch (err) {
    toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, true);
  }
});

buttons.saveInc.addEventListener("click", () => {
  if (!current) return;
  try {
    const bytes = current.writer.save({ incremental: true });
    let same = true;
    for (let i = 0; i < current.bytes.length; i++) {
      if (bytes[i] !== current.bytes[i]) {
        same = false;
        break;
      }
    }
    download(bytes, `${baseName(current.name)}-appended.pdf`);
    toast(
      same
        ? `Saved · the original ${current.bytes.length.toLocaleString()} bytes are untouched`
        : "Saved, but the original file changed. That is a bug.",
      !same,
    );
  } catch (err) {
    toast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, true);
  }
});

// A resize changes how many pages fit, so the text layer is redrawn.
let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!current) return;
    const perPage: string[] = [];
    for (let i = 0; i < current.pages.count; i++) perPage.push(current.pages.textOf(i).text);
    renderPages(perPage);
  }, 140);
});

// A first file, so the page is not empty on arrival. It is a real PDF written
// by the Python fixture generator and committed to the repo.
void (async () => {
  try {
    // Served from public/, so the same URL works in dev and in the build.
    const res = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
    if (!res.ok) return;
    const buf = new Uint8Array(await res.arrayBuffer());
    const doc = PdfDocument.parse(buf);
    const writer = new PdfWriter(doc);
    const pages = new PageTree(doc, writer);
    current = { name: "simple.pdf", bytes: buf, doc, writer, pages, selected: 0 };
    render();
  } catch {
    // The bundled sample is a convenience. The drop zone still works without it.
  }
})();
