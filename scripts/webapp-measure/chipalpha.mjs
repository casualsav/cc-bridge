import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// How TRANSPARENT the header chips actually are, and how visible they stay at rest — the two things
// that pull against each other, measured instead of argued.
//
//   node chipalpha.mjs [page]
//
// A chip over TWO known backdrops solves for its alpha exactly:  C = a·F + (1−a)·B, so
// (C₁−C₂) = (1−a)(B₁−B₂). The backdrops are SYNTHESISED here (a solid strip painted behind the
// header) rather than borrowed from a message bubble: a real bubble has rounded edges and the chip's
// own backdrop-blur smears them into the sample, which is what made the same measurement off a
// screenshot read 0.77 for a chip declared 0.82.
//
// The instrument is validated on that declared value before any result is believed (README rule 1):
// it re-declares --chip-fill at a known alpha and must recover it to ±0.02.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");

const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const FEED = { ...SESSION, items: [{ role: "user", text: "hi", ts }] };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(({ feed, session }) => {
  window.api = async path => path.includes("session/feed") ? feed
    : path.includes("sessions") ? { sessions: [session] } : {};
  openDrill(session.sid, session.name);
}, { feed: FEED, session: SESSION });
await p.waitForTimeout(900);

// Two solid strips behind the header, each spanning half its width — flat, so the blur has nothing
// to smear, and known, so the algebra has no unknowns but the chip.
// Both are GREY on purpose: --chip-glass carries a saturate(), which rewrites a coloured backdrop
// before it is composited. A blue probe would be desaturated on the way in and the solve would be
// fed a backdrop it was never shown. Greys pass through saturate() unchanged.
const B1 = [20, 20, 20], B2 = [210, 210, 210];
await p.evaluate(([b1, b2]) => {
  const d = document.createElement("div");
  d.id = "backdrop-probe";
  d.style.cssText = "position:absolute;left:0;right:0;top:0;height:120px;z-index:0;display:flex";
  d.innerHTML = `<div style="flex:1;background:rgb(${b1})"></div><div style="flex:1;background:rgb(${b2})"></div>`;
  document.getElementById("drill").insertBefore(d, document.getElementById("ddock"));
}, [B1, B2]);
// The ceiling scrim has to go for the duration: it paints --bg over the top 46px, which is precisely
// the band the header sits in, so with it up both halves of the probe reach the chip as the SAME
// colour and the algebra has no signal at all (it read NaN). The scrim has its own checks in
// bleed.mjs; here it is instrumentation noise.
await p.addStyleTag({ content: "#drill::before{display:none!important}" });
await p.waitForTimeout(300);

// Sample the CAPSULE's fill on each half, away from its text, and the bare strips beside it.
async function solve(label) {
  const shot = await p.screenshot({ clip: { x: 0, y: 0, width: 375, height: 120 } });
  const px = await p.evaluate(async src => {
    const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + src; });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const at = (x0, x1, y0, y1) => {
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      const n = d.length / 4; return s.map(v => v / n);
    };
    const cap = document.querySelector("#drill .dtitle").getBoundingClientRect();
    const back = document.getElementById("dback").getBoundingClientRect();
    const mid = 375 / 2;
    // Stay a blur radius clear of the seam between the two probe halves. backdrop-filter samples a
    // NEIGHBOURHOOD, so within one radius of the seam the chip is showing a blend of both backdrops
    // and the algebra is being fed a backdrop that is not the one it is told about. Raising the frost
    // 12 → 20 moved a correct 0.386 to a wrong 0.426 through exactly this, with the control unharmed
    // because at 82% opacity there is barely any backdrop left to contaminate.
    // The BLUR radius specifically. --chip-glass is a filter LIST now, so stripping non-digits from it
    // yields "200.35" out of "blur(20px) saturate(0.35)" — a 300px exclusion margin that collapsed
    // both sample windows and reported a chip letting nothing through at all.
    const glass = getComputedStyle(document.documentElement).getPropertyValue("--chip-glass");
    const r = 1.5 * (parseFloat((glass.match(/blur\(([\d.]+)px\)/) || [])[1]) || 12);
    return {
      // The capsule's own fill, sampled in its bottom strip (below the two text lines) on each half.
      // …and clear of the capsule's ROUNDED ENDS, whose antialiasing blends chip into backdrop and
      // drags the average toward it. The corner radius is half the row's height, so one radius in on
      // each side is the smallest honest margin: with the sample starting 6px in, a declared 0.82
      // recovered as 0.799.
      chipDark: at(Math.round(cap.left + cap.height / 2), Math.round(mid - r), Math.round(cap.bottom) - 5, Math.round(cap.bottom) - 1),
      chipBright: at(Math.round(mid + r), Math.round(cap.right - cap.height / 2), Math.round(cap.bottom) - 5, Math.round(cap.bottom) - 1),
      // Beside the chips, at the chips' OWN rows — same y, so the two backdrops differ only in the
      // one thing being solved for. Left of the back button is the dark half; right of the pause
      // button is the bright one.
      bareDark: at(2, Math.round(back.left) - 3, Math.round(cap.top) + 6, Math.round(cap.bottom) - 6),
      bareBright: at(Math.round(document.getElementById("dstop").getBoundingClientRect().right) + 3, 373,
        Math.round(cap.top) + 6, Math.round(cap.bottom) - 6),
      // …and the chip against the PAGE, which is the other half of the trade: transparency is free
      // only until the chip stops reading as a chip.
      // Against the PAGE: the probe strip is 120px tall, so a second render of the same chip below it
      // is not available — instead the back button's own left edge column, which sits over --bg once
      // the probe is removed, is sampled by the caller. Here: the capsule over the probe's dark half
      // is a stand-in for "a flat backdrop", and pageBare is that same flat backdrop beside it.
      chipOnPage: at(Math.round(cap.left) + 6, Math.round(mid) - 6, Math.round(cap.bottom) - 5, Math.round(cap.bottom) - 1),
      pageBare: at(2, Math.round(back.left) - 3, Math.round(cap.top) + 6, Math.round(cap.bottom) - 6),
    };
  }, shot.toString("base64"));
  const alphas = [];
  for (let i = 0; i < 3; i++) {
    const db = px.bareDark[i] - px.bareBright[i];
    if (Math.abs(db) > 20) alphas.push(1 - (px.chipDark[i] - px.chipBright[i]) / db);
  }
  const a = alphas.reduce((x, y) => x + y, 0) / alphas.length;
  console.log(`  ${label}: alpha ${a.toFixed(3)}  (per-channel ${alphas.map(v => v.toFixed(3)).join(", ")})`);
  return { alpha: a };
}

