import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { ensureDeviceFont, useDeviceFont, inkLeft, inkExtent } from "./device-font.mjs";
// WHY THIS FILE EXISTS — the section label's column was disputed off the owner's phone twice on
// 2026-07-30, and the fixture passed both times. A PROBE, not a gate: it prints numbers across the
// conditions a single-condition fixture cannot see, and those numbers are what settle the argument.
//
// Three lessons are baked in, each bought with a round trip:
//
// 1. THE HARNESS'S FONT IS NOT THE DEVICE'S. Headless Chromium here resolves the page's stack to DejaVu
//    Sans; his Android WebView resolves it to Roboto. Left side bearings differ between them, so "the
//    label's C is flush with the card name" was true in DejaVu and false on his screen. §2 runs in Roboto
//    (`device-font.mjs`) and prints DejaVu beside it, because the difference IS the lesson.
//
// 2. A PHOTO IS MEASURABLE. His first crop carried the 11px status dot — a known-size object, therefore a
//    ruler (scale = its ink width ÷ 11). His second crop had no dot in frame, so the ruler came from the
//    ink width of strings this page renders (`cwd-fix`, `Coding`) measured locally; two independent
//    rulers agreeing to 10% is what makes the conversion trustworthy. Reach for this before changing a
//    layout an owner has photographed.
//
// 3. THERE IS NO "NAMES' INK COLUMN" TO ALIGN TO. A session name starts with whatever letter it starts
//    with, and a letterform's left side bearing is its own: in Roboto the `t` of `trading` paints 0.625px
//    left of where the `m` of `memes` does. §2 prints that spread, which is the finding — one gap cannot
//    put one C on all of them, so the lever cannot satisfy the spec for every card at once. Whether to
//    spend it on the average is the owner's call, and this table is what he decides from.
//
// §3 is the one the shipped gap is derived from: the WHITESPACE after the ✳ against the whitespace after a
// dot, in Roboto. That comparison cannot live in `listorder.mjs` — in the harness's DejaVu the same correct
// page reads 7.75 against 8.50, because the glyph's underfill and the names' bearings both move with the
// font — so the gate there holds the box offset and this holds the parity.
//
// Run: bun scripts/webapp-measure/labelaxis.mjs [page.html]   (defaults to the checkout's page; pass the
// plugin cache's copy to measure what the daemon is actually SERVING).
const PAGE = process.argv[2] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";

const card = (sid, name, over = {}) => ({ sid, name, cwd: `~/projects/${name}`, alive: true, working: true,
  state: "working", task: "a task line", model: "Opus 5", effort: "high", ctxPct: 42, h5Pct: 26, branch: "main", subagents: 0, ...over });
const chat = (sid, name) => card(sid, name, { chat: true, state: "waiting", working: false });
const USAGE = { fiveHour: { pct: 26, resetIn: "1h41m" }, sevenDay: { pct: 85, resetIn: "3d12h" } };
// The two cards he photographed, plus the letters and states that make the spread visible. The trailing
// spacer keeps every measured row clear of the floating pill, which overlaps the LAST card — an ink band
// read there returns null (`inkLeft`) instead of a confident number about the wrong ink.
const NAMES = [
  card("a", "cwd-fix"),                                                     // his second photo
  card("b", "trading"),                                                     // his first photo
  card("c", "cc-bridge"),
  card("d", "memes", { state: "waiting", working: false, wait: { label: "gh run watch" } }),
  chat("e", "Chat (@suchag)"),
  card("f", "idle-one", { state: "idle", working: false }),
  card("g", "unreported-one", { state: "unreported", working: false, lastReply: "done" }),
  card("h", "Uppercase-Name"),
  card("z", "spacer-under-the-pill"),
];

