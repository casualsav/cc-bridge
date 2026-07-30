import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE SESSION-CHAT HEADER, restored: a floating name/cwd PILL over the pill-era gradient, with the
// transcript running to the very top of the screen — and no chips of our own beside it. The owner's
// ask, 2026-07-30, three parts in one change:
//
//   1. the client's ← takes over here too, so BackButton is raised UN-GATED (it was fullscreen-only,
//      because our own chip covered the other case — and that chip is now gone);
//   2. the in-page back and pause chips are removed. Back moved; the pause had NO replacement in this
//      app, and that is stated rather than implied — see the report and webapp/CLAUDE.md;
//   3. the pill design comes back from 8c6ef3f^ (v0.4.154 is where it was taken off), gradient and
//      chat-to-top included, carrying no buttons this time.
//
// What this file measures is the UNIT: the control that replaced the chip actually being raised and
// actually returning to the command center, no halt affordance left anywhere on the screen, and the
// pill's own surface over a gradient that still fades through the band. Geometry lives in header.mjs,
// the scrim's rendered profile in bleed.mjs and headerup.mjs, the cwd's contrast in halo.py.
//
// CONTROL: the page pinned before the change. Every state check must FAIL there; the guards (a
// full-bleed feed, the title's text) held before and must hold after.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// ed2a942 is the last commit with the two chips and the no-pill header.
const BASELINE = process.env.DRILLHEAD_BASELINE || "ed2a942";
const BASE = join(mkdtempSync(join(tmpdir(), "drillhead-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const SESSION = { sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: false,
  state: "idle", task: "Reading the transcript back", model: "Opus 5", effort: "high", ctxPct: 41, branch: "main", subagents: 0 };
// Long enough to overflow, and USER bubbles: a bright fill is what makes "the transcript is behind the
// pill" and the gradient visible at all — an unbubbled assistant row is the page's own colour.
const FEED = { ...SESSION, items: Array.from({ length: 14 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user", uuid: "m" + i, ts: 1785200000000,
  text: `Message ${i + 1}. ` + "Long enough that the transcript runs up under the header and keeps scrolling. ".repeat(2),
})) };

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// The SDK is stubbed and RECORDS what the page asks the client to do: BackButton is client chrome, so
// what it was asked for is the only observable this side of a real Telegram.
const open = async path => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.route("**/telegram-web-app.js", r => r.abort());
  await p.addInitScript(() => {
    window.__bb = { shown: 0, hidden: 0, handlers: [] };
    window.Telegram = { WebApp: { initData: "user=%7B%22id%22%3A1%7D&hash=x", initDataUnsafe: { user: { id: 1 } },
      ready() {}, expand() {}, close() {}, themeParams: {}, colorScheme: "dark", isExpanded: true,
      // NOT fullscreen — the whole point of part 1 is the case the old gate excluded.
      isFullscreen: false, viewportHeight: 812, onEvent() {}, offEvent() {}, isVersionAtLeast: () => true,
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
      BackButton: { isVisible: false, show() { window.__bb.shown++; this.isVisible = true },
        hide() { window.__bb.hidden++; this.isVisible = false }, onClick(f) { window.__bb.handlers.push(f) }, offClick() {} },
      SettingsButton: { isVisible: false, show() {}, hide() {}, onClick() {}, offClick() {} },
      showConfirm(_m, cb) { cb(true) },
    } };
  });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(([s, feed]) => {
    window.api = async u => u.includes("/api/session/feed") ? feed : u.includes("/api/sessions") ? { sessions: [s] } : {};
    showTab("sessions");
  }, [SESSION, FEED]);
  await p.waitForTimeout(400);
  return p;
};

