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
      toast("That file is too small to be a PDF", true);
      return;
    }
    const doc = PdfDocument.parse(buf);
    if (doc.encrypted) {
      toast("Encrypted files land in Tier 5, not yet", true);
    }
    const writer = new PdfWriter(doc);
    const pages = new PageTree(doc, writer);
    current = { name: file.name, bytes: buf, doc, writer, pages, selected: 0 };
    render();
    if (doc.encrypted) {
      toast("Parsed the index, but strings and streams stay encrypted", true);
    } else {
      toast(`Opened ${file.name} · ${pages.count} page${pages.count === 1 ? "" : "s"}`);
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
    ["PDF version", doc.version],
    ["Pages", String(pages.count)],
    ["Indexed objects", String(doc.xref.size)],
    ["Cross-ref sections", String(doc.sectionsRead.length)],
    ["Text runs", String(runs)],
    ["Characters", String(chars)],
    ["Filters used", filters.size ? [...filters].join(", ") : "none"],
    ["Repairs needed", String(doc.repairs.length), doc.repairs.length > 0],
    ["Encrypted", doc.encrypted ? "yes" : "no", doc.encrypted],
  ]);

  verdict.textContent = doc.repairs.length
    ? `${doc.repairs.length} repair${doc.repairs.length === 1 ? "" : "s"} applied`
    : "Clean parse";
  verdict.className = doc.repairs.length ? "badge badge-red" : "badge badge-blue";

  pageCount.textContent = `${pages.count} page${pages.count === 1 ? "" : "s"}`;
  renderPages(perPage);
  renderInventory();
  renderOutline();
  syncButtons();
  qEl.disabled = false;
}

function filtersOf(dict: { get(k: string): unknown }): string[] {
  const raw = dict.get("Filter");
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return list.map((v) => {
    const r = current?.doc.resolve(v as never);
    if (r && typeof r === "object" && "name" in r) return String((r as { name: string }).name);
    return "?";
  });
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
    note.textContent = "This document has no pages in its page tree.";
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
 * Draw the text layer at the positions the engine reported. This is not a
 * renderer: glyphs and images are not drawn, only the text runs the state
 * machine found, at the size and place the file specifies.
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
    const size = run.fontSize * scale;
    if (size <= 0.4) continue;
    // A monospace face keeps runs legible at small sizes. The box drawn is the
    // one the engine computed, so the outline shows the real run extent.
    ctx.font = `${size}px ui-monospace, Menlo, monospace`;
    ctx.fillText(run.text, run.x, run.y);
    ctx.strokeStyle = "rgba(63, 138, 177, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(run.x, run.y - run.height * 0.82, Math.max(1, run.width), Math.max(1, run.height));
  }
}

function renderInventory(): void {
  if (!current) return;
  const rows = current.doc.inventory();
  if (rows.length === 0) {
    inventoryEl.innerHTML = '<p class="note">No objects were indexed.</p>';
    return;
  }
  const table = document.createElement("table");
  table.className = "grid-table";
  const head = document.createElement("tr");
  for (const h of ["#", "kind", "subtype", "xref"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const r of rows) {
    const tr = document.createElement("tr");
    const cells = [
      String(r.num),
      r.type,
      r.subtype ?? "—",
      r.kind === 1 ? "offset" : r.kind === 2 ? "objstm" : "free",
    ];
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
    host.innerHTML = '<p class="note">This document has no bookmarks.</p>';
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
    toast(`Rewrote the file · ${current.bytes.length} → ${bytes.length} bytes`);
  } catch (err) {
    toast(`Rewrite failed: ${err instanceof Error ? err.message : String(err)}`, true);
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
        ? `Appended · original ${current.bytes.length} bytes untouched, +${bytes.length - current.bytes.length}`
        : "Appended, but the original bytes changed — that is a bug",
      !same,
    );
  } catch (err) {
    toast(`Append failed: ${err instanceof Error ? err.message : String(err)}`, true);
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
