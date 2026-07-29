// The composer is a TWO-ROW box: the field on the top line, the controls on their own line under
// it, ~3 text lines tall at rest — and it still grows a line at a time on top of that.
//
//   node composerbox.mjs [pagePath] [outdir]
//
// Four claims, each able to fail on its own:
//   1. REST. Empty, the capsule is the two rows plus its own air — not a one-line pill. Measured
//      against the parts (ring + the field's one-line box + the row gap + the mic + ring), so the
//      number stays right if the type scale or the mic moves.
//   2. SHAPE. The field owns the TOP line at full width — its top edge is one ring below the
//      capsule's, and it spans the capsule minus a ring at both ends. The controls sit on the
//      BOTTOM line, chip at one end, clip and round button at the other, all three on one axis.
//   3. GROWTH. Wrapped text still grows the box a line box at a time ABOVE the control row, which
//      does not move, and the cap still bites (line 7 of 10 is scrolled to, not grown to).
//   4. NOTHING ELSE MOVES. Header, capsule floor, capsule ends, corner radius, the feed's box and
//      the newest message's clearance — all re-measured per case against the EMPTY composer's own
//      numbers rather than constants.
//
// CONTROL: pass a pre-change page (`git show HEAD:webapp/index.html > /tmp/old.html`). Every REST
// and SHAPE check must FAIL there — it is a one-line pill with the controls beside the field — and
// the GROWTH and NOTHING-ELSE checks must PASS on BOTH pages: they describe behaviour this change
// inherits, and a guard that only starts holding afterwards would mean the change caused what it
// guards.
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const PAGE = process.argv[2] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";
const OUT = process.argv[3] || "composerbox-shots";
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 });
p.on("pageerror", () => {});
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(300);
// A real drill-in: the feed under the composer is what the dock's height is given back to, so a
// stubbed-open #drill would leave half the nothing-else-moves claim unmeasurable. Long enough to
// FILL the scroller — with a short transcript the newest message floats mid-screen and "still clear
// of the capsule" cannot fail however far the composer grows.
await p.evaluate(() => {
  window.api = async path => path.includes("feed")
    ? { working: false, items: Array.from({ length: 40 }, (_, i) => ({ text: "message " + (i + 1), at: Date.now() - i * 1000, role: i % 2 ? "user" : "assistant" })) }
    : {};
  openDrill("fake-sid", "fake");
});
await p.waitForTimeout(400);
await p.locator("#dtext").focus();

const snap = () => p.evaluate(() => {
  const r = e => { const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2), bottom: +b.bottom.toFixed(2), right: +b.right.toFixed(2) }; };
  const ta = document.getElementById("dtext"), cs = getComputedStyle(ta);
  const wrap = document.querySelector(".inputwrap"), ws = getComputedStyle(wrap);
  const round = document.getElementById("dsend").style.display !== "none" ? document.getElementById("dsend") : document.getElementById("dmic");
  const feed = document.getElementById("dfeed");
  const lh = parseFloat(cs.lineHeight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const last = feed.lastElementChild;
  // The control row exists only on the two-row page; on the control it is absent and every SHAPE
  // check below has to say so rather than throw.
  const ctl = document.querySelector(".ctlrow");
  return {
    lh: +lh.toFixed(3), padY, ring: parseFloat(ws.paddingBottom), gap: parseFloat(ws.rowGap) || 0,
    micD: parseFloat(getComputedStyle(document.getElementById("dmic")).height),
    visibleLines: +((ta.clientHeight - padY) / lh).toFixed(3),
    contentLines: +((ta.scrollHeight - padY) / lh).toFixed(3),
    scrollable: ta.scrollHeight > ta.clientHeight + 1,
    capLines: +((parseFloat(cs.maxHeight) - padY) / lh).toFixed(3),
    pill: r(wrap), radius: getComputedStyle(wrap).borderBottomRightRadius,
    ta: r(ta), ctl: ctl ? r(ctl) : null,
    head: r(document.querySelector("#drill .vhead")),
    dial: r(document.getElementById("ddial")), clip: r(document.getElementById("datt")), round: r(round),
    composer: r(document.querySelector(".composer")),
    feed: r(feed), feedPadBottom: parseFloat(getComputedStyle(feed).paddingBottom),
    lastMsgBottom: last ? +last.getBoundingClientRect().bottom.toFixed(2) : null,
    docScrollW: document.documentElement.scrollWidth,
  };
});

// Wrapped lines, not "\n" lines: the spec is about text that WRAPS, and a newline reaches the same
// height through a path a thumb cannot take.
const fillToLines = (n) => p.evaluate(async want => {
  const ta = document.getElementById("dtext"), cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const lines = () => Math.round((ta.scrollHeight - padY) / lh);
  ta.value = ""; ta.dispatchEvent(new Event("input"));
  let words = 0;
  while (lines() < want && words < 4000) { ta.value += (words++ ? " " : "") + "wrap"; ta.dispatchEvent(new Event("input")); }
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  ta.dispatchEvent(new Event("input"));
  return lines();
}, n);

