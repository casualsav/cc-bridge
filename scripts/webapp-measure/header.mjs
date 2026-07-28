import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The chat header: three containers ONE height, a name two steps above the cwd, a capsule 20%
// narrower than the span it bridges, chips the transcript passes BEHIND, and a title centred on the
// dot+name group rather than on the name alone.
//
//   node header.mjs [page]
//
// Control: run it against a pre-change copy (git show HEAD:webapp/index.html > /tmp/old.html) —
// height, type, width, float and centring must all FAIL there, or this harness cannot fail.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = mkdtempSync(join(tmpdir(), "header-"));

const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const FEED = {
  ...SESSION,
  items: Array.from({ length: 14 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `Message ${i + 1}. ` + "Enough text to make the transcript overflow its scroller so there is something to scroll behind the header. ".repeat(2),
    ts,
  })),
};

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const near = (a, b, tol = 0.51) => Math.abs(a - b) <= tol;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(({ feed, session }) => {
  window.api = async path => path.includes("session/feed") ? feed
    : path.includes("sessions") ? { sessions: [session] } : {};
  openDrill(session.sid, session.name);
}, { feed: FEED, session: SESSION });
await p.waitForTimeout(900);   // README rule 2: idle before reading pixels

const m = await p.evaluate(() => {
  const r = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
  const cs = el => getComputedStyle(el);
  const head = document.querySelector("#drill .vhead");
  const cap = document.querySelector("#drill .dtitle");
  const back = document.getElementById("dback");
  const stop = document.getElementById("dstop");
  const name = document.getElementById("dname");
  const dot = document.getElementById("ddot");
  const sub = document.getElementById("dsub");
  const feed = document.getElementById("dfeed");
  const msgs = [...feed.querySelectorAll(".msg")];
  return {
    head: r(head), cap: r(cap), back: r(back), stop: r(stop),
    name: r(name), dot: r(dot), sub: r(sub), feed: r(feed),
    headPos: cs(head).position,
    headW: head.clientWidth,
    gap: parseFloat(cs(head).gap),
    nameFont: parseFloat(cs(name).fontSize), nameWeight: cs(name).fontWeight,
    subFont: parseFloat(cs(sub).fontSize),
    capBg: cs(cap).backgroundColor, backBg: cs(back).backgroundColor,
    backPad: cs(back).padding,
    backRadius: parseFloat(cs(back).borderTopLeftRadius),
    feedPadTop: parseFloat(cs(feed).paddingTop),
    firstMsgTop: msgs.length ? r(msgs[0]).top : null,
    scrollable: feed.scrollHeight - feed.clientHeight,
  };
});

// 1. Height — the three containers agree, and the row came down.
check(near(m.back.h, m.cap.h) && near(m.cap.h, m.stop.h), `three containers one height (${m.back.h} / ${m.cap.h} / ${m.stop.h})`);
check(m.cap.h === 36, `row height 36, was 44 (got ${m.cap.h})`);
// …and the buttons are no longer round: wider than tall, with a STADIUM radius. A percentage radius
// on a non-square box draws an ellipse, which is the wrong shape and passes any width check.
check(m.back.w > m.back.h && m.back.w === m.back.h + 8, `buttons wider than tall (${m.back.w} x ${m.back.h})`);
check(near(m.backRadius, m.back.h / 2), `stadium radius, not an ellipse (${m.backRadius} vs ${m.back.h / 2})`);

