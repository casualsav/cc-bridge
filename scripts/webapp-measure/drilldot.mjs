import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The drill-in header dot, which used to know only working-or-not. A card could read amber and the
// screen it opened onto rendered grey — one session, two answers, on two taps. This measures that the
// header now paints the card's three colours off `SessionFeed.state`.
//
// Same stance as waitstate.mjs, which measures the CARD's dots, and for the same reasons:
//
//   COLOUR is sampled from the RENDER. A declared colour that resolves to the ground passes every
//   computed-style assertion and is invisible on the device.
//
//   STILLNESS is asserted, not assumed: the working dot animates and the waiting one must not — the
//   pulse is what says "moving", so colour alone would leave a paused session looking like a working
//   one caught mid-fade.
//
//   The FALLBACK is a guard, not a state check: a payload with no `state` (an older daemon, or the
//   pre-transcript one) must degrade to the working boolean it always read, never to grey.
//
// The CONTROL is the page pinned at the commit before this change. State checks MUST fail there —
// that is what makes them checks — and guards must pass, since this change is meant to leave the
// working and idle headers exactly as they were.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// PINNED, never HEAD: a HEAD-relative control is a control only until the work is committed, and then
// it silently becomes a copy of the page under test (waitstate.mjs records that happening within the
// hour). e2cc72f is the last commit whose header dot read the working boolean alone.
const BASELINE = process.env.DRILLDOT_BASELINE || "e2cc72f";
const BASE = join(mkdtempSync(join(tmpdir(), "drilldot-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

// One feed per state. `items` is the same in all of them: this is about the header, and a transcript
// that differed per state would let a colour difference be a difference in what is on screen instead.
const ITEMS = [
  { role: "user", text: "start the run and tell me when it lands", ts: 1785200000000 },
  { role: "assistant", text: "Started it — I'll report when the run finishes.", ts: 1785200001000 },
];
const feed = (over) => ({
  sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
  working: false, items: ITEMS, ...over,
});
const FEEDS = {
  working: feed({ working: true, state: "working" }),
  waiting: feed({ state: "waiting" }),
  idle: feed({ state: "idle" }),
  // No `state` at all — the payload an older daemon serves, and the one built before a transcript is
  // found. The dot must fall back to what it always did rather than to grey.
  legacyWorking: feed({ working: true }),
};

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// openDrill through the page's own function, as thoughts.mjs does: boot() is gated on Telegram init
// data and never runs from file://, so assembling the header by hand would measure a screen the app
// never builds.
const open = async (path, f) => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(fx => {
    window.api = async u => u.includes("feed") ? fx : { sessions: [] };
    openDrill(fx.sid, fx.name);
  }, f);
  await p.waitForTimeout(700);
  return p;
};

// The header dot's ink, read at its centre. Two device pixels — the read is ink, not edge.
const ink = async page => {
  const at = await page.evaluate(() => {
    const d = document.getElementById("ddot");
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!at) return [-1, -1, -1];
  const shot = await page.screenshot({ clip: { x: at.x - 1, y: at.y - 1, width: 2, height: 2 } });
  return page.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, shot.toString("base64"));
};

const dotOf = async page => page.evaluate(() => {
  const d = document.getElementById("ddot");
  const r = d.getBoundingClientRect();
  return { cls: d.className, anim: getComputedStyle(d).animationName, w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
});

async function measure(path, label, sink) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);

  const pages = {};
  const dots = {};
  const px = {};
  for (const [k, f] of Object.entries(FEEDS)) {
    pages[k] = await open(path, f);
    dots[k] = await dotOf(pages[k]);
    px[k] = await ink(pages[k]);
  }

  // ---- 1. The state the header never had -------------------------------------------------------
  // Stillness is bound to the CLASS, never to `animationName` alone — the baseline's grey dot is
  // unanimated too, so "does not animate" on its own passes on the page that has no waiting state at
  // all. It cost this script a vacuous check on its first run, which is what the control is for.
  state(/\bwait\b/.test(dots.waiting.cls) && dots.waiting.anim === "none",
    `a waiting header dot is its own state and does NOT animate — stillness is what tells it from working (${dots.waiting.cls} / ${dots.waiting.anim})`);
  state(Math.max(...px.waiting.map((v, i) => Math.abs(v - [224, 163, 62][i]))) <= 6,
    `and paints amber — ${px.waiting} vs 224,163,62`);
  // 0/255 without the feature: this is the whole complaint ("an amber card opens onto a grey dot").
  const far = (a, c) => Math.max(...a.map((v, i) => Math.abs(v - c[i])));
  state(far(px.waiting, px.idle) >= 40,
    `waiting and idle are TOLD APART on the screen — ${far(px.waiting, px.idle)}/255 (${px.waiting} vs ${px.idle})`);

  // ---- 2. What the change must not have touched ------------------------------------------------
  guard(/\bon\b/.test(dots.working.cls) && dots.working.anim !== "none",
    `a working header dot still pulses (${dots.working.cls} / ${dots.working.anim})`);
  guard(far(px.working, px.idle) >= 40, `working and idle stay far apart — ${far(px.working, px.idle)}/255`);
  guard(dots.idle.cls.trim() === "dot" && dots.idle.anim === "none", `an idle header dot stays bare grey (${dots.idle.cls})`);
  // The fallback: no `state` in the payload and the dot reads the boolean, exactly as it always did.
  guard(/\bon\b/.test(dots.legacyWorking.cls),
    `a payload with no state falls back to the working boolean (${dots.legacyWorking.cls})`);
  // The header's dot is the 9px one; `.sess .dot` is 11px and the title centres on the dot+name
  // group, so a size that drifted here would walk the name off the axis the header was measured onto.
  guard(dots.waiting.w === 9 && dots.waiting.h === 9, `and it is still the header's 9px disc (${dots.waiting.w}×${dots.waiting.h})`);

  if (OUT && label === "page") await pages.waiting.screenshot({ path: join(OUT, "drilldot-waiting.png") });
  for (const p of Object.values(pages)) await p.close();
}

await measure(PAGE, "page", (_k, ok, l) => check(ok, l));

const control = [];
await measure(BASE, "control(baseline)", (kind, ok, l) => { control.push({ kind, ok, l }); console.log(`${ok ? "pass" : "fail"}  ${l}`); });
const vacuous = control.filter(f => f.kind === "state" && f.ok);
const brokenGuards = control.filter(f => f.kind === "guard" && !f.ok);
const states = control.filter(f => f.kind === "state");
check(states.length > 0 && vacuous.length === 0,
  `every state check FAILS on the control — ${states.length - vacuous.length}/${states.length}`
  + (vacuous.length ? `; measuring nothing: ${vacuous.map(f => f.l).join(" | ")}` : ""));
check(brokenGuards.length === 0,
  `and every guard still holds there — ${control.filter(f => f.kind === "guard").length - brokenGuards.length}/${control.filter(f => f.kind === "guard").length}`
  + (brokenGuards.length ? `; regressions: ${brokenGuards.map(f => f.l).join(" | ")}` : ""));

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
