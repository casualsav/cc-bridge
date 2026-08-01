import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const pagePath = process.argv[2] || join(repo, "webapp", "index.html");
const baseline = join(mkdtempSync(join(tmpdir(), "coding-glyph-")), "v0.4.295.html");
writeFileSync(baseline, execFileSync("git", ["show", "9ab96f9:webapp/index.html"], { cwd: repo, maxBuffer: 32e6 }));
const sessions = [
  { sid: "chat", name: "Chat", chat: true, cwd: "", alive: true, working: false, state: "waiting", model: "Sol", effort: "high" },
  { sid: "worker", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: true, state: "working", model: "Opus 5", effort: "high" },
];
const expectedPath = "M2 0h12v4h2v2h-2v2h-1v2h-1V8h-1v2h-1V8H6v2H5V8H4v2H3V8H2V6H0V4h2V0Zm2 2v2h1V2H4Zm7 0v2h1V2h-1Z";
const browser = await chromium.launch();
let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"} ${label}`); if (!ok) bad++; };
const near = (a, b, tolerance = 0.05) => Math.abs(a - b) <= tolerance;

async function measure(path, width, theme) {
  const page = await browser.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: 4 });
  await page.goto("file://" + path, { waitUntil: "domcontentloaded" });
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
  await page.waitForTimeout(600);
  const read = () => page.evaluate(() => {
    const label = document.querySelector("#tab-sessions .sechead");
    const words = label?.querySelector(".swords");
    const glyph = label?.querySelector(".sglyph");
    const svg = glyph?.querySelector("svg");
    const path = svg?.querySelector("path");
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
    const wr = words ? rect(words) : null;
    const lr = label ? rect(label) : null;
    const dots = [...document.querySelectorAll("#tab-sessions .sess .top .dot")].map(rect);
    let visual = null;
    if (path && svg) {
      const box = path.getBBox(), matrix = path.getScreenCTM();
      const left = new DOMPoint(box.x, box.y).matrixTransform(matrix);
      const right = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
      visual = { x: left.x, y: left.y, w: right.x - left.x, h: right.y - left.y, cx: (left.x + right.x) / 2, cy: (left.y + right.y) / 2 };
    }
    return {
      words: wr, label: lr, dots, glyph: glyph ? rect(glyph) : null, visual,
      svg: svg ? { viewBox: svg.getAttribute("viewBox"), ariaHidden: svg.getAttribute("aria-hidden"), crisp: svg.getAttribute("shape-rendering"), background: getComputedStyle(svg).backgroundColor } : null,
      path: path ? { d: path.getAttribute("d"), fill: path.getAttribute("fill"), rule: path.getAttribute("fill-rule") } : null,
      forbidden: glyph ? glyph.querySelectorAll("img,rect,image").length : null,
    };
  });
  const first = await read();
  const cRect = await page.evaluate(() => {
    const words = document.querySelector("#tab-sessions .sechead .swords");
    const range = document.createRange(); range.setStart(words.firstChild, 0); range.setEnd(words.firstChild, 1);
    const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cShot = await page.screenshot({ clip: cRect });
  const cInkHeight = await page.evaluate(async ([data, dpr]) => {
    const image = new Image(); image.src = "data:image/png;base64," + data; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => { const i = (y * canvas.width + x) * 4; return [pixels[i], pixels[i + 1], pixels[i + 2]]; };
    const bg = at(0, 0);
    const rows = [...Array(canvas.height)].map((_, y) => {
      let sum = 0; for (let x = 0; x < canvas.width; x++) { const q = at(x, y); sum += Math.max(...q.map((v, i) => Math.abs(v - bg[i]))); }
      return sum;
    });
    const peak = Math.max(...rows), first = rows.findIndex(value => value > peak * 0.02);
    const last = rows.reduce((found, value, index) => value > peak * 0.02 ? index : found, -1);
    return (last - first + 1) / dpr;
  }, [cShot.toString("base64"), 4]);
  await page.waitForTimeout(500);
  const settled = await read();
  await page.close();
  return { first, settled, cInkHeight };
}

for (const width of [320, 800]) for (const theme of ["dark", "light"]) {
  const before = await measure(baseline, width, theme);
  const after = await measure(pagePath, width, theme);
  const tag = `${width}px ${theme}`;
  check(after.first.svg !== null && after.first.path?.d === expectedPath, `${tag}: supplied silhouette is the inline SVG path`);
  check(after.first.path?.fill === "#d87756" && after.first.path?.rule === "evenodd", `${tag}: supplied orange and cutouts are preserved`);
  check(after.first.svg?.ariaHidden === "true" && after.first.svg?.crisp === "crispEdges" && after.first.forbidden === 0, `${tag}: decorative SVG is accessible, crisp, transparent, and has no raster/black canvas`);
  check(near(after.first.words.x, before.first.words.x) && near(after.first.words.y, before.first.words.y)
    && near(after.first.words.h, before.first.words.h), `${tag}: “Coding Sessions” text position/baseline box is unchanged (${before.first.words.x.toFixed(2)},${before.first.words.y.toFixed(2)} → ${after.first.words.x.toFixed(2)},${after.first.words.y.toFixed(2)})`);
  check(near(after.first.label.y, before.first.label.y) && near(after.first.label.h, before.first.label.h), `${tag}: header height and vertical rhythm are unchanged`);
  const centerOffsets = after.first.visual ? after.first.dots.map(dot => Math.abs(dot.cx - after.first.visual.cx)) : [];
  check(centerOffsets.length === 2 && centerOffsets.every(offset => offset <= 0.5), `${tag}: glyph visual center ${after.first.visual?.cx.toFixed(2)} matches status centers ${after.first.dots.map(dot => dot.cx.toFixed(2)).join("/")}`);
  check(after.first.visual && Math.abs(after.first.visual.h - after.cInkHeight) <= 0.5,
    `${tag}: glyph visual height ${after.first.visual?.h.toFixed(2)} matches capital C ink ${after.cInkHeight.toFixed(2)}`);
  check(after.first.words.x === after.settled.words.x && after.first.words.y === after.settled.words.y
    && after.first.label.h === after.settled.label.h, `${tag}: inline asset causes no load-time layout shift`);
}
await browser.close();
if (bad) process.exit(1);
