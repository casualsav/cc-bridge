import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The roster's fourth state. "Idle" used to mean three things at once — done, finished-but-silent,
// and blocked on something external — and this measures that a reader can now tell them apart.
//
// The claims and the kind of proof each needs:
//
//   COLOUR is sampled from the RENDER, never from getComputedStyle. A declared colour that resolves
//   to the card's own ground passes every computed-style assertion and is invisible on the device —
//   the trap `finaldot.mjs` documents at 9/255. So the four dots are screenshotted and required to
//   be pairwise distinct by a real margin.
//
//   STILLNESS is the distinction between waiting and working, so it is asserted as such: the working
//   dot animates, the waiting dot must not. Colour alone would leave a paused session looking like a
//   working one caught mid-fade.
//
//   The TASK LINE is a replacement, not an addition — a waiting card shows its reason INSTEAD of the
//   last-reply snippet (which is from before it started waiting), and must not grow the card.
//
// The CONTROL runs against the pinned pre-feature copy of the page, rendered from git, and the harness FAILS if a
// check the feature is supposed to introduce passes there: a check that is already green without the
// feature is measuring nothing. It runs here rather than behind a flag, so it cannot be skipped.
//
// Not every check can be a control, and pretending otherwise is its own bug. Each one below declares
// which it is: STATE checks must fail on the baseline (they are the feature); GUARDS are expected to pass on
// both pages (they say the change did NOT disturb the idle card, the working card or the geometry) —
// the same split sessions.mjs draws between its controls and its contents diff. A guard that starts
// failing is a regression; a state check that passes on the baseline is a check that cannot fail.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// The control is PINNED to the last commit without this feature — never HEAD. A HEAD-relative
// control is a control only until the work is committed, and then it silently becomes a copy of the
// page under test: every state check passes on both, and the script reports "measuring nothing"
// forever. That happened here within the hour, which is why the commit is written down.
const BASELINE = process.env.WAITSTATE_BASELINE || "dd2767f";
const BASE = join(mkdtempSync(join(tmpdir(), "wait-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

// One card per state, plus the dead card the list can still produce. `task` is present on EVERY row
// on purpose: it is what a waiting or unreported card must be shown to replace rather than append to.
const TASK = "Reading the transcript back and folding the working row into the composer";
const SESSIONS = [
  { sid: "s0", name: "cc-bridge", state: "working", working: true, alive: true, task: TASK, wait: null, unreported: null },
  { sid: "s1", name: "taste", state: "waiting", working: false, alive: true, task: TASK,
    wait: { why: "said", label: "CI run 18832" }, unreported: null },
  { sid: "s2", name: "polyscan", state: "waiting", working: false, alive: true, task: TASK,
    wait: { why: "proc", label: "gh run watch 18832" }, unreported: null },
  { sid: "s3", name: "dm-bridge", state: "unreported", working: false, alive: true, task: TASK,
    wait: null, unreported: { briefer: "lead" } },
  { sid: "s4", name: "webapp", state: "idle", working: false, alive: true, task: TASK, wait: null, unreported: null },
  // The height control. A wait label is short and a last-reply snippet is long, so comparing a
  // waiting card to the card above would only measure how many lines each one's TEXT wraps to — it
  // reported a 20px "regression" that was two lines of prose. This row carries a task the same
  // length as the wait label, which is what makes the comparison about the state and not the string.
  { sid: "s6", name: "suite-index", state: "idle", working: false, alive: true, task: "CI run 18832", wait: null, unreported: null },
  { sid: "s5", name: "store-template", state: "idle", working: false, alive: false, task: null, wait: null, unreported: null },
].map(s => ({ cwd: "~/projects/x", model: "Opus 5", effort: "high", subagents: 0, branch: "main", ctxPct: 41, h5Pct: null, ...s }));

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

const open = async path => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  // Through showTab for the same reason sessions.mjs does it: boot() is gated on Telegram init data
  // and never runs from file://, so calling renderSessions() directly measures a screen the app
  // never assembles.
  await p.evaluate(list => {
    window.api = async u => u.includes("/api/sessions") ? { sessions: list } : { accounts: [], jobs: [], settings: [], write: false };
    showTab("sessions");
  }, SESSIONS);
  await p.waitForTimeout(600);
  return p;
};

// Every claim, run against one page. `sink(kind, ok, label)` decides what a result MEANS — on the
// page under test everything must pass; on the control only the guards may.
async function measure(page, label, sink) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);   // the feature — must FAIL on the baseline
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);   // unchanged behaviour — passes on both

  const rows = await page.evaluate(() => [...document.querySelectorAll(".sess")].map(c => {
    const dot = c.querySelector(".top .dot"), task = c.querySelector(".task");
    const r = dot && dot.getBoundingClientRect();
    return {
      name: c.querySelector(".nm").textContent,
      dotClass: dot ? dot.className : null,
      anim: dot ? getComputedStyle(dot).animationName : null,
      task: task ? task.textContent : null,
      height: +c.getBoundingClientRect().height.toFixed(1),
      dotAt: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
    };
  }));
  const by = n => rows.find(r => r.name === n);
  const [work, said, proc, unrep, idle, dead, short] =
    ["cc-bridge", "taste", "polyscan", "dm-bridge", "webapp", "store-template", "suite-index"].map(by);
  if (!work || !said || !idle) { state(false, "the fixture renders every card"); return }

  // ---- 1. The task line says the state, and replaces the snippet -------------------------------
  state(said.task?.startsWith("⏳ waiting: CI run 18832"), `a declared wait reads its own reason (${JSON.stringify(said.task)})`);
  state(proc.task?.startsWith("⏳ waiting: gh run watch"), `an inferred wait names the command it is running (${JSON.stringify(proc.task)})`);
  state(!said.task?.includes("Reading the transcript"), "and REPLACES the last-reply snippet, which predates the wait");
  // `unreported` left this surface on 2026-07-29 (the owner: "it continuously shows up when work is
  // actually done"). It is still computed, still on the roster and still what the report nudges run
  // off — it simply reads as DONE on a card, exactly like an idle session's last reply. A STATE
  // check, not a guard: the baseline prints the 📤 line, so this must fail there.
  state(unrep.task?.startsWith("✅ ") && !unrep.task.includes("📤"),
    `unreported reads as done, like any finished session (${JSON.stringify(unrep.task?.slice(0, 24))})`);
  // A STATE check since the ✅ swap: the baseline prints 💬 here, so this fails there — which is
  // what "idle now means done, not merely quiet" is worth as a claim.
  state(idle.task?.startsWith("✅ "), `an idle card marks its last reply DONE (${JSON.stringify(idle.task?.slice(0, 24))})`);
  // The working glyph became 🧑‍💻 on 2026-07-29, when ⏳ moved onto `waiting` — the hourglass belongs
  // to the state that is blocked. That makes it a STATE check, not a guard: the baseline prints ⏳
  // here, so a guard would have to assert the old glyph to keep passing there, and would then be
  // pinning the vocabulary this change replaced. What stays a guard is the line EXISTING at all.
  state(work.task?.startsWith("🧑‍💻 "), `a working card is a person at a keyboard (${JSON.stringify(work.task?.slice(0, 24))})`);
  guard(!!work.task && work.task.length > 2, `and a working card still names what it is doing (${JSON.stringify(work.task?.slice(0, 30))})`);

  // ---- 2. Stillness ----------------------------------------------------------------------------
  // Bound to the CLASS, not to `animationName` alone: an idle dot is also unanimated, so "no
  // animation" on its own is true of the page that has no waiting state at all.
  guard(work.anim && work.anim !== "none", `the working dot animates (${work.anim})`);
  state(/\bwait\b/.test(said.dotClass ?? "") && said.anim === "none",
    `the waiting dot is its own state and does NOT animate — stillness is what tells it from working (${said.dotClass} / ${said.anim})`);

  // ---- 3. Three dot colours, sampled from the render, all distinct ------------------------------
  // Two device pixels at dpr 1; the clip is the dot's own centre, so the read is ink, not edge.
  // Scrolled into view and RE-READ before sampling: the fixture is longer than the viewport, the
  // last cards sit below the fold, and a clip outside the image throws — which would take the whole
  // control down with it and report nothing at all.
  const ink = async row => {
    const at = await page.evaluate(name => {
      const c = [...document.querySelectorAll(".sess")].find(x => x.querySelector(".nm").textContent === name);
      const d = c && c.querySelector(".top .dot");
      if (!d) return null;
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
  const px = { work: await ink(work), wait: await ink(said), idle: await ink(idle), dead: await ink(dead) };
  const far = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  // The state claim is that the waiting dot is AMBER — a specific painted colour. "Different from
  // the working dot" is true of the grey the baseline paints there, so distinctness alone cannot be the test.
  state(far(px.wait, [224, 163, 62]) <= 6, `the waiting dot paints amber — ${px.wait} vs 224,163,62`);
  // Waiting-vs-idle is the whole point and is 0/255 without the feature, so it is a state check;
  // the other two pairs are far apart on any build and only say the new colour did not collide.
  state(far(px.wait, px.idle) >= 40, `waiting and idle are TOLD APART on the SCREEN — ${far(px.wait, px.idle)}/255 (${px.wait} vs ${px.idle})`);
  for (const [x, y] of [["work", "wait"], ["wait", "dead"]])
    guard(far(px[x], px[y]) >= 40, `${x} and ${y} stay far apart on the SCREEN — ${far(px[x], px[y])}/255 (${px[x]} vs ${px[y]})`);
  // The unreported card deliberately does NOT take a fourth colour: three is what an 11px disc carries
  // — and since the state left the task line too, the idle dot is now the whole of what it renders as.
  guard(far(px.idle, await ink(unrep)) <= 4, "unreported keeps the idle dot — it reads as a finished session");

  // ---- 4. It costs the card no height ----------------------------------------------------------
  // Against the SHORT idle card: a wait label is one line and a last-reply snippet is two, so
  // measuring against the long card would report the prose, not the state.
  // State checks, not guards: on the baseline these cards print the long snippet and stand 20px taller, so
  // "one line, no taller than any other one-line card" is a thing the feature makes true.
  state(Math.abs(said.height - short.height) < 0.5, `a waiting card is the height of an idle card with the same-length line (${said.height} vs ${short.height})`);
  state(Math.abs(unrep.height - short.height) < 0.5, `and so is an unreported one (${unrep.height} vs ${short.height})`);
}

const p = await open(PAGE);
await measure(p, "page", (_kind, ok, l) => check(ok, l));
if (OUT) await p.screenshot({ path: join(OUT, "waitstate-cards.png"), fullPage: true });

// ---- The control -------------------------------------------------------------------------------
// The baseline page has no fourth state: it paints the idle dot, prints the stale snippet, and knows
// nothing about a wait label. Every STATE check must fail here; the guards are expected to pass, and
// a guard that fails is a regression this change made to the cards it was not supposed to touch.
const control = [];
const c = await open(BASE);
await measure(c, "control(baseline)", (kind, ok, l) => { control.push({ kind, ok, l }); console.log(`${ok ? "pass" : "fail"}  ${l}`); });
const vacuous = control.filter(f => f.kind === "state" && f.ok);
const brokenGuards = control.filter(f => f.kind === "guard" && !f.ok);
const states = control.filter(f => f.kind === "state");
check(states.length > 0 && vacuous.length === 0,
  `every state check FAILS on the control — ${states.length - vacuous.length}/${states.length}`
  + (vacuous.length ? `; measuring nothing: ${vacuous.map(f => f.l).join(" | ")}` : ""));
check(brokenGuards.length === 0,
  `and every guard still holds there — ${control.filter(f => f.kind === "guard").length - brokenGuards.length}/${control.filter(f => f.kind === "guard").length}`
  + (brokenGuards.length ? `; broken: ${brokenGuards.map(f => f.l).join(" | ")}` : ""));

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
