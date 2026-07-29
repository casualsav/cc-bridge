// The soft keyboard: the chat gives up the strip it takes, and a transcript that was AT THE FLOOR
// rides with the composer — while one that is mid-thread is not moved, in either direction.
//
//   node keyboard.mjs [pagePath] [outdir]
//
// The spec is conditional (the owner's correction to the always-pin that shipped in v0.4.233), so
// the matrix is what this measures: {resting at the bottom, mid-thread} × {keyboard rises, falls} ×
// {the client shrank only the VISUAL viewport, the client shrank the LAYOUT viewport too}.
//
// That last axis is the device bug, not a hypothetical, and the LAYOUT half is the one his phone
// actually takes — measured 2026-07-29 through a temporary in-page beacon: Telegram's Android webview
// shrinks the layout viewport itself (innerHeight 820 → 466), visualViewport tracks it exactly, so
// `--kb` stays 0 in every event and the page's own compensation never engages. v0.4.233 hung the pin
// off --kb CHANGING, so the composer rose and the transcript did not. Every case runs in BOTH modes
// for that reason: a fix that only works where the page does the lifting is the bug.
//
// The keyboard is SIMULATED — a fake `visualViewport` installed before the page's own script, which
// is the exact signal the page listens to, plus (in layout mode) a real viewport resize. The device
// leg is CLOSED for the current build (owner, 2026-07-29: "working perfectly now"); what a headless
// run still cannot produce is a keyboard, so a future client that reports differently would show up
// on a phone before it showed up here. The beacon that answered it is gone — the last check in this
// file is what says so.
//
// CONTROL: pass a pre-change page (`git show HEAD:webapp/index.html > /tmp/old.html`).
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";

const PAGE = process.argv[2] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";
const OUT = process.argv[3] || "keyboard-shots";
// 354px is HIS keyboard, measured off the device beacon on 2026-07-29 (innerHeight 820 → 466), not a
// round number picked here. 812 stays the viewport because that is what every other script in this
// directory renders at.
const H = 812, KB = 354;
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const requested = [];
const checks = [];
const ok = (label, pass, detail) => checks.push({ label, pass, detail });
const near = (a, b, tol = 1.01) => a != null && b != null && Math.abs(a - b) <= tol;

const open = async () => {
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
    window.__vvHeight = px => { fake.height = px; fake.dispatchEvent(new Event("resize")); };
  }, [H]);
  // Every request the page makes, so the temporary debug beacon that diagnosed the device bug can be
  // proven GONE rather than assumed gone (it posted to /api/kbdebug on exactly these events).
  p.on("request", r => requested.push(r.url()));
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    window.api = async path => path.includes("feed")
      ? { working: false, items: Array.from({ length: 40 }, (_, i) => ({ text: "message " + (i + 1), at: Date.now() - i * 1000, role: i % 2 ? "user" : "assistant" })) }
      : {};
    openDrill("fake-sid", "fake");
  });
  await p.waitForTimeout(500);
  return p;
};

const snap = p => p.evaluate(() => {
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { y: +b.y.toFixed(2), h: +b.height.toFixed(2), bottom: +b.bottom.toFixed(2) }; };
  const feed = document.getElementById("dfeed");
  const last = feed.lastElementChild;
  return {
    kb: getComputedStyle(document.documentElement).getPropertyValue("--kb").trim(),
    drill: r(document.getElementById("drill")), dock: r(document.getElementById("ddock")),
    pill: r(document.querySelector(".inputwrap")), head: r(document.querySelector("#drill .vhead")),
    feed: r(feed), scrollTop: Math.round(feed.scrollTop), maxScroll: Math.round(feed.scrollHeight - feed.clientHeight),
    atBottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight < 2,
    lastMsgBottom: last ? +last.getBoundingClientRect().bottom.toFixed(2) : null,
  };
});
// Where the reader is parked before anything happens. A real scroll, then a beat, so the page's own
// scroll listener records the position exactly as a thumb would leave it.
const park = async (p, where) => {
  await p.evaluate(w => { const f = document.getElementById("dfeed"); f.scrollTop = w === "bottom" ? f.scrollHeight : Math.round(f.scrollHeight / 2); }, where);
  await p.waitForTimeout(150);
};
// VISUAL: only the visual viewport shrinks (an iOS-shaped client) — the page has to do the lifting.
// LAYOUT: the client shrank its own window too (Android resize mode, Telegram resizing its sheet) —
// --kb stays 0 and the surface moves by itself. Both must re-pin.
const raise = async (p, mode, px) => {
  await p.evaluate(h => window.__vvHeight(h), H - px);
  if (mode === "layout") await p.setViewportSize({ width: 390, height: H - px });
  await p.waitForTimeout(250);
};

