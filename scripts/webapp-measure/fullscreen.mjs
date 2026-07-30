import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The fullscreen top offset (--safe-top). In Telegram's fullscreen mode the client paints its own
// chrome — the ✕ Close pill top-left, the chevron/kebab top-right — OVER the page, so every
// top-anchored surface has to start below it.
//
// This drives the REAL telegram-web-app.js (the page loads it from telegram.org, so this needs
// network) through `Telegram.WebView.receiveEvent`, which is the same entry point the native client
// posts through. So the SDK's own state, its event names and our listeners are all under test — a
// hand-written stub of window.Telegram would have been clobbered by the real script anyway, and
// would have proved only that our arithmetic runs.
//
// Per README rule 1 the instrument is checked against known-truth controls before any number is
// believed: forcing the var back to 0px while fullscreen must reproduce the OLD, colliding geometry.
// If the control and the fullscreen run agree, the harness is measuring nothing.

const URL = "file:///home/ubuntu/projects/cc-bridge/webapp/index.html";
const NOTCH = 47, CHROME = 46;   // an iPhone-shaped client: device inset + Telegram's own chrome
const FLOOR = 56;                // what a pre-Bot-API-8.0 client (reports no insets) must fall back to

async function open(b) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  await p.goto(URL, { waitUntil: "domcontentloaded" });
  await p.evaluate(() => {                       // enough data for the drill-in to render content
    const S = { sid: "abc", name: "cc-bridge", alive: true, cwd: "~/p", model: "Opus 5", effort: "high" };
    window.api = async path => path.includes("session/feed")
      ? { sid: "abc", name: "cc-bridge", items: [{ role: "user", text: "hi", ts: 1785200000000 }] }
      : path.includes("sessions") ? { sessions: [S] } : {};
  });
  await p.waitForTimeout(600);                   // README rule 2: idle before reading
  return p;
}

const drive = (p, evs) => p.evaluate(evs => {
  const R = window.Telegram.WebView.receiveEvent.bind(window.Telegram.WebView);
  for (const [name, data] of evs) R(name, data);
}, evs);

// Where each top-anchored surface's first PAINTED pixel lands. `.tabs` paints its own strip, so its
// box top stays 0 and the glyph row is what moves; the two fixed views pad transparently, so their
// header row is the thing to read.
async function tops(p) {
  await p.evaluate(() => {
    openDrill("abc", "cc-bridge");
    document.getElementById("viewer").classList.add("show");
    document.getElementById("spawn").classList.add("show");
    // The sheets are the OTHER kind of overlay: bottom-anchored (align-items: flex-end), so they
    // grow upward from the bottom edge and get no --safe-top of their own. That is a claim about
    // pixels, so it is measured rather than asserted — #calls is the tallest of them by
    // construction (a fixed 72vh; the others are content-sized and shorter).
    document.getElementById("calls").classList.add("show", "up");
  });
  await p.waitForTimeout(400);
  return p.evaluate(() => {
    // `null` for a box that is not laid out AT ALL — which the tab bar is not since v0.4.265 hid the
    // row behind SHOW_TABS. A hidden box reports top 0 in every state, so "it moved by the offset"
    // becomes 0 - 0 and fails against a page that is correct. Skipped loudly below, never silently.
    const t = s => { const e = document.querySelector(s); return e && e.getClientRects().length ? +e.getBoundingClientRect().top.toFixed(2) : null; };
    return {
      var: getComputedStyle(document.documentElement).getPropertyValue("--safe-top").trim(),
      tabbox: t(".tabs"), tabglyph: t(".tabs button"),
      drillhead: t("#drill .vhead"), viewerhead: t("#viewer .vhead"),
      sheet: t("#spawn .sheet"), tallsheet: t(".callsheet"),
      // The chat header's own pill. It is translucent now, and that must be a PAINT change only —
      // its box has to sit exactly where the offset puts it, at every fullscreen state.
      pill: t(".dtitle"), pillh: (() => { const e = document.querySelector(".dtitle");
        return e ? +e.getBoundingClientRect().height.toFixed(2) : null })(),
      pillbg: (() => { const e = document.querySelector(".dtitle");
        return e ? getComputedStyle(e).backgroundColor : null })(),
    };
  });
}

const FS_ON = ["fullscreen_changed", { is_fullscreen: true }];
const INSETS = [["safe_area_changed", { top: NOTCH, bottom: 34, left: 0, right: 0 }],
                ["content_safe_area_changed", { top: CHROME, bottom: 0, left: 0, right: 0 }]];

const b = await chromium.launch();
const rows = [];
const run = async (label, steps) => {
  const p = await open(b);
  if (steps) await steps(p);
  await p.waitForTimeout(200);
  rows.push([label, await tops(p)]);
  await p.close();
};

