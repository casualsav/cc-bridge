import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The chat lane's waiting dot is GREEN, and nothing else's is (the owner, 2026-07-29: a chat lane
// waiting on its human is its resting state, not a stall — amber reads as a problem where nothing
// is wrong). The whole of the change is one branch, so the whole of the risk is that the branch is
// wider than it says: every other card's waiting, and the chat card's own other states.
//
// What each claim needs to be worth anything:
//
//   COLOUR is sampled from the RENDER, never from getComputedStyle — waitstate.mjs's rule, for its
//   reason: a declared colour that resolves to the card's own ground passes every computed-style
//   assertion and is invisible on the device. So both waiting dots are screenshotted, and the chat
//   one is required to land on .dot.on's green while the worker one stays on the amber literal.
//
//   STILLNESS is asserted separately, because the green is BORROWED and the pulse is not. The file's
//   rule is that stillness tells waiting from working and the hue does not; a chat lane whose
//   waiting dot pulsed would read as working, which is the one confusion this colour could buy.
//
//   The CONTROL is the pinned pre-change page, rendered from git. On it the chat lane's waiting dot
//   is amber like everyone else's, so the state checks must fail there; the guards say the branch
//   did not reach the worker cards or the chat lane's other states, and must pass on BOTH.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// PINNED to the last commit without this feature, never HEAD — a HEAD-relative control stops being a
// control the moment the work is committed, and then every state check passes on both pages and the
// script reports "measuring nothing" forever (waitstate.mjs learned this within the hour).
const BASELINE = process.env.CHATREST_BASELINE || "2ee4024";
const BASE = join(mkdtempSync(join(tmpdir(), "chatrest-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

// The matrix the branch has to be narrow across: {chat lane, worker} × {working, waiting, idle}.
// The chat rows carry a full payload (task, branch, ctx) on purpose — the same reason cardfoot.mjs's
// does: a bare chat card must be a decision, not an empty fixture.
const TASK = "Reading the transcript back and folding the working row into the composer";
const SESSIONS = [
  { sid: "c0", name: "Chat (@suchag)", chat: true, state: "working", working: true, task: TASK, wait: null },
  { sid: "c1", name: "Chat (@other)", chat: true, state: "waiting", working: false, task: TASK,
    wait: { why: "said", label: "the owner" } },
  { sid: "c2", name: "Chat (@third)", chat: true, state: "idle", working: false, task: TASK, wait: null },
  { sid: "w0", name: "cc-bridge", state: "working", working: true, task: TASK, wait: null },
  { sid: "w1", name: "taste", state: "waiting", working: false, task: TASK,
    wait: { why: "proc", label: "gh run watch 18832" } },
  { sid: "w2", name: "polyscan", state: "idle", working: false, task: TASK, wait: null },
].map(s => ({ cwd: "~/projects/x", model: "Opus 5", effort: "high", subagents: 0, branch: "main",
  ctxPct: 41, h5Pct: null, alive: true, chat: false, unreported: null, ...s }));

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

const open = async path => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  // Through showTab, like every other card script: boot() is gated on Telegram init data and never
  // runs from file://, so calling renderSessions() directly measures a screen the app never builds.
  await p.evaluate(list => {
    window.api = async u => u.includes("/api/sessions") ? { sessions: list } : { accounts: [], jobs: [], settings: [], write: false };
    showTab("sessions");
  }, SESSIONS);
  await p.waitForTimeout(600);
  return p;
};

const GREEN = [76, 175, 80];   // .dot.on
const AMBER = [224, 163, 62];  // .dot.wait
const far = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

async function measure(page, label, sink) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);   // the feature — must FAIL on the control
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);   // untouched behaviour — passes on both

  const rows = await page.evaluate(() => [...document.querySelectorAll(".sess")].map(c => {
    const dot = c.querySelector(".top .dot");
    return {
      name: c.querySelector(".nm").textContent,
      dotClass: dot ? dot.className : null,
      anim: dot ? getComputedStyle(dot).animationName : null,
      task: c.querySelector(".task") ? c.querySelector(".task").textContent : null,
      height: +c.getBoundingClientRect().height.toFixed(1),
    };
  }));
  const by = n => rows.find(r => r.name === n);
  const [cwork, cwait, cidle, work, wait, idle] =
    ["Chat (@suchag)", "Chat (@other)", "Chat (@third)", "cc-bridge", "taste", "polyscan"].map(by);
  if (!cwait || !wait) { state(false, "the fixture renders every card"); return }

  // Scrolled into view and re-read before the clip: the fixture is longer than the viewport and a
  // clip outside the image throws, which would take the control down with it and report nothing.
  //
  // The pulse is FROZEN AT ITS 0% KEYFRAME before the shot, and that is the instrument, not a
  // convenience: a working dot's opacity is animating between 1 and .35, so an unfrozen screenshot
  // samples green composited over the card at whatever phase the frame landed on. It read 52,100,68
  // — plausible, wrong, and it made the working dots look like a colour change on both pages. The
  // stillness claims are taken from `rows` above, before anything here is paused, so freezing the
  // animation cannot make a still dot out of a moving one.
  const ink = async row => {
    const at = await page.evaluate(name => {
      const c = [...document.querySelectorAll(".sess")].find(x => x.querySelector(".nm").textContent === name);
      const d = c && c.querySelector(".top .dot");
      if (!d) return null;
      d.getAnimations().forEach(a => { a.pause(); a.currentTime = 0 });
      d.scrollIntoView({ block: "center" });
      const r = d.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, row.name);
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
  const px = { cwork: await ink(cwork), cwait: await ink(cwait), cidle: await ink(cidle),
    work: await ink(work), wait: await ink(wait), idle: await ink(idle) };

  // ---- 1. The chat lane's waiting dot is green ---------------------------------------------------
  // Against the LITERAL, not merely "different from amber": the claim is that it paints .dot.on's
  // green, and "not amber" is also true of grey, which is what a mis-scoped branch would leave.
  state(far(px.cwait, GREEN) <= 6, `a waiting CHAT lane paints green — ${px.cwait} vs ${GREEN}`);
  state(far(px.cwait, AMBER) >= 40, `and is nowhere near the amber every other waiting card keeps — ${far(px.cwait, AMBER)}/255`);
  // Borrowed colour, so the distinction from working has to come from somewhere: the pulse.
  state(/\brest\b/.test(cwait.dotClass ?? "") && cwait.anim === "none",
    `it is STILL, so it cannot be read as the chat lane WORKING — ${cwait.dotClass} / ${cwait.anim}`);
  guard(px.cwork && far(px.cwork, GREEN) <= 6 && cwork.anim && cwork.anim !== "none",
    `a working chat lane is the pulsing green it always was — ${px.cwork} / ${cwork.anim}`);

  // ---- 2. The scope guard: every other waiting card is untouched --------------------------------
  guard(far(px.wait, AMBER) <= 6, `a WORKER waiting on something outside itself stays amber — ${px.wait} vs ${AMBER}`);
  guard(/\bwait\b/.test(wait.dotClass ?? "") && wait.anim === "none", `and still — ${wait.dotClass} / ${wait.anim}`);
  // A STATE check, not a guard: on the baseline the two waiting dots are the SAME amber, so this is
  // 0/255 there — telling them apart is precisely what the change buys.
  state(far(px.wait, px.cwait) >= 40, `the two waiting lanes are TOLD APART on the SCREEN — ${far(px.wait, px.cwait)}/255`);

  // ---- 3. and so are the chat lane's other states ------------------------------------------------
  guard(far(px.cidle, px.idle) <= 4, `an idle chat lane keeps the grey an idle worker has — ${px.cidle} vs ${px.idle}`);
  guard(far(px.cidle, GREEN) >= 40, `and did NOT follow waiting into green — ${far(px.cidle, GREEN)}/255`);
  guard(far(px.work, GREEN) <= 6 && work.anim !== "none", `a working worker is unmoved — ${px.work} / ${work.anim}`);

  // ---- 4. and the card's own shape is unmoved ----------------------------------------------------
  // A colour change that reached the markup would show up here first: the chat lane is a bare title
  // row (no task line, no foot) and a worker card carries its line, on both pages.
  guard(cwait.task === null && cidle.task === null, `a chat lane is still a bare title row (${JSON.stringify([cwait.task, cidle.task])})`);
  guard(!!wait.task && wait.task.startsWith("⏳ waiting: gh run watch"), `a waiting worker still names its reason (${JSON.stringify(wait.task)})`);
  guard(Math.abs(cwait.height - cidle.height) < 0.5, `and the waiting chat card is the height of an idle one (${cwait.height} vs ${cidle.height})`);
}

const p = await open(PAGE);
await measure(p, "page", (_kind, ok, l) => check(ok, l));
if (OUT) await p.screenshot({ path: join(OUT, "chatrest-cards.png"), fullPage: true });

// ---- The control --------------------------------------------------------------------------------
// The pinned page paints every waiting dot amber, chat lane included. Every STATE check must fail
// here; a GUARD that fails is a regression this change made to a card it was not supposed to touch.
const control = [];
const c = await open(BASE);
await measure(c, "control(baseline)", (kind, ok, l) => { control.push({ kind, ok, l }); console.log(`${ok ? "pass" : "fail"}  ${l}`); });
if (OUT) await c.screenshot({ path: join(OUT, "chatrest-cards-baseline.png"), fullPage: true });
const vacuous = control.filter(f => f.kind === "state" && f.ok);
const brokenGuards = control.filter(f => f.kind === "guard" && !f.ok);
const states = control.filter(f => f.kind === "state");
check(states.length > 0 && vacuous.length === 0,
  `every state check FAILS on the control — ${states.length - vacuous.length}/${states.length}`
  + (vacuous.length ? `; measuring nothing: ${vacuous.map(f => f.l).join(" | ")}` : ""));
check(brokenGuards.length === 0,
  `every guard still passes on the control — ${control.filter(f => f.kind === "guard").length - brokenGuards.length}/${control.filter(f => f.kind === "guard").length}`
  + (brokenGuards.length ? `; regressions: ${brokenGuards.map(f => f.l).join(" | ")}` : ""));

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
