// The v0.4.300 glyph-plane gate. The supplied orange glyph's PAINTED bottom (rendered
// silhouette, not SVG box) must sit on the words' DOMINANT painted-ink plane — the baseline
// row the eye reads — because that is the measured entity matching the owner's observation
// that "Coding Sessions" reads ~1px higher than the glyph.
//
// PRIMARY (the failing case this gate exists to catch):
//   |glyph painted bottom − words dominant-ink bottom| ≤ 0.4px (harness/DejaVu) / 0.25px (Roboto)
//   Pre-fix: 0.67 (DejaVu) / 1.00 (Roboto) → FAIL.  Post-fix: 0.33 / 0.00 → PASS.
// SECONDARY CONTROL (reported, directional only): the lone lowercase 'g' descender tail of
//   "Coding" dips BELOW the aligned plane (words descender-inclusive bottom > glyph painted
//   bottom). It is deliberately not the alignment target — every text pixel does NOT share
//   the plane, and a mark aligned to the descender would sink ~1.7px and contradict the
//   observed "words higher".
// FROZEN (must hold on BOTH pages — a failure here means the fix moved something else):
//   words x/y/line box == v0.4.295; label y/h (header rhythm) == v0.4.295; glyph slot x ==
//   v0.4.295 (the transform is internal to the svg); glyph visual centre == every status
//   dot's cx; silhouette/colour/attributes preserved; no load-time layout shift.
// Matrix: {dejavu, roboto} × {dpr 3, 4} × {320, 800} × {dark, light}.
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDeviceFont, useDeviceFont } from "./device-font.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const pagePath = process.argv[2] || join(repo, "webapp", "index.html");
const baseline = join(mkdtempSync(join(tmpdir(), "glyph-align-")), "v0.4.295.html");
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

async function prepare(page, path, width, theme) {
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
}

async function readRects(page) {
  return page.evaluate(() => {
    const label = document.querySelector("#tab-sessions .sechead");
    const words = label?.querySelector(".swords");
    const glyph = label?.querySelector(".sglyph");
    const svg = glyph?.querySelector("svg");
    const path = svg?.querySelector("path");
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
    const wr = words ? rect(words) : null;
    const lr = label ? rect(label) : null;
    let visual = null;
    if (path && svg) {
      const box = path.getBBox(), matrix = path.getScreenCTM();
      const left = new DOMPoint(box.x, box.y).matrixTransform(matrix);
      const right = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
      visual = { x: left.x, y: left.y, w: right.x - left.x, h: right.y - left.y, cx: (left.x + right.x) / 2, cy: (left.y + right.y) / 2 };
    }
    return {
      words: wr, label: lr, dots: [...document.querySelectorAll("#tab-sessions .sess .top .dot")].map(rect),
      glyph: glyph ? rect(glyph) : null, svg: svg ? rect(svg) : null, visual,
      attrs: svg ? { viewBox: svg.getAttribute("viewBox"), ariaHidden: svg.getAttribute("aria-hidden"), crisp: svg.getAttribute("shape-rendering"), background: getComputedStyle(svg).backgroundColor } : null,
      path: path ? { d: path.getAttribute("d"), fill: path.getAttribute("fill"), rule: path.getAttribute("fill-rule") } : null,
      forbidden: glyph ? glyph.querySelectorAll("img,rect,image").length : null,
    };
  });
}

// Lowest inked row inside `box`, from a full-page screenshot (absolute coordinates, no
// fractional clip). `t` is the row-sum threshold as a fraction of the box's peak row.
async function scanBottom(page, shot, box, scale, t) {
  return page.evaluate(async ({ data, x, y, w, h, scale, t }) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const W = img.width;
    const x0 = Math.round(x * scale), y0 = Math.round(y * scale), x1 = Math.round((x + w) * scale), y1 = Math.round((y + h) * scale);
    const bg = px[(y0 * W + x0) * 4];
    const rows = []; let peak = 0;
    for (let yy = y0; yy < y1; yy++) { let s = 0; for (let xx = x0; xx < x1; xx++) s += Math.abs(px[(yy * W + xx) * 4] - bg); rows.push(s); if (s > peak) peak = s; }
    let ll = -1; rows.forEach((v, i) => { if (v > peak * t) ll = i; });
    return ll >= 0 ? (ll + 1 + y0) / scale : NaN;
  }, { data: shot.toString("base64"), x: box.x, y: box.y, w: box.w, h: box.h, scale, t });
}

