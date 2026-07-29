// The soft keyboard: the chat gives up the strip it takes, and the transcript rides to the bottom.
//
//   node keyboard.mjs [pagePath] [outdir]
//
// What is actually being measured, and what a device still has to answer:
//   · The keyboard is SIMULATED — a fake `visualViewport` installed before the page's own script
//     runs, whose height this harness drives. That is exactly the signal the page listens to, so the
//     wiring, the geometry and the scroll are real; what a headless run cannot produce is a keyboard.
//     Whether Telegram's Android webview reports the rise through `visualViewport` at all (rather
//     than only through the SDK's `viewportChanged`, or by shrinking the layout viewport itself) is
//     the one leg that needs a thumb on a real device.
//   · A page that already shrank for the keyboard needs nothing: the fake reports the height, and
//     window.innerHeight is the layout viewport, so their difference IS the uncovered strip. Both
//     cases are checked below.
//
// CONTROL: pass a pre-change page (`git show HEAD:webapp/index.html > /tmp/old.html`). The chat kept
// its full height under the keyboard and never re-pinned, so 10 of the 15 fail there — the surface,
// the composer clearance and every scroll check on their own merits, and the --kb readings because
// that page has no such variable. The header and the composer's own height pass on both: this change
// was never meant to move them.
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const PAGE = process.argv[2] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";
const OUT = process.argv[3] || "keyboard-shots";
const H = 812, KB = 320;
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: H }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
// Before the page's script: it reads window.visualViewport once, at handler-registration time.
await p.addInitScript(([h]) => {
  const ls = {};
  const fake = { width: 390, height: h, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0,
    addEventListener: (t, f) => (ls[t] = ls[t] || []).push(f),
    removeEventListener: (t, f) => { ls[t] = (ls[t] || []).filter(x => x !== f); },
    dispatchEvent: e => { (ls[e.type] || []).forEach(f => f(e)); return true; } };
  Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
  window.__kb = px => { fake.height = h - px; fake.dispatchEvent(new Event("resize")); };
}, [H]);
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(300);
await p.evaluate(() => {
  window.api = async path => path.includes("feed")
    ? { working: false, items: Array.from({ length: 40 }, (_, i) => ({ text: "message " + (i + 1), at: Date.now() - i * 1000, role: i % 2 ? "user" : "assistant" })) }
    : {};
  openDrill("fake-sid", "fake");
});
await p.waitForTimeout(500);

const snap = () => p.evaluate(() => {
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { y: +b.y.toFixed(2), h: +b.height.toFixed(2), bottom: +b.bottom.toFixed(2) }; };
  const feed = document.getElementById("dfeed");
  const last = feed.lastElementChild;
  return {
    kb: getComputedStyle(document.documentElement).getPropertyValue("--kb").trim(),
    drill: r(document.getElementById("drill")), dock: r(document.getElementById("ddock")),
    pill: r(document.querySelector(".inputwrap")), head: r(document.querySelector("#drill .vhead")),
    feed: r(feed), scrollTop: Math.round(feed.scrollTop), maxScroll: Math.round(feed.scrollHeight - feed.clientHeight),
    atBottom: Math.abs(feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 2,
    lastMsgBottom: last ? +last.getBoundingClientRect().bottom.toFixed(2) : null,
  };
});
const scrollMiddle = () => p.evaluate(() => { const f = document.getElementById("dfeed"); f.scrollTop = Math.round(f.scrollHeight / 2); });
const keyboard = px => p.evaluate(v => window.__kb(v), px);
const shoot = n => p.screenshot({ path: `${OUT}/${n}.png` });

const checks = [];
const ok = (label, pass, detail) => checks.push({ label, pass, detail });
const near = (a, b, tol = 1.01) => a != null && b != null && Math.abs(a - b) <= tol;

await scrollMiddle();
await p.waitForTimeout(100);
const before = await snap();
await shoot("1-no-keyboard-midthread");

// --- the keyboard rises -----------------------------------------------------------------------
await keyboard(KB);
await p.waitForTimeout(200);
const up = await snap();
await shoot("2-keyboard-up");