// 2. Type — two steps apart, bold kept, and the taller type still fits the line box it did not grow.
check(m.nameFont === 14 && m.subFont === 11, `name 14 / cwd 11, two scale steps apart (got ${m.nameFont} / ${m.subFont})`);
check(m.nameWeight === "600", `name keeps --w-semi (got ${m.nameWeight})`);
// A guard, not a regression check: it passes on the pre-change page too (12px cleared 16px trivially).
// It exists because raising the type WITHOUT raising --h-l1 is what keeps the row at 36, and the cost
// of that trade is paid here — this rule carries overflow: hidden, so ink past the box is SLICED.
// In PIXELS, because the box's own rect agrees with the CSS by construction and canvas metrics
// disagreed with the paint by a whole CSS pixel. Carries its own falsifying control: at 22px the ink
// must reach both edges, or the probe is measuring nothing.
const inkRows = async () => {
  const box = await p.evaluate(() => {
    const r = document.getElementById("dname").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const shot = await p.screenshot({ clip: box });
  const rows = execFileSync("python3", ["-c", `
import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
w, h = im.size
px = im.load()
# The name is near-white --text over the scrim's solid part, which is flat --bg at this line.
print(" ".join(str(sum(1 for x in range(w) if 0.2126*px[x,y][0] + 0.7152*px[x,y][1] + 0.0722*px[x,y][2] > 110)) for y in range(h)))
`], { input: shot }).toString().trim().split(/\s+/).map(Number);
  const first = rows.findIndex(v => v > 0);
  return { n: rows.length, first, last: rows.length - 1 - [...rows].reverse().findIndex(v => v > 0) };
};
// Descenders on purpose — "cc-bridge" alone would clear a box its 'g' does not.
await p.evaluate(() => { document.getElementById("dname").textContent = "cc-bridge gjpqy"; });
await p.waitForTimeout(120);
const ink = await inkRows();
check(ink.first > 0 && ink.last < ink.n - 1,
  `name ink clears its line box, unclipped (rows ${ink.first}..${ink.last} of ${ink.n})`);
await p.evaluate(() => { document.getElementById("dname").style.fontSize = "22px"; });
await p.waitForTimeout(120);
const over = await inkRows();
check(over.first === 0 && over.last === over.n - 1,
  `control: 22px type DOES hit both edges (rows ${over.first}..${over.last} of ${over.n})`);
await p.evaluate(() => { const n = document.getElementById("dname"); n.style.fontSize = ""; n.textContent = "cc-bridge"; });
await p.waitForTimeout(120);

// 3. Width — the capsule is 20% narrower than the span between the circles.
const span = m.headW - m.back.w - m.stop.w - 2 * m.gap;
check(near(m.cap.w, span * 0.8, 1), `capsule 80% of its span (${m.cap.w.toFixed(1)} vs ${(span * 0.8).toFixed(1)}, span ${span.toFixed(1)})`);
check(near(m.back.left, m.head.left) && near(m.stop.right, m.head.right), "circles still pinned to the row's ends");
check(near(m.cap.left - m.back.right, m.stop.left - m.cap.right, 1), "capsule centred in the row");

// 4. Translucency + float — the transcript really passes behind the chips.
const alpha = s => { const n = s.match(/[\d.]+/g); return n && n.length === 4 ? parseFloat(n[3]) : 1; };
check(alpha(m.capBg) < 1 && alpha(m.backBg) < 1, `chips translucent (capsule ${m.capBg})`);
check(m.headPos === "absolute", `header out of flow (position: ${m.headPos})`);
check(m.feed.top < m.head.top, `feed's box starts ABOVE the header (feed ${m.feed.top}, header ${m.head.top})`);
check(m.feedPadTop >= m.head.bottom - m.feed.top, `feed's top padding clears the header (${m.feedPadTop} >= ${(m.head.bottom - m.feed.top).toFixed(1)})`);
// Read at the TOP of the transcript — the feed opens pinned to the bottom, where "the first message"
// is 1700px above the viewport and the check passes for the wrong reason (or fails for one).
const atTop = await p.evaluate(async () => {
  const f = document.getElementById("dfeed");
  f.scrollTop = 0;
  await new Promise(r => requestAnimationFrame(r));
  const h = document.querySelector("#drill .vhead").getBoundingClientRect();
  const first = f.querySelector(".msg").getBoundingClientRect();
  return { firstTop: first.top, headBottom: h.bottom, scrollTop: f.scrollTop };
});
check(atTop.scrollTop === 0 && atTop.firstTop >= atTop.headBottom - 0.5,
  `at scroll top, the first message opens BELOW the header (${atTop.firstTop} vs ${atTop.headBottom})`);

// …and with the feed scrolled, a message is actually under the chips.
check(m.scrollable > 100, `fixture overflows the scroller (${m.scrollable}px of scroll) — else the next check cannot fail`);
await p.evaluate(() => { document.getElementById("dfeed").scrollTop = 200; });
await p.waitForTimeout(400);
// HIT-TEST, not rect maths: a message clipped by the scroller still REPORTS a rect that overlaps the
// header band, so a rect-overlap check passes on the old in-flow layout too — it cannot fail. What
// distinguishes the two layouts is what is painted at a point inside the band: the transcript under
// the chips here, the page's own --bg there.
const behind = await p.evaluate(() => {
  const h = document.querySelector("#drill .vhead").getBoundingClientRect();
  const cap = document.querySelector("#drill .dtitle").getBoundingClientRect();
  const y = h.y + h.height / 2;
  const at = x => document.elementsFromPoint(x, y).map(e => e.id || e.className || e.tagName);
  const under = el => el.closest && el.closest("#dfeed .msg");
  const hit = x => document.elementsFromPoint(x, y).some(under);
  return {
    // Through the CHIP (the transcript has to be in the stack behind it) and through the GAP
    // between the back circle and the capsule (where it should be directly visible).
    throughChip: hit(cap.x + cap.width / 2),
    throughGap: hit((h.x + 44 + cap.x) / 2),
    stack: at(cap.x + cap.width / 2),
  };
});
check(behind.throughChip, `transcript is behind the capsule while scrolled (stack: ${behind.stack.slice(0, 4).join(" < ")})`);
check(behind.throughGap, "transcript is visible through the gap between the chips");

// 5. Centring — on the dot+name GROUP, not on the name alone.
const groupMid = (m.dot.left + m.name.right) / 2;
const capMid = m.cap.left + m.cap.w / 2;
check(near(groupMid, capMid, 1), `dot+name group centred on the capsule (group ${groupMid.toFixed(1)}, capsule ${capMid.toFixed(1)})`);
check(m.dot.right <= m.name.left, "dot leads the name");
check(m.name.left + m.name.w / 2 > capMid, "the NAME alone now sits right of centre — the traded-away axis, stated so a regression reads as a revert");

// 6. Glyph parity — the half-pixel snap the padding exists to prevent.
// BOTH axes, since the button stopped being square: an odd difference on either one lands the glyph
// half a pixel off, which is what --hbtn-w's even step exists to prevent.
check(m.backPad.split(" ").every(v => /^\d+px$/.test(v)), `button padding is a whole pixel on both axes (${m.backPad})`);

await p.screenshot({ path: join(OUT, "header.png") });
await p.evaluate(() => { document.getElementById("dfeed").scrollTop = 0; });
await p.waitForTimeout(300);
await p.screenshot({ path: join(OUT, "header-top.png") });
await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