const b = await chromium.launch();
const open = async (dpr, width, sessions, font) => {
  const p = await b.newPage({ viewport: { width, height: 812 }, deviceScaleFactor: dpr });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (font) await useDeviceFont(p, font);
  await p.evaluate(([ss, u]) => { window.api = async q => q.includes("/api/sessions") ? { sessions: ss, usage: u } : {}; showTab("sessions"); }, [sessions, USAGE]);
  await p.waitForTimeout(600);
  return p;
};
const geom = p => p.evaluate(() => {
  const fc = el => { const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 1);
    const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, ch: el.firstChild.textContent[0] }; };
  const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const g = document.querySelector("#tab-sessions .sechead .sglyph");
  const w = document.querySelector("#tab-sessions .sechead .swords");
  const lab = document.querySelector("#tab-sessions .sechead");
  let first = lab && lab.nextElementSibling;
  while (first && !first.classList.contains("sess")) first = first.nextElementSibling;
  return { font: getComputedStyle(w).fontFamily.split(",")[0],
    glyph: g && box(g), words: w && { ...fc(w), box: w.getBoundingClientRect().x },
    dot: first && box(first.querySelector(".top .dot")),
    cards: [...document.querySelectorAll("#tab-sessions .sess:not(#usagehead)")].map(c => {
      const n = c.querySelector(".nm"); return { name: n.textContent, box: n.getBoundingClientRect().x, ...fc(n) }; }) };
});

// ---- §1 the COLUMN, which is padding-derived and therefore font-independent --------------------------
console.log("§1 the column across widths and DPRs — BOX geometry, which no font can move\n");
console.log("width dpr  above-label   glyph-vs-dot   words-vs-name");
let worst = 0;
for (const width of [320, 360, 375, 390, 412, 430]) for (const dpr of [2, 3]) for (const withChat of [true, false]) {
  const sessions = withChat ? [chat("s4", "Chat (@suchag)"), card("s1", "trading")] : [card("s1", "trading"), card("s2", "memes")];
  const p = await open(dpr, width, sessions, null);
  const g = await geom(p);
  const gd = +(g.glyph.x + g.glyph.w / 2 - (g.dot.x + g.dot.w / 2)).toFixed(2);
  const wn = +(g.words.box - g.cards.find(c => c.name === "trading").box).toFixed(2);
  worst = Math.max(worst, Math.abs(gd), Math.abs(wn));
  console.log(`${String(width).padEnd(5)} ${dpr}    ${(withChat ? "chat lane" : "worker").padEnd(12)} ${String(gd).padStart(12)} ${String(wn).padStart(15)}`);
  await p.close();
}
console.log(`\nworst box deviation across 24 conditions: ${worst.toFixed(2)}px — the column does not move with width or DPR\n`);