const shoot = async (name) => {
  const clip = await p.locator("#ddock").evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y - 80, width: b.width, height: b.height + 80 }; });
  for (let i = 0; i < 6; i++) { try { await p.screenshot({ path: `${OUT}/${name}.png`, clip }); return; } catch { await p.waitForTimeout(300); } }
};

const checks = [];
const ok = (label, pass, detail) => checks.push({ label, pass, detail });
const near = (a, b, tol = 0.51) => a != null && b != null && Math.abs(a - b) <= tol;
const sameRect = (a, b) => ["x", "y", "w", "h"].every(k => near(a[k], b[k]));

const cases = {};
cases.empty = await snap();
await shoot("1-empty");
for (const n of [2, 5, 10]) {
  const got = await fillToLines(n);
  // The feed's bottom reserve is written by a ResizeObserver on #ddock, one frame behind the growth.
  // Read straight after typing and the reserve reports the PREVIOUS composer height — a real state
  // the eye never sees, and reading it is measuring the wrong page.
  await p.waitForTimeout(200);
  cases[n + "lines"] = { ...(await snap()), asked: n, got };
  await shoot(`${n}-wrapped-lines`);
}
const E = cases.empty;
const oneLineField = E.lh + E.padY;                       // the field's own box at one line
const rest = 2 * E.ring + oneLineField + E.gap + E.micD;  // ring · field · gap · controls · ring

// ---- 1. rest --------------------------------------------------------------------------------
ok("empty: the field itself still shows ONE line", near(E.visibleLines, 1, 0.05), `${E.visibleLines}`);
ok("empty: capsule is the two rows plus its air", near(E.pill.h, rest), `${E.pill.h} vs ${rest.toFixed(2)}`);
ok("empty: that is ~3 text lines tall", E.pill.h / E.lh >= 3 && E.pill.h / E.lh <= 5.2, `${(E.pill.h / E.lh).toFixed(2)} line boxes`);
ok("empty: nothing scrolls inside the field", !E.scrollable, `${E.scrollable}`);

// ---- 2. shape -------------------------------------------------------------------------------
ok("field is on the TOP line (one ring below the capsule's top)", near(E.ta.y - E.pill.y, E.ring), `${(E.ta.y - E.pill.y).toFixed(2)} vs ${E.ring}`);
ok("field spans the capsule's full width", near(E.ta.x - E.pill.x, E.ring) && near(E.pill.right - E.ta.right, E.ring), `${(E.ta.x - E.pill.x).toFixed(2)} / ${(E.pill.right - E.ta.right).toFixed(2)}`);
ok("controls are their own row UNDER the field", !!E.ctl && E.ctl.y >= E.ta.bottom - 0.5, E.ctl ? `ctl.y=${E.ctl.y} ta.bottom=${E.ta.bottom}` : "no .ctlrow");
ok("that row is the mic's own height", !!E.ctl && near(E.ctl.h, E.micD), E.ctl ? `${E.ctl.h}` : "no .ctlrow");
ok("chip at one end, clip and round button at the other", E.dial.x < E.clip.x && E.clip.right <= E.round.x + 0.5 && E.round.right > E.clip.right, `dial→${E.dial.right} clip ${E.clip.x}→${E.clip.right} round ${E.round.x}→${E.round.right}`);
ok("all three controls on ONE axis", near((E.dial.y + E.dial.bottom) / 2, (E.round.y + E.round.bottom) / 2, 0.6) && near((E.clip.y + E.clip.bottom) / 2, (E.round.y + E.round.bottom) / 2, 0.6), `${((E.dial.y + E.dial.bottom) / 2).toFixed(1)} / ${((E.clip.y + E.clip.bottom) / 2).toFixed(1)} / ${((E.round.y + E.round.bottom) / 2).toFixed(1)}`);
ok("chip's arc is concentric with the bottom-left corner", near(E.dial.x - E.pill.x + E.dial.h / 2, parseFloat(E.radius)) && near(E.pill.bottom - (E.dial.y + E.dial.bottom) / 2, parseFloat(E.radius)), `${(E.dial.x - E.pill.x + E.dial.h / 2).toFixed(2)} / ${(E.pill.bottom - (E.dial.y + E.dial.bottom) / 2).toFixed(2)} vs ${E.radius}`);
ok("mic's disc is concentric with the bottom-right corner", near(E.pill.right - E.round.right + E.micD / 2, parseFloat(E.radius)) && near(E.pill.bottom - E.round.bottom + E.micD / 2, parseFloat(E.radius)), `${(E.pill.right - E.round.right + E.micD / 2).toFixed(2)} vs ${E.radius}`);

