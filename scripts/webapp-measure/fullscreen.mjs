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
    const t = s => { const e = document.querySelector(s); return e ? +e.getBoundingClientRect().top.toFixed(2) : null; };
    return {
      var: getComputedStyle(document.documentElement).getPropertyValue("--safe-top").trim(),
      tabbox: t(".tabs"), tabglyph: t(".tabs button"),
      drillhead: t("#drill .vhead"), viewerhead: t("#viewer .vhead"),
      sheet: t("#spawn .sheet"), tallsheet: t(".callsheet"),
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
// CONTROL: fullscreen, offset stomped back to 0. Must land exactly on the baseline row.
await run("CONTROL forced-0", async p => {
  await drive(p, [...INSETS, FS_ON]);
  await p.evaluate(() => document.documentElement.style.setProperty("--safe-top", "0px"));
});

const cols = ["var", "tabbox", "tabglyph", "drillhead", "viewerhead", "sheet", "tallsheet"];
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
for (const k of ["tabglyph", "drillhead", "viewerhead"])
  chk(fs[k] - base[k] === NOTCH + CHROME, `${k} moved down by exactly the offset (${(fs[k] - base[k]).toFixed(2)}px)`);
chk(fs.tallsheet > NOTCH + CHROME && fs.sheet > NOTCH + CHROME,
  `both sheets start below the chrome unaided (tallest at ${fs.tallsheet}px vs ${NOTCH + CHROME}px of chrome)`);
await b.close();
