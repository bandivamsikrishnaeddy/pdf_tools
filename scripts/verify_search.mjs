/**
 * Drive the built app in headless Chrome and prove the search highlights.
 *
 * A screenshot cannot show that typing in the search box does anything, so
 * this connects to the page over the DevTools protocol, sets the input the way
 * a person would, and captures the result.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://localhost:4330/";
const query = process.argv[3] ?? "Page";
const outPath = process.argv[4] ?? "/tmp/search.png";
const port = 9222 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "cdp-"));

const chrome = spawn(CHROME, [
  "--headless",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--window-size=1512,1250",
  url,
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome never exposed a page target");
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
    ws.addEventListener("error", reject);
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const myId = ++id;
          return new Promise((res, rej) => {
            pending.set(myId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
          });
        },
        close: () => ws.close(),
      });
    });
  });
}

try {
  const cdp = await connect(await targetUrl());
  await cdp.send("Page.enable");
  await sleep(2500); // let the app fetch its sample and render

  // Type into the real input, the way a person would.
  const typed = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const q = document.getElementById("q");
      if (!q) return "no input";
      q.focus();
      q.value = ${JSON.stringify(query)};
      q.dispatchEvent(new Event("input", { bubbles: true }));
      return "typed";
    })()`,
    returnByValue: true,
  });
  console.log("input:", typed.result.value);

  await sleep(700);

  const readout = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const pill = document.getElementById("hit-count");
      const hits = [...document.querySelectorAll("#hits .hit")];
      const current = document.querySelector("#hits .hit.current");
      // Count filled highlight rectangles actually painted on the canvases.
      let yellow = 0, red = 0;
      const perCanvas = [];
      for (const c of document.querySelectorAll(".sheet canvas")) {
        const ctx = c.getContext("2d");
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let y = 0, r = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 240 && d[i+1] > 210 && d[i+2] < 120) y++;
          if (d[i] > 230 && d[i+1] < 60 && d[i+2] < 60) r++;
        }
        yellow += y; red += r;
        perCanvas.push({ w: c.width, h: c.height, yellow: y, red: r });
      }
      const painted = yellow + red;
      return JSON.stringify({
        pill: pill ? pill.textContent : null,
        hitButtons: hits.length,
        currentMarked: !!current,
        yellowPixels: yellow,
        redPixels: red,
        painted,
        perCanvas,
      });
    })()`,
    returnByValue: true,
  });
  console.log("readout:", readout.result.value);

  // Step to the next match and confirm the counter moves.
  const stepped = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const before = document.getElementById("hit-count").textContent;
      document.getElementById("hit-next").click();
      const after = document.getElementById("hit-count").textContent;
      return JSON.stringify({ before, after });
    })()`,
    returnByValue: true,
  });
  console.log("step:", stepped.result.value);
  await sleep(400);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  console.log("screenshot:", outPath);
  cdp.close();
} finally {
  chrome.kill();
}