// ---- 3. growth ------------------------------------------------------------------------------
for (const n of [2, 5]) {
  const c = cases[n + "lines"];
  ok(`${n} wrapped lines show ${n}`, c.got === n && near(c.visibleLines, n, 0.05), `content=${c.contentLines} visible=${c.visibleLines}`);
  ok(`${n} lines do not scroll internally`, !c.scrollable, `${c.scrollable}`);
  // 1.01px, not half a pixel: growComposer() assigns `scrollHeight`, which is an INTEGER, so a
  // fractional line box (21.6) is rounded once per measurement — a real 0.6px, not slack for a
  // wrong number. Anything off by a fraction of a line box still fails.
  ok(`${n} lines grow the capsule by exactly ${n - 1} line boxes`, near(c.pill.h - E.pill.h, (n - 1) * E.lh, 1.01), `+${(c.pill.h - E.pill.h).toFixed(2)} vs ${((n - 1) * E.lh).toFixed(2)}`);
  ok(`${n} lines grow the field UPWARD, not the row down`, near(c.ta.bottom, E.ta.bottom) || near(c.pill.bottom - c.ta.bottom, E.pill.bottom - E.ta.bottom), `field bottom ${c.ta.bottom} vs ${E.ta.bottom}`);
}
const C10 = cases["10lines"];
ok("cap is a WHOLE number of lines (no sliver)", near(E.capLines % 1, 0, 0.02), `${E.capLines}`);
ok("10 lines stop at the cap", near(C10.visibleLines, E.capLines, 0.05), `${C10.visibleLines} vs cap ${E.capLines}`);
ok("10 lines scroll INSIDE the field", C10.scrollable && C10.contentLines > 9.5, `content=${C10.contentLines}`);
ok("10 lines grow the capsule no further than the cap", near(C10.pill.h, E.pill.h + (E.capLines - 1) * E.lh), `${C10.pill.h} vs ${(E.pill.h + (E.capLines - 1) * E.lh).toFixed(2)}`);

// ---- 4. nothing else moves --------------------------------------------------------------------
for (const [name, c] of Object.entries(cases)) {
  if (c === E) continue;
  ok(`${name}: header unmoved`, sameRect(c.head, E.head), JSON.stringify(c.head));
  ok(`${name}: capsule FLOOR unmoved (it grows upward)`, near(c.pill.bottom, E.pill.bottom), `${c.pill.bottom} vs ${E.pill.bottom}`);
  ok(`${name}: capsule ends unmoved`, near(c.pill.x, E.pill.x) && near(c.pill.right, E.pill.right), `${c.pill.x}..${c.pill.right}`);
  ok(`${name}: composer floor unmoved`, near(c.composer.bottom, E.composer.bottom), `${c.composer.bottom}`);
  ok(`${name}: radius still the ONE-ROW radius`, c.radius === E.radius, `${c.radius} vs ${E.radius}`);
  ok(`${name}: controls still pinned to the capsule's floor`, near(c.pill.bottom - c.round.bottom, E.pill.bottom - E.round.bottom) && near(c.pill.bottom - c.dial.bottom, E.pill.bottom - E.dial.bottom) && near(c.pill.bottom - c.clip.bottom, E.pill.bottom - E.clip.bottom), `${(c.pill.bottom - c.round.bottom).toFixed(2)} / ${(c.pill.bottom - c.dial.bottom).toFixed(2)} / ${(c.pill.bottom - c.clip.bottom).toFixed(2)}`);
  ok(`${name}: controls unmoved sideways`, near(c.dial.x, E.dial.x) && near(c.round.right, E.round.right) && near(c.clip.x, E.clip.x), `${c.dial.x} / ${c.clip.x} / ${c.round.right}`);
  ok(`${name}: feed box unmoved, only its dock reserve grows`, sameRect(c.feed, E.feed) && near(c.feedPadBottom - E.feedPadBottom, c.pill.h - E.pill.h, 1.01), `pad ${E.feedPadBottom}→${c.feedPadBottom}, pill +${(c.pill.h - E.pill.h).toFixed(2)}`);
  ok(`${name}: newest message still clear of the capsule`, c.lastMsgBottom <= c.composer.y + 0.5, `${c.lastMsgBottom} vs ${c.composer.y}`);
  ok(`${name}: page never scrolls sideways`, c.docScrollW <= 390, `${c.docScrollW}`);
}

console.log(`page: ${PAGE}`);
console.log(` parts: ring=${E.ring} lineBox=${E.lh} fieldPad=${E.padY} gap=${E.gap} mic=${E.micD}  ->  rest=${rest.toFixed(2)}`);
for (const [k, c] of Object.entries(cases)) console.log(` ${k.padEnd(9)} capsule=${String(c.pill.h).padEnd(7)} visible=${String(c.visibleLines).padEnd(6)} content=${String(c.contentLines).padEnd(7)} scroll=${c.scrollable}`);
console.log();
let bad = 0;
for (const c of checks) { if (!c.pass) bad++; console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label.padEnd(58)} ${c.detail}`); }
console.log(`\n${checks.length - bad}/${checks.length} pass  ·  shots in ${OUT}/`);
await b.close();
process.exit(bad ? 1 : 0);
