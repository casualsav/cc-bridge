import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The header pill and the composer capsule must be the SAME painted surface (owner, 2026-08-07:
// "the pill on top of the chat … the same opaque look that the text input box has, that might be
// multi-layered so you look at it to get the exact same look").
//
//   node pillmatch.mjs [page] [outdir]
//
// "Same look" is THREE layers, not one, and the pill differed on all three: fill (92% of --bg vs
// --chip-fill), shadow (--chip-lift carries a DROP shadow the capsule does not have), and the inset
// highlight. A check on `background` alone would have passed a pill still wearing a drop shadow.
//
// It samples RENDERED PIXELS over a controlled ground rather than comparing declarations: the two
// surfaces sit on different parts of the page, so identical declarations are the claim and identical
// paint is the evidence. Both are sampled over the SAME synthetic bright band, injected behind each
// in turn, because "matching" over the page's own dark ground is a much weaker statement.
//
// It also reports the cwd's CONTRAST, which is the cost this change trades against — webapp/CLAUDE.md
// records the pill's 92% as a measured contrast floor (4.95:1 dark / 5.78 light), and the capsule's
// translucency measuring 2.46 / 2.03 on the build that had it. The number is printed, not asserted:
// the owner is choosing the look with the number on the table.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3];
const ts = 1785200000000;
const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
  "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
const feed = { sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
  items: [{ role: "user", text: "x", ts }] };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };
const b = await chromium.launch();

const open = async vars => {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v))
    document.documentElement.style.setProperty("--tg-theme-" + k, val); pinChromeColour(); }, vars);
  await p.evaluate(f => { window.api = async u => u.includes("feed") ? f : { sessions: [] }; openDrill(f.sid, f.name); }, feed);
  await p.waitForTimeout(900);
  return p;
};

// The declared layers, read off both surfaces. Three properties, because "the same look" is three.
const layers = async p => p.evaluate(() => {
  const g = sel => { const c = getComputedStyle(document.querySelector(sel));
    return { background: c.backgroundColor, backdrop: c.backdropFilter || c.webkitBackdropFilter, shadow: c.boxShadow }; };
  return { pill: g(".dtitle"), capsule: g(".inputwrap") };
});

// A bright band parked behind a surface, then the surface's own pixel read. Same ground for both, so
// the comparison is of the SURFACES and not of what each happens to sit over.
const overBand = async (p, sel) => p.evaluate(s => {
  const el = document.querySelector(s);
  const r = el.getBoundingClientRect();
  let band = document.getElementById("__band");
  if (!band) { band = document.createElement("div"); band.id = "__band"; document.body.appendChild(band); }
  band.style.cssText = `position:fixed;left:0;right:0;top:${r.top}px;height:${r.height}px;background:#5288c1;z-index:0;`;
  return null;
}, sel);

// The surface's GROUND, sampled inside its own padding strip rather than at its centre — the centre
// of the title pill is exactly where the name and cwd glyphs are, so a centre sample reads INK and a
// contrast ratio computed from it compares the text against itself (it reported 1.39:1 for a line
// this repo has measured at 4.95:1, which is what caught it). 3px in from the left edge is inside
// every one of these surfaces' padding and clear of their content.
const px = async (p, sel) => {
  const box = await p.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect();
    return { x: Math.round(r.x + 3), y: Math.round(r.y + r.height / 2) }; }, sel);
  const shot = await p.screenshot({ clip: { x: box.x, y: box.y, width: 2, height: 2 } });
  const { createCanvas, loadImage } = await import("node:buffer").then(() => ({}));
  // Decode the 2x2 PNG by hand-free route: Playwright gives PNG bytes, so read them through a page.
  return p.evaluate(async data => {
    const img = new Image();
    const url = "data:image/png;base64," + data;
    await new Promise(r => { img.onload = r; img.src = url; });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, shot.toString("base64"));
};

for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  const p = await open(vars);
  const L = await layers(p);
  console.log(`\n--- ${theme} ---`);
  console.log("  pill   ", JSON.stringify(L.pill));
  console.log("  capsule", JSON.stringify(L.capsule));
  check(L.pill.background === L.capsule.background, `${theme}: same fill`);
  check(L.pill.shadow === L.capsule.shadow, `${theme}: same shadow layers (this is what --chip-lift's drop shadow breaks)`);
  check(L.pill.backdrop === L.capsule.backdrop, `${theme}: same backdrop filter`);

  await overBand(p, ".dtitle");
  const pillPx = await px(p, ".dtitle");
  await p.evaluate(() => document.getElementById("__band")?.remove());
  await overBand(p, ".inputwrap");
  const capPx = await px(p, ".inputwrap");
  await p.evaluate(() => document.getElementById("__band")?.remove());
  const dist = Math.max(...pillPx.map((v, i) => Math.abs(v - capPx[i])));
  console.log(`  over the SAME bright band → pill rgb(${pillPx})  capsule rgb(${capPx})  max channel Δ ${dist}`);
  check(dist <= 4, `${theme}: the two paint the same over one ground (Δ ${dist} ≤ 4)`);

  // ---- The cost, measured. ----
  // The pill's 92% was a contrast FLOOR for the cwd, so the number has to be on the table when it is
  // traded away. halo.py is the file that used to answer this and it reports "no ink found" on the
  // committed page too — a pre-existing break, verified against HEAD before relying on that fact.
  // So this measures the WCAG ratio the exact way the spec defines it: the text's own colour against
  // the colour actually PAINTED behind it, sampled with a bright bubble parked under the pill. It
  // does not hunt for glyph ink, which is precisely what broke halo.py — antialiasing at 11px leaves
  // almost no pure-ink pixel to find.
  const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) };
  const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) };
  await overBand(p, ".dtitle");
  const ground = await px(p, ".dtitle");
  const inks = await p.evaluate(() => {
    // TWO computed-colour formats, and conflating them is a silent near-black: a colour that came
    // through color-mix() serialises as `color(srgb 0.58 0.62 0.67)` — NORMALISED 0-1 — while a
    // plain one serialises as `rgb(245, 245, 245)`. Reading the first as 0-255 makes --hint-raised
    // read as (0.58, 0.63, 0.67) ≈ black and reports 1.39:1 for a line measured at 4.95:1.
    const rgb = s => {
      const c = getComputedStyle(document.querySelector(s)).color;
      const n = c.match(/[\d.]+/g).slice(0, 3).map(Number);
      return c.startsWith("color(") ? n.map(v => Math.round(v * 255)) : n;
    };
    return { name: rgb(".dtitle .name"), cwd: rgb("#dsub") };
  });
  for (const [what, ink] of Object.entries(inks)) {
    const r = ratio(ink, ground);
    console.log(`  ${theme}: ${what.padEnd(4)} over the pill above a bright bubble → ${r.toFixed(2)}:1 ${r >= 4.5 ? "(clears AA)" : r >= 3 ? "(under AA 4.5, clears large-text 3.0)" : "(UNDER AA)"}`);
  }
  await p.evaluate(() => document.getElementById("__band")?.remove());

  if (OUT) { mkdirSync(OUT, { recursive: true }); await p.screenshot({ path: join(OUT, `pillmatch-${theme}.png`) }); }
  await p.close();
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