ok("FIXTURE: the thread really was mid-scroll", before.scrollTop > 20 && !before.atBottom, `${before.scrollTop}/${before.maxScroll}`);
ok("the chat gives up the keyboard's strip", up.kb === KB + "px" && near(up.drill.bottom, H - KB), `--kb=${up.kb} drill bottom=${up.drill.bottom}`);
ok("…so the composer sits ABOVE the keyboard", near(up.dock.bottom, H - KB), `${up.dock.bottom} vs ${H - KB}`);
ok("the thread is pinned to the BOTTOM", up.atBottom, `${up.scrollTop}/${up.maxScroll}`);
ok("…with the newest message clear of the composer", up.lastMsgBottom <= up.dock.y + 0.5, `${up.lastMsgBottom} vs ${up.dock.y}`);
ok("nothing else moved: the header holds", near(up.head.y, before.head.y) && near(up.head.h, before.head.h), `${up.head.y} vs ${before.head.y}`);
ok("nothing else moved: the composer keeps its own height", near(up.pill.h, before.pill.h), `${up.pill.h} vs ${before.pill.h}`);
ok("nothing else moved: the feed is the surface minus the keyboard", near(up.feed.h, before.feed.h - KB), `${up.feed.h} vs ${before.feed.h - KB}`);

// --- and falls again --------------------------------------------------------------------------
await keyboard(0);
await p.waitForTimeout(200);
const down = await snap();
await shoot("3-keyboard-down");
ok("dismissing it hands the strip back", down.kb === "0px" && near(down.drill.bottom, H), `--kb=${down.kb} drill bottom=${down.drill.bottom}`);
ok("…and does not yank the reader anywhere", down.atBottom, `${down.scrollTop}/${down.maxScroll}`);

// --- focus alone, with no viewport change at all -----------------------------------------------
await scrollMiddle();
await p.waitForTimeout(100);
const mid = await snap();
await p.locator("#dtext").focus();
await p.waitForTimeout(200);
const focused = await snap();
await shoot("4-focus-only");
ok("FIXTURE: mid-thread again before the tap", !mid.atBottom, `${mid.scrollTop}/${mid.maxScroll}`);
ok("a composer tap alone pins it to the bottom", focused.atBottom, `${focused.scrollTop}/${focused.maxScroll}`);
ok("…and the viewport was untouched while it did", focused.kb === "0px" && near(focused.drill.bottom, H), `--kb=${focused.kb}`);

// --- the client that shrank the layout viewport itself ------------------------------------------
// Android's resize mode and Telegram resizing its own sheet both land here: the fake reports the
// same height the layout viewport has, so the difference is 0 and this page must not subtract twice.
await p.evaluate(h => { window.visualViewport.height = h; }, H - KB);
await p.setViewportSize({ width: 390, height: H - KB });
await p.waitForTimeout(300);
const resized = await snap();
await shoot("5-layout-viewport-shrank");
ok("a client that shrank the viewport itself gets NO second subtraction", resized.kb === "0px", `--kb=${resized.kb}`);
ok("…and the chat still ends at the new floor", near(resized.drill.bottom, H - KB), `${resized.drill.bottom} vs ${H - KB}`);

console.log(`page: ${PAGE}`);
console.log(` no keyboard  scroll=${before.scrollTop}/${before.maxScroll}  drill bottom=${before.drill.bottom}`);
console.log(` keyboard up  scroll=${up.scrollTop}/${up.maxScroll}  drill bottom=${up.drill.bottom}  --kb=${up.kb}`);
console.log();
let bad = 0;
for (const c of checks) { if (!c.pass) bad++; console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label.padEnd(58)} ${c.detail}`); }
console.log(`\n${checks.length - bad}/${checks.length} pass  ·  shots in ${OUT}/`);
console.log("NOT VERIFIABLE HERE: a real soft keyboard in Telegram's webview — which signal it fires,");
console.log("and whether its rise lands as a visualViewport resize at all. One focus-tap on device.");
await b.close();
process.exit(bad ? 1 : 0);