await run("baseline (no events)", null);
// The gate is isFullscreen, not the insets: a client reporting a notch while NOT fullscreen is
// already laid out below its own chrome, so this row must be identical to the baseline.
await run("insets, NOT fullscreen", p => drive(p, INSETS));
await run("FULLSCREEN 47+46", p => drive(p, [...INSETS, FS_ON]));
await run("FULLSCREEN old client", p => drive(p, [FS_ON]));           // no insets -> the floor
await run("fullscreen then exit", p => drive(p, [...INSETS, FS_ON, ["fullscreen_changed", { is_fullscreen: false }]]));
// CONTROL: fullscreen, then every trace of it stomped back to zero. Must land exactly on the
// baseline row — that is what says this harness can see the offset at all rather than printing the
// same numbers whatever it drives.
// It stomps the CLASS as well as the vars, and that is not belt-and-braces: the chat header's
// fullscreen position is gated on `html.fs` now, so a control that only zeroed --safe-top left the
// header riding in a chrome band whose insets it had just erased, and failed while the page was
// behaving correctly. A control has to undo the gate the app actually uses.
await run("CONTROL forced-0", async p => {
  await drive(p, [...INSETS, FS_ON]);
  // Leave fullscreen the way the CLIENT does, then stomp the vars on top. Reaching in to remove the
  // class by hand is not equivalent and cannot be: fullscreen also MOVES the pause button into the
  // capsule, and only the app's own handler moves it back — a hand-stomped control left it stacked
  // inside a flex column, made the capsule taller, and failed against a page that was correct.
  await drive(p, [["fullscreen_changed", { is_fullscreen: false }]]);
  await p.evaluate(() => {
    const r = document.documentElement;
    for (const v of ["--safe-top", "--chrome-top", "--chrome-h"]) r.style.setProperty(v, "0px");
  });
});

const cols = ["var", "tabbox", "tabglyph", "drillhead", "viewerhead", "sheet", "tallsheet", "pill", "pillh"];
console.log("state".padEnd(24) + cols.map(c => c.padStart(11)).join(""));
for (const [l, r] of rows) console.log(l.padEnd(24) + cols.map(c => String(r[c]).padStart(11)).join(""));

const [base, notFs, fs, old, exited, ctrl] = rows.map(r => r[1]);
const same = (a, c) => cols.every(k => String(a[k]) === String(c[k]));
const chk = (ok, msg) => console.log(ok ? "  OK   " : "  FAIL ", msg);
console.log("");
chk(same(base, ctrl), "CONTROL forced-0 reproduces the baseline — the harness can see the offset");
chk(same(base, notFs), "insets while NOT fullscreen change nothing");
chk(same(base, exited), "leaving fullscreen returns every surface to the baseline");
chk(fs.var === NOTCH + CHROME + "px", `fullscreen offset is ${NOTCH}+${CHROME}px (got ${fs.var})`);
chk(old.var === FLOOR + "px", `a client reporting no insets gets the ${FLOOR}px floor (got ${old.var})`);
// The CHAT header is no longer in this list, and that is a design change rather than a regression:
// in fullscreen it rides UP INTO the client's chrome band instead of clearing it, which is what buys
// the transcript that row back. It is checked below against the band's centre, and headerup.mjs
// covers the rest. The file viewer and the tab bar still clear the chrome in the old way.
for (const k of ["tabglyph", "viewerhead"]) {
  if (base[k] === null) { console.log("  SKIP  ", `${k} is not laid out on this build — the tab row is hidden behind SHOW_TABS (notabs.mjs owns it)`); continue }
  chk(fs[k] - base[k] === NOTCH + CHROME, `${k} moved down by exactly the offset (${(fs[k] - base[k]).toFixed(2)}px)`);
}
// …and where the chat header goes instead: centred in the band the client paints its own buttons on.
const bandMid = NOTCH + CHROME / 2;
chk(Math.abs((fs.drillhead + base.pillh / 2) - bandMid) <= 1.5,
  `the chat header rides INSIDE the chrome band, centred on it (${(fs.drillhead + base.pillh / 2).toFixed(2)} vs ${bandMid})`);
// A client that reports no insets at all: the floor becomes the whole band, and the header centres in
// THAT — which lands it exactly where it sits outside fullscreen, so the move reads as zero.
chk(Math.abs(old.drillhead - (FLOOR - base.pillh) / 2) <= 1.5,
  `with no insets it centres in the ${FLOOR}px floor instead (top ${old.drillhead.toFixed(2)})`);
chk(fs.pill === fs.drillhead && old.pill === old.drillhead, "the pill rides the header in every state");
chk(rows.every(([, r]) => r.pillh === base.pillh), `the pill's height is identical at every state (${base.pillh}px)`);
// Translucent, and the SAME at every state. Deliberately not a literal alpha any more — that read
// `0.82` and had to be edited the day the chips were matched to Telegram's chrome, which is a check
// tracking a value rather than an invariant. What matters is that it is see-through and that
// fullscreen does not change how it paints.
const alphaOf = c => { const n = String(c).match(/[\d.]+/g); return n && n.length === 4 ? parseFloat(n[3]) : 1; };
chk(alphaOf(base.pillbg) < 1 && rows.every(([, r]) => r.pillbg === base.pillbg),
  `the pill is translucent, and equally so at every state (alpha ${alphaOf(base.pillbg)})`);
chk(fs.tallsheet > NOTCH + CHROME && fs.sheet > NOTCH + CHROME,
  `both sheets start below the chrome unaided (tallest at ${fs.tallsheet}px vs ${NOTCH + CHROME}px of chrome)`);
await b.close();