async function measure(path, label, shotPrefix) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);
  const p = await open(path);

  // ---- 1. the client's ← , un-gated ------------------------------------------------------------
  await p.evaluate(() => openDrill("s1", "cc-bridge"));
  await p.waitForTimeout(700);
  const bbIn = await p.evaluate(() => ({ visible: window.Telegram.WebApp.BackButton.isVisible, handlers: window.__bb.handlers.length }));
  state(bbIn.visible && bbIn.handlers === 1,
    `opening a session raises the client's back control OUTSIDE fullscreen (visible ${bbIn.visible}, handlers ${bbIn.handlers})`);

  // ---- 2. the header carries nothing but the title ---------------------------------------------
  const head = await p.evaluate(() => {
    const pill = document.querySelector("#drill .dtitle"), cs = getComputedStyle(pill);
    const r = pill.getBoundingClientRect(), hr = document.querySelector("#drill .vhead").getBoundingClientRect();
    const feed = document.getElementById("dfeed");
    return {
      buttons: document.querySelectorAll("#drill .vhead button").length,
      // Read as a CLASS: "is there any way to halt a turn on this screen", not "is #dstop absent".
      halts: [...document.querySelectorAll("#drill button")].filter(x =>
        /interrupt|stop|pause|halt/i.test((x.id || "") + " " + (x.title || "") + " " + (x.getAttribute("aria-label") || ""))).map(x => x.id || x.title),
      fill: cs.backgroundColor, rim: cs.boxShadow, frost: cs.backdropFilter,
      radius: parseFloat(cs.borderTopLeftRadius),
      shrunk: +(hr.width - r.width).toFixed(1),
      centred: Math.abs((r.left - hr.left) - (hr.right - r.right)) < 1.5,
      name: document.getElementById("dname").textContent, sub: document.getElementById("dsub").textContent,
      feedTop: +feed.getBoundingClientRect().top.toFixed(1),
      scrimH: parseFloat(getComputedStyle(document.getElementById("drill"), "::before").height),
      pillTop: +r.top.toFixed(1), pillBottom: +r.bottom.toFixed(1),
    };
  });
  state(head.buttons === 0 && head.halts.length === 0,
    `no chips in the header and no halt affordance anywhere in the drill (buttons ${head.buttons}, halts ${head.halts.join(",") || "none"})`);
  state(head.fill !== "rgba(0, 0, 0, 0)" && head.rim !== "none" && /blur/.test(head.frost || ""),
    `the pill has its fill, rim and frost back (${head.fill})`);
  // SHRINK-WRAP is tested by making the name longer and watching the box follow. "Narrower than the
  // row" does not discriminate: the pre-change title was `flex: 1` minus two chip-sized margins, so it
  // was narrower too — and it stayed exactly that width whatever the name said. A content-sized box is
  // what makes the pill a pill rather than a bar with rounded ends.
  const grew = await p.evaluate(() => {
    const pill = document.querySelector("#drill .dtitle"), name = document.getElementById("dname");
    const before = pill.getBoundingClientRect().width;
    const was = name.textContent;
    name.textContent = "a-considerably-longer-session-name-than-that";
    const after = pill.getBoundingClientRect().width;
    name.textContent = was;
    return { before: +before.toFixed(1), after: +after.toFixed(1) };
  });
  state(grew.after > grew.before + 8 && head.centred,
    `and it is shrink-wrapped and centred, not a bar (${grew.before}px → ${grew.after}px on a longer name, centred ${head.centred})`);
  guard(head.name === "cc-bridge" && head.sub === "~/projects/cc-bridge", `the pill still carries name over cwd (${head.name} / ${head.sub})`);
  guard(head.feedTop === 0, `the transcript runs to the very top of the screen (feed top ${head.feedTop})`);
  // The gradient ends at the pill's own floor — the pill-era length. The build this replaced ran ~23px
  // further, which is the near-solid band the owner is not asking for.
  state(Math.abs(head.scrimH - head.pillBottom) <= 2,
    `the gradient ends at the pill's floor, pill-era length (${head.scrimH} vs pill bottom ${head.pillBottom})`);

  if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-drill-top.png`), clip: { x: 0, y: 0, width: 390, height: 300 } });

  // ---- 3. back really is the way out ----------------------------------------------------------
  await p.evaluate(() => { (window.__bb.handlers[0] || (() => {}))(); });
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => ({
    drill: document.getElementById("drill").classList.contains("show"),
    cards: document.querySelectorAll("#tab-sessions .sess").length,
    bb: window.Telegram.WebApp.BackButton.isVisible,
  }));
  // A GUARD, not a state check, and the distinction is the point of the ask: the ROUTING already
  // worked — onNativeBack has dispatched at tap time since v0.4.266 — so what changed here is only
  // that the control is raised at all (checked above). This asserts the routing did not break while
  // the gate came off.
  guard(!after.drill && after.cards === 1 && !after.bb,
    `tapping it leaves the session for the command center, and the control goes with it (drill ${after.drill}, cards ${after.cards}, back ${after.bb})`);
  await p.close();
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (two chips, no pill) ---`);
const mark = results.length;
await measure(BASE, "baseline", "0");
const ctl = results.slice(mark);
const ctlState = ctl.filter(r => r.kind === "state");
const ctlStateFailed = ctlState.filter(r => !r.ok).length;
const ctlGuardFailed = ctl.filter(r => r.kind === "guard" && !r.ok).length;
console.log(`\ncontrol: ${ctlStateFailed}/${ctlState.length} state checks failed on ${BASELINE} (they must), ${ctlGuardFailed} guards failed (must be 0)`);
const pageBad = results.slice(0, mark).filter(r => !r.ok).length;
const vacuous = ctlStateFailed < ctlState.length || ctlGuardFailed > 0;
console.log(vacuous
  ? "FAIL  the control did not behave: every state check must fail there and both guards must pass"
  : "OK    the control fails every state check and keeps both guards");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
