// THE HARNESS'S FONT IS NOT THE DEVICE'S FONT, and every ink measurement in this directory was blind to
// that until 2026-07-30. The page asks for `-apple-system, system-ui, "Segoe UI", Roboto, sans-serif`;
// his Android WebView resolves that to **Roboto**, and headless Chromium on this box resolves it to
// **DejaVu Sans** (`fc-match sans-serif`). Side bearings differ between the two, so a claim about where
// a LETTER's ink sits is only about the font it was measured in — which is how `listorder.mjs` could
// report the label's C flush with a card name while the owner's phone showed it a half pixel right.
//
// So an ink claim that is meant to describe HIS screen loads Roboto explicitly. The file is fetched once
// from Google Fonts (the variable latin subset, Apache-2.0) into `.fonts/` beside these scripts and
// cached — deliberately NOT committed: a binary in the tree also rides every `bun run deploy` into the
// plugin cache, for a file only this directory's probes read.
//
// It is a hard failure when the font cannot be had, never a silent fall back to DejaVu: a measurement in
// the wrong font is worse than no measurement, because it reads exactly like the right one.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, ".fonts");
const FILE = join(DIR, "roboto-latin-var.woff2");
// The CSS API answers with a per-subset @font-face list; the latin block carrying U+0000-00FF is the one
// this page's text lives in. A Chrome UA is required or the API serves TTF instead of woff2.
const CSS = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;600&display=swap";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

export async function ensureDeviceFont() {
  if (existsSync(FILE)) return FILE;
  mkdirSync(DIR, { recursive: true });
  const css = await (await fetch(CSS, { headers: { "User-Agent": UA } })).text();
  const latin = css.match(/@font-face\s*\{[^}]*U\+0000-00FF[^}]*\}/g);
  if (!latin) throw new Error("device-font: no latin @font-face block in the Google Fonts response");
  const url = latin[latin.length - 1].match(/url\((https:\/\/[^)]+)\)/)[1];
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if (buf.length < 10000) throw new Error(`device-font: refusing a ${buf.length}-byte font file from ${url}`);
  writeFileSync(FILE, buf);
  return FILE;
}

// Installs Roboto over the page's own stack. Applied to the label AND the card names — the two things a
// letterform claim compares — plus `body`, so nothing inherits the harness's font behind our back.
export async function useDeviceFont(page, file) {
  await page.evaluate(async f => {
    const face = new FontFace("DeviceRoboto", `url(file://${f})`, { weight: "100 900" });
    await face.load();
    document.fonts.add(face);
    const s = document.createElement("style");
    s.textContent = `body, .sess .nm, #tab-sessions .sechead, #tab-sessions .sechead * {
      font-family: DeviceRoboto, sans-serif !important; }`;
    document.head.appendChild(s);
    await document.fonts.ready;
  }, file);
}

// An ink read is only sound if the band holds ONE mark on ONE fill. A band that another surface overlaps
// — the floating pill over the last card is the case that bit this file — reports a confident number
// about the wrong ink, so the padding columns are checked and an overlapped band returns null.
export async function inkLeft(page, rect, dpr, pad = 4) {
  const band = { x: rect.x - pad, y: rect.y, width: rect.w + 2 * pad, height: rect.h };
  const shot = await page.screenshot({ clip: band });
  return page.evaluate(async ([data, bx, d, padPx]) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const at = (x, y) => { const i = (y * img.width + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    const bg = at(0, 0);
    const cols = [...Array(img.width)].map((_, x) => {
      let s = 0;
      for (let y = 0; y < img.height; y++) { const q = at(x, y); s += Math.max(...q.map((v, k) => Math.abs(v - bg[k]))); }
      return s;
    });
    const peak = Math.max(...cols);
    if (!peak) return null;
    const first = cols.findIndex(v => v > peak * 0.02);
    // Ink in the left padding means something else is in the frame: not our mark's edge.
    if (first < Math.floor(padPx * d * 0.5)) return null;
    return bx + first / d;
  }, [shot.toString("base64"), band.x, dpr, pad]);
}