for (const font of ["dejavu", "roboto"]) for (const DPR of [3, 4]) {
  for (const [width, theme] of [[320, "dark"], [320, "light"], [800, "dark"], [800, "light"]]) {
    const tag = `${font} dpr${DPR} ${width}px ${theme}`;

    const basePage = await browser.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: DPR });
    await prepare(basePage, baseline, width, theme);
    await basePage.waitForTimeout(50);
    const base = await readRects(basePage);
    await basePage.close();

    const page = await browser.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: DPR });
    await prepare(page, pagePath, width, theme);
    if (font === "roboto") await useDeviceFont(page, await ensureDeviceFont());
    await page.waitForTimeout(700);
    const first = await readRects(page);
    const shot = await page.screenshot();
    const shotW = await page.evaluate(async (data) => { const i = new Image(); i.src = "data:image/png;base64," + data; await i.decode(); return i.width; }, shot.toString("base64"));
    const scale = shotW / width;

    const glyphBottom = await scanBottom(page, shot, first.svg, scale, 0.02);
    const wordsLow = await scanBottom(page, shot, first.words, scale, 0.02);
    const wordsDom = await scanBottom(page, shot, first.words, scale, 0.15);

    const tol = font === "roboto" ? 0.25 : 0.4;
    check(Math.abs(glyphBottom - wordsDom) <= tol,
      `${tag}: glyph painted ${Number.isFinite(glyphBottom) ? glyphBottom.toFixed(2) : "NaN"} on words' dominant plane ${Number.isFinite(wordsDom) ? wordsDom.toFixed(2) : "NaN"} (|Δ|=${(glyphBottom - wordsDom).toFixed(2)} ≤ ${tol})`);
    check(Number.isFinite(wordsLow) && wordsLow > glyphBottom,
      `${tag}: 'g' descender dips below the plane (low ${Number.isFinite(wordsLow) ? wordsLow.toFixed(2) : "NaN"} > glyph ${Number.isFinite(glyphBottom) ? glyphBottom.toFixed(2) : "NaN"}) — not every pixel shares the plane`);
    check(base.words && near(first.words.x, base.words.x) && near(first.words.y, base.words.y) && near(first.words.h, base.words.h),
      `${tag}: words x/y/line-box frozen vs v0.4.295`);
    // The v0.4.295 baseline carries the OLD text glyph ("✳", no explicit slot height), so no
    // slot-to-baseline comparison is valid — the 11px slot was itself the approved change. The
    // frozen claim is instead that the slot stays an 11×11 box at the label's 12px left padding,
    // which a transform on the svg child provably cannot move.
    check(first.glyph && near(first.glyph.w, 11, 0.1) && near(first.glyph.h, 11, 0.1)
      && near(first.glyph.x, first.label.x + 12, 0.5),
      `${tag}: glyph slot is 11×11 at the label's 12px left padding (transform cannot move it)`);
    check(base.label && near(first.label.y, base.label.y) && near(first.label.h, base.label.h),
      `${tag}: label y/h (header rhythm) frozen`);
    const offsets = first.visual ? first.dots.map(dot => Math.abs(dot.cx - first.visual.cx)) : [];
    check(offsets.length === 2 && offsets.every(o => o <= 0.5),
      `${tag}: glyph visual centre ${first.visual?.cx.toFixed(2)} on status centres ${first.dots.map(d => d.cx.toFixed(2)).join("/")}`);
    check(first.path?.d === expectedPath && first.path?.fill === "#d87756" && first.path?.rule === "evenodd"
      && first.attrs?.viewBox === "0 0 16 10" && first.attrs?.crisp === "crispEdges" && first.attrs?.ariaHidden === "true" && first.forbidden === 0,
      `${tag}: silhouette/colour/attributes preserved`);
    await page.waitForTimeout(500);
    const settled = await readRects(page);
    check(first.words.x === settled.words.x && first.words.y === settled.words.y && first.label.h === settled.label.h,
      `${tag}: no load-time layout shift`);
    await page.close();
  }
}
await browser.close();
if (bad) process.exit(1);