for (const mode of ["visual", "layout"]) {
  for (const where of ["bottom", "mid"]) {
    const p = await open();
    await park(p, where);
    const before = await snap(p);
    await raise(p, mode, KB);
    const up = await snap(p);
    if (where === "mid") await p.screenshot({ path: `${OUT}/${mode}-${where}-up.png` });
    await raise(p, mode, 0);
    const down = await snap(p);
    const tag = `${mode}/${where}`;

    // the lift itself, in whichever way this client provides it
    ok(`${tag}: FIXTURE parked ${where === "bottom" ? "at the floor" : "mid-thread"}`,
      where === "bottom" ? before.atBottom : (!before.atBottom && before.scrollTop > 20), `${before.scrollTop}/${before.maxScroll}`);
    ok(`${tag}: the composer clears the keyboard`, near(up.dock.bottom, H - KB), `${up.dock.bottom} vs ${H - KB}`);
    ok(`${tag}: --kb is ${mode === "visual" ? KB : 0} — the page compensates only where it must`,
      up.kb === (mode === "visual" ? KB + "px" : "0px"), `${up.kb}`);
    ok(`${tag}: the feed lost exactly the keyboard's height`, near(up.feed.h, before.feed.h - KB), `${up.feed.h} vs ${before.feed.h - KB}`);
    ok(`${tag}: the header never moves`, near(up.head.y, before.head.y) && near(up.head.h, before.head.h), `${up.head.y}`);
    ok(`${tag}: the composer keeps its own height`, near(up.pill.h, before.pill.h), `${up.pill.h} vs ${before.pill.h}`);

    // the conditional spec, both directions
    if (where === "bottom") {
      ok(`${tag}: RISE — it rides with the composer, still at the floor`, up.atBottom, `${up.scrollTop}/${up.maxScroll}`);
      ok(`${tag}: …newest message clear of the composer`, up.lastMsgBottom <= up.dock.y + 0.5, `${up.lastMsgBottom} vs ${up.dock.y}`);
      ok(`${tag}: FALL — still at the floor`, down.atBottom, `${down.scrollTop}/${down.maxScroll}`);
    } else {
      ok(`${tag}: RISE — a mid-thread reader is not moved`, up.scrollTop === before.scrollTop, `${before.scrollTop} → ${up.scrollTop}`);
      ok(`${tag}: FALL — still not moved`, down.scrollTop === before.scrollTop, `${before.scrollTop} → ${down.scrollTop}`);
      ok(`${tag}: …and it never silently ends up at the floor`, !up.atBottom && !down.atBottom, `up=${up.atBottom} down=${down.atBottom}`);
    }
    await p.close();
  }
}

// --- the focus tap on its own, with no viewport change at all -----------------------------------
for (const where of ["bottom", "mid"]) {
  const p = await open();
  await park(p, where);
  const before = await snap(p);
  await p.locator("#dtext").focus();
  await p.waitForTimeout(200);
  const after = await snap(p);
  await p.screenshot({ path: `${OUT}/focus-${where}.png` });
  ok(`focus/${where}: the viewport was untouched`, after.kb === "0px" && near(after.drill.bottom, H), `${after.kb}`);
  ok(`focus/${where}: ${where === "bottom" ? "stays at the floor" : "a mid-thread reader keeps their place"}`,
    where === "bottom" ? after.atBottom : after.scrollTop === before.scrollTop, `${before.scrollTop} → ${after.scrollTop}`);
  await p.close();
}

ok("the page makes no debug traffic — the beacon is gone, not disabled",
  !requested.some(u => u.includes("kbdebug")), `${requested.filter(u => u.includes("kbdebug")).length} of ${requested.length} requests`);

let bad = 0;
for (const c of checks) { if (!c.pass) bad++; console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label.padEnd(66)} ${c.detail}`); }
console.log(`\n${checks.length - bad}/${checks.length} pass  ·  shots in ${OUT}/`);
console.log("DEVICE LEG CLOSED 2026-07-29 (owner: \"working perfectly now\"). What his Android Telegram");
console.log("webview delivers — layout-viewport shrink, --kb 0 throughout, all three signals firing — is");
console.log("recorded in webapp/CLAUDE.md; a headless run still cannot produce a real keyboard.");
await b.close();
process.exit(bad ? 1 : 0);
