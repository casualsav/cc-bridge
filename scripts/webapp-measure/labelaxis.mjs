import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// WHY THIS FILE EXISTS — the owner's phone was said to disagree with `listorder.mjs` about the section
// label's column (2026-07-30): a zoomed photo of the LIVE page in which the ✳ and the words looked left
// of the card's dot and name. A PROBE, not a gate: it sweeps the conditions a fixture at one width and
// one DPR cannot see, and prints numbers rather than passing or failing.
//
// Two lessons are baked in. First, ask what the number measured: the fixture measured 390px at dpr 2,
// and a phone is neither. Second, a PHOTO IS MEASURABLE — that screenshot carried an object of known
// size, the 11px status dot, so it is its own ruler: scale = the dot's ink width / 11, and every other
// offset in the frame converts to CSS px through it. Measured that way his own photo read 0.25px on the
// glyph and 0.49px on the C — the harness's own numbers — which is what said the page was right and the
// reading of the photo was not. Reach for that before changing a layout an owner has photographed.
//
// Run: bun scripts/webapp-measure/labelaxis.mjs [page.html]   (defaults to the checkout's page; pass the
// plugin cache's copy to measure what the daemon is actually SERVING).
// The conditions his phone could be in that the fixture never was: viewport width across the phone
// range, DPR 2 and 3, and a production-shaped card (a working coding session named "trading", the very
// card in his crop) with NO chat lane above it — his crop shows the label directly over a worker.
const PAGE = process.argv[2] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";
const worker = (sid, name, over = {}) => ({ sid, name, cwd: `~/projects/${name}`, alive: true, working: true,
  state: "working", task: "running the backtest", model: "Opus 5", effort: "high", ctxPct: 42, h5Pct: 26, branch: "main", subagents: 0, ...over });
const chat = (sid, name) => ({ sid, name, chat: true, cwd: "", alive: true, working: false, state: "waiting",
  task: "ok", model: "Fable 5", effort: "high", ctxPct: 34, h5Pct: 26, branch: "main", subagents: 0 });
const USAGE = { fiveHour: { pct: 26, resetIn: "1h41m" }, sevenDay: { pct: 85, resetIn: "3d12h" } };
const b = await chromium.launch();

const inkOnset = async (p, band, dpr) => {
  const shot = await p.screenshot({ clip: band });
  return p.evaluate(async ([data, bx, d]) => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const at = (x, y) => { const i = (y * img.width + x) * 4; return [px[i], px[i+1], px[i+2]]; };
    const bg = at(0, 0);
    const cols = [...Array(img.width)].map((_, x) => { let s = 0;
      for (let y = 0; y < img.height; y++) { const q = at(x, y); s += Math.max(Math.abs(q[0]-bg[0]), Math.abs(q[1]-bg[1]), Math.abs(q[2]-bg[2])); } return s; });
    const peak = Math.max(...cols);
    if (!peak) return null;
    const first = cols.findIndex(v => v > peak * 0.02), last = cols.reduce((a, v, i) => v > peak * 0.02 ? i : a, -1);
    return { onset: bx + first / d, end: bx + last / d, mid: bx + (first + last) / 2 / d };
  }, [shot.toString("base64"), band.x, dpr]);
};

const rows = [];
for (const width of [320, 360, 375, 390, 412, 430]) for (const dpr of [2, 3]) for (const withChat of [true, false]) {
  const sessions = withChat ? [chat("s4", "Chat (@suchag)"), worker("s1", "trading")] : [worker("s1", "trading"), worker("s2", "memes")];
  const p = await b.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: dpr });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(([ss, u]) => { window.api = async q => q.includes("/api/sessions") ? { sessions: ss, usage: u } : {}; showTab("sessions"); }, [sessions, USAGE]);
  await p.waitForTimeout(500);
  const at = await p.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const firstChar = e => { const rg = document.createRange(); rg.setStart(e.firstChild, 0); rg.setEnd(e.firstChild, 1);
      const b = rg.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, ch: e.firstChild.textContent[0] }; };
    const g = document.querySelector("#tab-sessions .sechead .sglyph");
    const w = document.querySelector("#tab-sessions .sechead .swords");
    // the card the label heads: the first worker card AFTER the label
    const lab = document.querySelector("#tab-sessions .sechead");
    let card = lab && lab.nextElementSibling;
    while (card && !card.classList.contains("sess")) card = card.nextElementSibling;
    return { glyph: g && r(g), words: w && firstChar(w), dot: card && r(card.querySelector(".top .dot")),
      name: card && firstChar(card.querySelector(".nm")), nameFull: card && card.querySelector(".nm").textContent };
  });
  const pad = 5;
  const gi = await inkOnset(p, { x: at.glyph.x - pad, y: at.glyph.y, width: at.glyph.w + 2*pad, height: at.glyph.h }, dpr);
  const di = await inkOnset(p, { x: at.dot.x - pad, y: at.dot.y, width: at.dot.w + 2*pad, height: at.dot.h }, dpr);
  const wi = await inkOnset(p, { x: at.words.x - pad, y: at.words.y, width: at.words.w + 2*pad, height: at.words.h }, dpr);
  const ni = await inkOnset(p, { x: at.name.x - pad, y: at.name.y, width: at.name.w + 2*pad, height: at.name.h }, dpr);
  rows.push({ width, dpr, chat: withChat, card: at.nameFull, boxGlyphVsDot: +(at.glyph.x + at.glyph.w/2 - (at.dot.x + at.dot.w/2)).toFixed(2),
    boxWordsVsName: +(at.words.x - at.name.x).toFixed(2),
    inkGlyphVsDot: +(gi.mid - di.mid).toFixed(2), inkFirstLetter: +(wi.onset - ni.onset).toFixed(2),
    letters: `${at.words.ch}/${at.name.ch}` });
  await p.close();
}
console.log("width dpr chat card      box:glyph-dot box:words-name ink:glyph-dot ink:C-vs-first");
for (const r of rows) console.log(`${String(r.width).padEnd(5)} ${r.dpr}   ${String(r.chat).padEnd(5)} ${r.card.padEnd(9)} ${String(r.boxGlyphVsDot).padStart(12)} ${String(r.boxWordsVsName).padStart(14)} ${String(r.inkGlyphVsDot).padStart(13)} ${String(r.inkFirstLetter).padStart(14)}  ${r.letters}`);
const worst = rows.reduce((a, r) => Math.max(a, Math.abs(r.inkGlyphVsDot), Math.abs(r.boxGlyphVsDot), Math.abs(r.boxWordsVsName)), 0);
console.log(`\nworst box/ink-centre deviation across ${rows.length} conditions: ${worst.toFixed(2)}px`);
console.log(`first-letter ink spread: ${Math.min(...rows.map(r => r.inkFirstLetter)).toFixed(2)} … ${Math.max(...rows.map(r => r.inkFirstLetter)).toFixed(2)}px (letterform side bearings)`);
await b.close();