// ---- §2 the LETTERFORMS, in the font his device actually uses ----------------------------------------
const font = await ensureDeviceFont();
const DPR = 8;   // 0.125px resolution: the spread under test is a fraction of one CSS pixel
// A row below the fold has no pixels to read, so each mark is scrolled into view and its rect RE-READ
// immediately before the screenshot — a rect taken before the scroll names a clip outside the image, which
// throws and takes the whole table down with it. Only y moves; the x under test is untouched.
const firstCharRect = (p, i) => p.evaluate(idx => {
  const el = idx === null ? document.querySelector("#tab-sessions .sechead .swords")
    : [...document.querySelectorAll("#tab-sessions .sess:not(#usagehead)")][idx].querySelector(".nm");
  el.scrollIntoView({ block: "center" });
  const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 1);
  const b = r.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height, ch: el.firstChild.textContent[0], box: el.getBoundingClientRect().x };
}, i);
const table = async useRoboto => {
  const p = await open(DPR, 390, NAMES, useRoboto ? font : null);
  const g = await geom(p);
  const li = await inkLeft(p, await firstCharRect(p, null), DPR);
  const rows = [];
  for (let i = 0; i < g.cards.length; i++) {
    const r = await firstCharRect(p, i);
    const ink = await inkLeft(p, r, DPR);
    rows.push({ name: g.cards[i].name, ch: r.ch, box: r.box, ink, d: ink === null || li === null ? null : +(li - ink).toFixed(3) });
  }
  await p.close();
  return { font: g.font, labelBox: g.words.box, labelInk: li, rows };
};
for (const useRoboto of [true, false]) {
  const t = await table(useRoboto);
  const live = t.rows.filter(r => r.d !== null);
  const ds = live.map(r => r.d);
  console.log(`§2 ${useRoboto ? "DEVICE FONT (Roboto — what his phone renders)" : "HARNESS FONT (DejaVu Sans — what this box renders)"}`);
  console.log(`   family in use: ${t.font} · label "C" box ${t.labelBox}, ink ${t.labelInk.toFixed(3)} @dpr${DPR}`);
  console.log(`   name                  first  box    ink       Δ ink (label C minus name)`);
  for (const r of t.rows)
    console.log(`   ${r.name.slice(0, 21).padEnd(21)} ${r.ch}      ${String(r.box).padStart(5)}  ${r.ink === null ? "(overlapped — no read)" : r.ink.toFixed(3).padStart(8)}  ${r.d === null ? "" : (r.d >= 0 ? "+" : "") + r.d.toFixed(3)}`);
  const lo = Math.min(...ds), hi = Math.max(...ds), mean = ds.reduce((a, v) => a + v, 0) / ds.length;
  console.log(`   Δ range ${lo.toFixed(3)} … ${hi.toFixed(3)}px · spread ${(hi - lo).toFixed(3)}px · mean ${mean.toFixed(3)}px (+ = the C sits RIGHT of the name)`);
  console.log(`   → a single gap change ${hi - lo <= 0.25 ? "COULD" : "CANNOT"} put the C on every name's ink `
    + `(spread ${(hi - lo).toFixed(3)}px); spent on the mean it would leave ${Math.max(Math.abs(hi - mean), Math.abs(lo - mean)).toFixed(3)}px worst-case\n`);
}
// ---- §3 replacement glyph whitespace, reported only (the words are position-frozen) ----------------
{
  const p = await open(DPR, 390, NAMES, font);
  const g = await geom(p);
  const gi = await inkExtent(p, g.glyph, DPR);
  const li = await inkExtent(p, await firstCharRect(p, null), DPR);
  const labelGap = li.left - gi.right;
  console.log(`§3 REPLACEMENT GLYPH — words frozen at the pre-swap coordinate`);
  console.log(`   glyph box ${g.glyph.x}..${g.glyph.x + g.glyph.w}  ink ${gi.left.toFixed(3)}..${gi.right.toFixed(3)}`
    + `  → right residual ${(g.glyph.x + g.glyph.w - gi.right).toFixed(3)}px`);
  const gaps = [];
  for (let i = 0; i < g.cards.length; i++) {
    const r = await firstCharRect(p, i);
    const dot = await p.evaluate(idx => { const c = [...document.querySelectorAll("#tab-sessions .sess:not(#usagehead)")][idx];
      const d = c.querySelector(".top .dot").getBoundingClientRect(); return { x: d.x, y: d.y, w: d.width, h: d.height }; }, i);
    const di = await inkExtent(p, dot, DPR), ni = await inkExtent(p, r, DPR);
    if (di && ni) gaps.push({ name: g.cards[i].name, ch: r.ch, gap: ni.left - di.right });
  }
  for (const c of gaps) console.log(`   card ${c.name.slice(0, 21).padEnd(21)} ${c.ch}  dot ink → name ink: ${c.gap.toFixed(3)}px`);
  const tight = Math.min(...gaps.map(c => c.gap)), wide = Math.max(...gaps.map(c => c.gap));
  const mean = gaps.reduce((a, c) => a + c.gap, 0) / gaps.length;
  console.log(`   cards: ${tight.toFixed(3)} … ${wide.toFixed(3)} (mean ${mean.toFixed(3)})  ·  LABEL: ${labelGap.toFixed(3)}px`);
  console.log(`   reported only: the replacement changes glyph whitespace; the label text coordinate stays frozen`);
  await p.close();
}
await b.close();
