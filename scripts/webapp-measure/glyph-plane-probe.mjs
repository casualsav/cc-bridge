// Final measurement matrix for the design note: glyph painted bottom vs the words'
// painted bottom, where "words painted bottom" is measured two ways —
//   (a) lowest inked row (descender-inclusive — the literal painted text-ink bottom)
//   (b) dominant-ink bottom (row sum > 15% of peak — the baseline line the eye reads)
// Across {dejavu, roboto} × {dpr 3, dpr 4} × {320, 800} × {dark, light}.
// Scans full-page screenshots (no fractional clip) so the coordinates are absolute.
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensureDeviceFont, useDeviceFont } from "./device-font.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const pagePath = process.argv[2] || join(repo, "webapp", "index.html");
const sessions = [
  { sid: "chat", name: "Chat", chat: true, cwd: "", alive: true, working: false, state: "waiting", model: "Sol", effort: "high" },
  { sid: "worker", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: true, state: "working", model: "Opus 5", effort: "high" },
];

const browser = await chromium.launch();
for (const font of ["roboto", "dejavu"]) for (const DPR of [3, 4]) {
  for (const [width, theme] of [[320, "dark"], [320, "light"], [800, "dark"], [800, "light"]]) {
    const page = await browser.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: DPR });
    await page.goto("file://" + pagePath, { waitUntil: "domcontentloaded" });
    if (font === "roboto") await useDeviceFont(page, await ensureDeviceFont());
    await page.evaluate(({ sessions, theme }) => {
      const root = document.documentElement.style;
      const light = theme === "light";
      root.setProperty("--tg-theme-bg-color", light ? "#f4f4f5" : "#111820");
      root.setProperty("--tg-theme-secondary-bg-color", light ? "#ffffff" : "#1d2733");
      root.setProperty("--tg-theme-text-color", light ? "#171717" : "#f5f5f5");
      root.setProperty("--tg-theme-hint-color", light ? "#666666" : "#95a0ab");
      pinChromeColour();
      window.api = async url => url.includes("/api/sessions") ? { sessions } : {};
      showTab("sessions");
    }, { sessions, theme });
    await page.waitForTimeout(700);
    const geom = await page.evaluate(() => {
      const svg = document.querySelector("#tab-sessions .sechead .sglyph svg");
      const path = svg.querySelector("path");
      const box = path.getBBox(), m = path.getScreenCTM();
      const tl = new DOMPoint(box.x, box.y).matrixTransform(m);
      const br = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(m);
      return br.y;
    });
    const rects = await page.evaluate(() => {
      const words = document.querySelector("#tab-sessions .sechead .swords").getBoundingClientRect();
      const svg = document.querySelector("#tab-sessions .sechead .sglyph svg").getBoundingClientRect();
      return { words: { x: words.x, y: words.y, w: words.width, h: words.height }, svg: { x: svg.x, y: svg.y, w: svg.width, h: svg.height } };
    });
    const shot = await page.screenshot();
    const shotW = await page.evaluate(async (data) => { const i = new Image(); i.src = "data:image/png;base64," + data; await i.decode(); return i.width; }, shot.toString("base64"));
    const scale = shotW / width;
    const words = await page.evaluate(async ({ data, x, y, w, h, scale }) => {
      const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const W = img.width;
      const x0 = Math.round(x * scale), y0 = Math.round(y * scale), x1 = Math.round((x + w) * scale), y1 = Math.round((y + h) * scale);
      const bg = px[(y0 * W + x0) * 4];
      const rows = []; let peak = 0;
      for (let yy = y0; yy < y1; yy++) { let s = 0; for (let xx = x0; xx < x1; xx++) s += Math.abs(px[(yy * W + xx) * 4] - bg); rows.push(s); if (s > peak) peak = s; }
      const lowT = peak * 0.02, domT = peak * 0.15;
      let lf = -1, ll = -1, dl = -1;
      rows.forEach((v, i) => { if (v > lowT) { if (lf < 0) lf = i; ll = i; } if (v > domT) dl = i; });
      return { lowBottom: (ll + 1 + y0) / scale, domBottom: (dl + 1 + y0) / scale };
    }, { data: shot.toString("base64"), x: rects.words.x, y: rects.words.y, w: rects.words.w, h: rects.words.h, scale });
    const glyph = await page.evaluate(async ({ data, x, y, w, h, scale }) => {
      const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const W = img.width;
      const x0 = Math.round(x * scale), y0 = Math.round(y * scale), x1 = Math.round((x + w) * scale), y1 = Math.round((y + h) * scale);
      const bg = px[(y0 * W + x0) * 4];
      const rows = []; let peak = 0;
      for (let yy = y0; yy < y1; yy++) { let s = 0; for (let xx = x0; xx < x1; xx++) s += Math.abs(px[(yy * W + xx) * 4] - bg); rows.push(s); if (s > peak) peak = s; }
      const lowT = peak * 0.02;
      let ll = -1; rows.forEach((v, i) => { if (v > lowT) ll = i; });
      return (ll + 1 + y0) / scale;
    }, { data: shot.toString("base64"), x: rects.svg.x, y: rects.svg.y, w: rects.svg.w, h: rects.svg.h, scale });
    console.log(`${font} dpr${DPR} ${width}px ${theme}:  glyph painted=${glyph.toFixed(2)} geom=${geom.toFixed(2)}  words low=${words.lowBottom.toFixed(2)} dom=${words.domBottom.toFixed(2)}  |  painted−low=${(glyph - words.lowBottom).toFixed(2)}  painted−dom=${(glyph - words.domBottom).toFixed(2)}  geom−low=${(geom - words.lowBottom).toFixed(2)}`);
    await page.close();
  }
}
await browser.close();
