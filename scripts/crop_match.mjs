/**
 * Capture one match's highlight at 3x, so the highlight and the text it is
 * supposed to sit under can be compared directly instead of guessed at from a
 * scaled-down screenshot.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [url = "http://localhost:4340/", query = "sed", steps = "1", outPath = "/tmp/crop.png"] =
  process.argv.slice(2);
const port = 9600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "cdp2-"));
const chrome = spawn(CHROME, [
  "--headless", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1512,1250", url,
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error("no page target");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const { resolve: r, reject: j } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
      }
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const myId = ++id;
          return new Promise((res, rej) => {
            pending.set(myId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
  });
}

try {
  const cdp = await connect(await target());
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1512, height: 1250, deviceScaleFactor: 3, mobile: false,
  });
  await sleep(2500);
  await cdp.send("Runtime.evaluate", {
    expression: `(() => { const q=document.getElementById("q"); q.value=${JSON.stringify(query)};
      q.dispatchEvent(new Event("input",{bubbles:true})); return 1; })()`,
  });
  await sleep(600);
  for (let i = 0; i < Number(steps); i++) {
    await cdp.send("Runtime.evaluate", { expression: `document.getElementById("hit-next").click()` });
    await sleep(300);
  }

  // Where the app believes the current match is, in canvas pixels, and where
  // that canvas actually sits on screen.
  const geo = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const canvas = document.querySelector(".sheet canvas");
      const b = canvas.getBoundingClientRect();
      const hit = document.querySelector("#hits .hit.current");
      return JSON.stringify({ canvas: { x: b.x, y: b.y, w: b.width, h: b.height },
                             hitText: hit ? hit.textContent : null,
                             counter: document.getElementById("hit-count").textContent });
    })()`,
    returnByValue: true,
  });
  console.log("geometry:", geo.result.value);

  // Scan the canvas for the highlight rectangle, so the crop is found from the
  // image rather than from a number I already assumed.
  const found = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const canvas = document.querySelector(".sheet canvas");
      const ctx = canvas.getContext("2d");
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // The current match is the only pure red on the page.
      let minX=1e9,minY=1e9,maxX=-1,maxY=-1;
      for (let y=0;y<canvas.height;y++) for (let x=0;x<canvas.width;x++) {
        const i=(y*canvas.width+x)*4;
        if (d[i]>200 && d[i+1]<80 && d[i+2]<80) {
          if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
        }
      }
      // The ink of the matched word itself: dark pixels inside the box's own
      // x range, with the border rows excluded. If the box is correctly placed
      // this ink has to sit within the box.
      const bx0 = minX + 3, bx1 = maxX - 3;
      let inkMin = 1e9, inkMax = -1;
      for (let y = Math.max(0, minY - 30); y < Math.min(canvas.height, maxY + 30); y++) {
        for (let x = bx0; x < bx1; x++) {
          const i = (y * canvas.width + x) * 4;
          const lum = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
          if (lum < 90) { if (y < inkMin) inkMin = y; if (y > inkMax) inkMax = y; }
        }
      }
      const inkTop = inkMin, inkBottom = inkMax;
      // Segment the neighbouring column strip into separate text lines, then
      // report the one the box overlaps. Measuring "the text band" across a
      // window tall enough to hold the box catches the lines above and below
      // as well, which is what made the first reading useless.
      const x0 = Math.max(0, minX - 70), x1 = Math.max(0, minX - 8);
      const bands = [];
      let open = -1;
      for (let y = 0; y < canvas.height; y++) {
        let dark = 0;
        for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4;
          const lum = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
          if (lum < 110) dark++;
        }
        if (dark > 0 && open < 0) open = y;
        else if (dark === 0 && open >= 0) { bands.push([open, y - 1]); open = -1; }
      }
      if (open >= 0) bands.push([open, canvas.height - 1]);
      // The band the box sits in.
      const band = bands.find((b) => b[1] >= minY - 2 && b[0] <= maxY + 2) ?? null;
      const textTop = band ? band[0] : -1;
      const textBottom = band ? band[1] : -1;
      return JSON.stringify({ minX, minY, maxX, maxY, cw: canvas.width, ch: canvas.height,
                              textTop, textBottom, bands: bands.length, inkTop, inkBottom });
    })()`,
    returnByValue: true,
  });
  const f = JSON.parse(found.result.value);
  console.log("current highlight in canvas px:", JSON.stringify(f));
  console.log("lines found in strip:", f.bands, "| the one under the box:", f.textTop, "..", f.textBottom);
  console.log(`ink of the matched word: ${f.inkTop}..${f.inkBottom}  (box ${f.minY}..${f.maxY})`);
  if (f.inkBottom > f.inkTop) {
    const aboveBox = f.minY - f.inkTop;
    console.log(aboveBox > 0
      ? `FAIL: ${aboveBox}px of the word sits ABOVE its own highlight`
      : `OK: the whole word is inside the highlight (top margin ${f.minY - f.inkTop}px, bottom ${f.inkBottom - f.maxY}px)`);
  }
  if (f.textBottom > f.textTop) {
    const th = f.textBottom - f.textTop, bh = f.maxY - f.minY;
    console.log(`text band height ${th}px, box height ${bh}px (${(bh/th*100).toFixed(0)}%)`);
    console.log(`box top sits ${f.textTop - f.minY}px below the text top, box bottom ${f.maxY - f.textBottom}px below the text bottom`);
  }
  if (f.maxX < 0) throw new Error("no red highlight painted");

  const rect = JSON.parse(geo.result.value).canvas;
  const pad = 13;
  const clip = {
    x: Math.max(0, rect.x + f.minX / f.cw * rect.w - pad),
    y: Math.max(0, rect.y + f.minY / f.ch * rect.h - pad),
    width: ((f.maxX - f.minX) / f.cw * rect.w) + pad * 2,
    height: ((f.maxY - f.minY) / f.ch * rect.h) + pad * 2,
  };
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 8 } });
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  console.log("crop:", outPath, JSON.stringify(clip));
  cdp.close();
} finally {
  chrome.kill();
}