// 1. VALIDATE THE INSTRUMENT on a declared value before believing any measurement.
const override = css => p.evaluate(t => {
  let el = document.getElementById("probe-override");
  if (!el) { el = document.createElement("style"); el.id = "probe-override"; document.head.appendChild(el); }
  el.textContent = t;
}, css);

await override(":root{--chip-fill:color-mix(in srgb, var(--sec) 82%, transparent)}");
await p.waitForTimeout(200);
const control = await solve("control, --chip-fill re-declared at 0.82");
check(Math.abs(control.alpha - 0.82) <= 0.02, `the instrument recovers a KNOWN 0.82 (read ${control.alpha.toFixed(3)})`);

// 2. …then read what the page actually ships, with the override withdrawn.
await override("");
await p.waitForTimeout(200);
const shipped = await solve("as shipped");
// Telegram's own chrome pills, solved off the owner's screenshot on a text-free band of the ✕ Close
// pill: alpha 0.36 over a fill of rgb(15,21,28). That is the number this matches.
check(Math.abs(shipped.alpha - 0.36) <= 0.05, `matches Telegram's own chrome transparency (0.36; read ${shipped.alpha.toFixed(3)})`);

// 3. The OTHER half of the trade, measured with the probe GONE and the chip over the real page.
//    Transparency is free only until the chip stops reading as a chip: at 0.36 a plain --sec fill
//    lands ~4 units from --bg and disappears whenever nothing is behind it. The fill is tinted toward
//    --text to pay for that, so the chip must be at least as distinct from the page as it was at
//    0.82 — measured against that build, not asserted.
await p.evaluate(() => document.getElementById("backdrop-probe").remove());
await p.waitForTimeout(200);
async function presence(label) {
  const shot = await p.screenshot({ clip: { x: 0, y: 0, width: 375, height: 120 } });
  const v = await p.evaluate(async src => {
    const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + src; });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const at = (x0, x1, y0, y1) => { const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      const n = d.length / 4; return s.map(x => x / n); };
    const cap = document.querySelector("#drill .dtitle").getBoundingClientRect();
    const back = document.getElementById("dback").getBoundingClientRect();
    const chip = at(Math.round(cap.left + cap.height / 2), Math.round(cap.right - cap.height / 2), Math.round(cap.bottom) - 5, Math.round(cap.bottom) - 1);
    const page = at(2, Math.round(back.left) - 3, Math.round(cap.top) + 6, Math.round(cap.bottom) - 6);
    const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // SIGNED, and that is the point: the previous version measured distance only, so a chip 19 units
    // LIGHTER than the page passed a check meant to describe one that is darker. Telegram's reads
    // ~10 units darker; a raised slab and a smoked scrim are not interchangeable at equal distance.
    return { delta: lum(chip) - lum(page), chip: chip.map(Math.round), page: page.map(Math.round) };
  }, shot.toString("base64"));
  console.log(`  ${label}: chip rgb(${v.chip}) vs page rgb(${v.page}) → ${v.delta > 0 ? "+" : ""}${v.delta.toFixed(1)} luminance`);
  return v.delta;
}
await override(":root{--chip-fill:color-mix(in srgb, var(--sec) 82%, transparent)}");
await p.waitForTimeout(200);
const before = await presence("the old raised chip (--sec at 0.82)");
await override("");
await p.waitForTimeout(200);
const now = await presence("as shipped");
// Telegram's own: (27,35,45) against a page of (33,45,59) on the owner's screenshot — a scrim about
// 9 luminance units below the ground. Ours must be on the SAME SIDE and in the same neighbourhood.
check(now < 0, `the chip is a SCRIM, darker than the page, as Telegram's is (${now.toFixed(1)})`);
check(Math.abs(now - -9) <= 6, `…by about the same amount (${now.toFixed(1)} against Telegram's -9)`);
check(before > 0, `CONTROL: the old fill really was lighter, so this check could fail (${before.toFixed(1)})`);
console.log(`  → ${(100 - shipped.alpha * 100).toFixed(0)}% of a passing message shows through, against ${(100 - control.alpha * 100).toFixed(0)}% before`);

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
