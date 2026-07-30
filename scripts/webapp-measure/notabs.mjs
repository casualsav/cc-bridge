import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The tab row HIDDEN behind one flag, with Settings moved to Telegram's own ⋮ menu — the owner's
// look-and-feel trial. What this measures, and why each one is a check rather than a restatement of
// the CSS:
//
//   The row must render NOTHING and cost NOTHING. `display: none` is the ask ("reclaim the vertical
//   space"), so height 0 is not enough on its own: the band the bar used to own is HIT-TESTED, and
//   the first card's top is read to prove the content reflowed INTO it rather than merely sitting
//   under an invisible bar.
//
//   The bar was carrying --safe-top for every flow view. That is 0 outside fullscreen, so a check run
//   at rest cannot see the regression at all — the var is forced and the padding re-read.
//
//   The ⋮ item is the only door to Settings now, so both directions are driven: it opens Settings, it
//   comes back, and it does not switch a tab underneath the drill-in.
//
//   GUARDS (must pass on the baseline too): the four buttons are still in the DOM and showTab() still
//   switches panels when called — the row is hidden, not retired, because a floating reveal is next.
//   Plus Sessions being the view on open, which the trial must not have changed.
//
// The CONTROL is the page PINNED at the commit before this change (never HEAD: once the work is
// committed a HEAD-relative control is a copy of the page under test). Every state check must FAIL
// there.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
const BASELINE = process.env.NOTABS_BASELINE || "3681d1e";
const BASE = join(mkdtempSync(join(tmpdir(), "notabs-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

// Three cards, so the list is a real screen rather than one row against the top edge.
const SESSIONS = [
  { sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: true, state: "working",
    task: "hiding the tab row", model: "Opus 5", effort: "high", ctxPct: 42, branch: "main" },
  { sid: "s2", name: "memes", cwd: "~/projects/memes", alive: true, working: false, state: "waiting",
    task: "gh run watch", model: "Sonnet 5", effort: "medium", ctxPct: 18, branch: "main" },
  { sid: "s3", name: "store", cwd: "~/projects/store-template", alive: true, working: false, state: "idle",
    task: "Deployed and verified.", model: "Opus 5", effort: "low", ctxPct: 7, branch: "main" },
  // The owner's own chat lane, which since 2026-07-30 is a full card like the rest — here so the
  // screenshot is the list he actually looks at. Its shape is `cardfoot.mjs`'s claim, not this file's.
  { sid: "s4", name: "Chat (@suchag)", chat: true, cwd: "", alive: true, working: false, state: "waiting",
    task: "Hidden behind one flag — measured and shipped.", model: "Fable 5", effort: "high", ctxPct: 34, branch: "main" },
];

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// The SDK is aborted and stubbed: this runs offline, and the stub is also the instrument for the ⋮
// item — it RECORDS what the page asked the client to do, which is the only observable this side of a
// real Telegram client.
const open = async path => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.route("**/telegram-web-app.js", r => r.abort());
  await p.addInitScript(() => {
    window.__sb = { shown: 0, hidden: 0, handlers: [] };
    window.__bb = { shown: 0, hidden: 0, handlers: [] };
    // The app has no in-page close control at all, and this counter is what holds that: it must stay 0
    // through every tap this script makes, on both pages.
    window.__closed = 0;
    window.Telegram = { WebApp: {
      initData: "user=%7B%22id%22%3A1%7D&hash=x", initDataUnsafe: { user: { id: 1 } },
      ready() {}, expand() {}, close() { window.__closed++; }, themeParams: {}, colorScheme: "dark",
      isExpanded: true, isFullscreen: false, viewportHeight: 812,
      onEvent() {}, offEvent() {}, isVersionAtLeast: () => true,
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
      // Recorded exactly like SettingsButton below: what the page asks the CLIENT to do is the only
      // observable for a control the client draws in its own chrome.
      BackButton: {
        isVisible: false,
        show() { window.__bb.shown++; this.isVisible = true; },
        hide() { window.__bb.hidden++; this.isVisible = false; },
        onClick(f) { window.__bb.handlers.push(f); },
        offClick() {},
      },
      SettingsButton: {
        isVisible: false,
        show() { window.__sb.shown++; this.isVisible = true; },
        hide() { window.__sb.hidden++; this.isVisible = false; },
        onClick(f) { window.__sb.handlers.push(f); },
        offClick() {},
      },
    } };
    // Every request the app makes on this screen, answered from the fixture. Installed before the
    // page's own script so boot() — which is what puts Sessions on screen — runs for real.
    window.__fixture = null;
  });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(ss => {
    const setting = (value, label) => ({ value, label, editable: false });
    window.api = async u => {
      if (u.includes("/api/sessions")) return { sessions: ss };
      if (u.includes("/api/settings")) return { write: false, settings: {
        accounts: setting("default"), voice: setting(false), stream: setting(true),
        confirmReset: setting(true), fileBrowser: setting(true), mcp: setting(false),
        spawnModel: setting("Opus 5"), spawnEffort: setting("high"),
        mode: setting("Ask"), model: setting("Opus 5"), effort: setting("high"),
      } };
      if (u.includes("/api/session/feed")) return {
        sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
        working: false, state: "idle", items: [
          { role: "user", text: "hide the tab row", ts: 1785200000000 },
          { role: "assistant", text: "Hidden behind one flag.", ts: 1785200001000 },
        ] };
      if (u.includes("/api/auto")) return { cron: [], queue: [] };
      // The Files tab has no door left, but showTab("files") is driven below to prove the row can
      // come back — an unanswered /api/ls throws inside the page and would read as a page error.
      if (u.includes("/api/ls")) return { path: "/home/ubuntu", write: false, entries: [] };
      return {};
    };
    // boot() already ran with the real api(); re-render the list through the stub.
    showTab("sessions");
  }, SESSIONS);
  await p.waitForTimeout(500);
  return p;
};

const geom = page => page.evaluate(() => {
  const nav = document.getElementById("tabs");
  const nr = nav ? nav.getBoundingClientRect() : null;
  const card = document.querySelector("#tab-sessions .sess");
  const cr = card ? card.getBoundingClientRect() : null;
  // Hit-test the band the bar used to own, across the row — a rect of height 0 says nothing about
  // what is painted or what captures a tap there.
  const band = [40, 140, 240, 330].map(x =>
    document.elementsFromPoint(x, 10).some(el => el.closest && el.closest("#tabs")));
  return {
    navDisplay: nav ? getComputedStyle(nav).display : "absent",
    navH: nr ? +nr.height.toFixed(1) : -1,
    buttons: document.querySelectorAll("#tabs button[data-tab]").length,
    cardTop: cr ? +cr.top.toFixed(1) : -1,
    bandHitsNav: band.filter(Boolean).length,
    bodyPadTop: getComputedStyle(document.body).paddingTop,
  };
});

const tabState = page => page.evaluate(() => ({
  cur: typeof curTab === "string" ? curTab : "?",
  shown: [...document.querySelectorAll(".tab")].filter(t => t.classList.contains("show")).map(t => t.id),
  drill: document.getElementById("drill").classList.contains("show"),
}));

async function measure(path, label, shotPrefix) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);
  const page = await open(path);
  const g = await geom(page);

  // ---- 1. The row renders nothing and costs nothing ---------------------------------------------
  state(g.navDisplay === "none" && g.navH === 0,
    `the tab row is not laid out at all (display: ${g.navDisplay}, height ${g.navH})`);
  state(g.bandHitsNav === 0,
    `nothing of the bar is painted or tappable in the top band (${g.bandHitsNav}/4 hit points still land in #tabs)`);
  // The panel's own padding is --sp-3 (12px); the bar was ~57 tall. A card starting inside the first
  // 24px can only mean the content reflowed to the top.
  state(g.cardTop > 0 && g.cardTop < 24,
    `the first card reflowed INTO the reclaimed strip (top ${g.cardTop}px)`);

  // ---- 2. --safe-top, which the bar was carrying ------------------------------------------------
  // Forced, because it is 0 in every non-fullscreen state — at rest this regression is invisible.
  const safe = await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "56px");
    const card = document.querySelector("#tab-sessions .sess");
    return { pad: getComputedStyle(document.body).paddingTop, cardTop: +card.getBoundingClientRect().top.toFixed(1) };
  });
  state(safe.pad === "56px" && safe.cardTop >= 56,
    `with the row gone, body takes over its --safe-top padding (pad ${safe.pad}, card top ${safe.cardTop})`);
  await page.evaluate(() => document.documentElement.style.removeProperty("--safe-top"));

  // ---- 3. The ⋮ item: the only door to Settings -------------------------------------------------
  const sb = await page.evaluate(() => ({ shown: window.__sb.shown, handlers: window.__sb.handlers.length }));
  state(sb.shown === 1 && sb.handlers === 1,
    `the page asked the client for its Settings menu item exactly once (show ${sb.shown}, handlers ${sb.handlers})`);

  const before = await tabState(page);
  guard(before.cur === "sessions" && before.shown.includes("tab-sessions"),
    `Sessions is the view on open (${before.cur}, showing ${before.shown.join("+") || "nothing"})`);

  const fire = async () => {
    await page.evaluate(() => { (window.__sb.handlers[0] || (() => {}))(); });
    await page.waitForTimeout(300);
    return tabState(page);
  };
  const opened = await fire();
  state(opened.cur === "settings" && opened.shown.join() === "tab-settings",
    `tapping Settings in the ⋮ menu opens the Settings view (${opened.cur}, showing ${opened.shown.join("+") || "nothing"})`);
  if (OUT) await page.screenshot({ path: join(OUT, `${shotPrefix}-settings-via-menu.png`) });
  const back = await fire();
  // Both legs in ONE check on purpose: "we are on Sessions after the second tap" passes on a page
  // where the item does nothing at all and Sessions never left the screen — the first run of this
  // script recorded exactly that against the control.
  state(opened.cur === "settings" && back.cur === "sessions" && back.shown.join() === "tab-sessions",
    `tapping it again is the way back — the app is never stranded in Settings (${opened.cur} → ${back.cur})`);

  // From inside a session: the drill-in is fixed and full-screen, so the item must close it rather
  // than switch a tab nobody can see.
  await page.evaluate(() => openDrill("s1", "cc-bridge"));
  await page.waitForTimeout(400);
  const inDrill = await tabState(page);
  guard(inDrill.drill, "a session opens the drill-in (fixture control for the check below)");
  const fromDrill = await fire();
  state(!fromDrill.drill && fromDrill.cur === "settings",
    `from inside a session it leaves the drill-in and lands on Settings (drill ${fromDrill.drill}, ${fromDrill.cur})`);
  await page.evaluate(() => { closeDrill(); showTab("sessions"); });
  await page.waitForTimeout(400);

  // ---- 4. The way HOME from Settings: the client's own back control ----------------------------
  // The ⋮ toggle was a door out and the owner did not find it one ("no way to get back to the main
  // command center screen without closing and reopening the mini app"), so Settings now raises
  // BackButton — where every Telegram user already looks. Driven through showTab(), not the ⋮ handler:
  // the baseline has no ⋮ item at all, and a control that cannot reach the screen under test proves
  // nothing about what that screen does.
  const bbAt = async () => page.evaluate(() => ({
    shown: window.__bb.shown, hidden: window.__bb.hidden,
    visible: window.Telegram.WebApp.BackButton.isVisible, handlers: window.__bb.handlers.length,
  }));
  await page.evaluate(() => showTab("settings"));
  await page.waitForTimeout(300);
  const bbSettings = await bbAt();
  state(bbSettings.visible && bbSettings.handlers === 1,
    `opening Settings raises the client's back control (visible ${bbSettings.visible}, handlers ${bbSettings.handlers})`);
  if (OUT) await page.screenshot({ path: join(OUT, `${shotPrefix}-settings-with-back.png`) });
  await page.evaluate(() => { (window.__bb.handlers[0] || (() => {}))(); });
  await page.waitForTimeout(400);
  const afterBack = await tabState(page);
  const bbHome = await bbAt();
  state(afterBack.cur === "sessions" && afterBack.shown.join() === "tab-sessions",
    `tapping back from Settings returns to Sessions (${afterBack.cur}, showing ${afterBack.shown.join("+") || "nothing"})`);
  // BOTH ends again: "not visible now" is true on a page that never raised it at all.
  state(bbSettings.visible && !bbHome.visible && bbHome.hidden >= 1,
    `and the back control goes away with the screen that raised it (${bbSettings.visible} → ${bbHome.visible}, ${bbHome.hidden} hide calls)`);

  // Nothing in Settings closes the app. `close()` is counted across every tap this script has made,
  // AND every enabled control inside the rendered Settings view is tapped looking for one.
  await page.evaluate(async () => {
    await showTab("settings");
    for (const el of document.querySelectorAll("#tab-settings button:not([disabled]), #tab-settings .setrow > *")) {
      try { el.click(); } catch {}
    }
  });
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => window.__closed);
  // A GUARD, not a state check: the page has never had a `tg.close()` call anywhere in it, so this
  // passes on the baseline too. It is here because "the close button is replaced" is the ask, and the
  // only close control this app has is the CLIENT's own ✕ — which is exactly what BackButton displaces.
  guard(closed === 0, `nothing in the Settings view can close the mini app (close() calls: ${closed})`);
  await page.evaluate(() => showTab("sessions"));
  await page.waitForTimeout(300);

  // The drill-in keeps ITS back control, on the same single registered handler — a guard, since this
  // is what the page did before Settings joined it.
  const drillBack = await page.evaluate(async () => {
    window.Telegram.WebApp.isFullscreen = true;
    openDrill("s1", "cc-bridge");
    await new Promise(r => setTimeout(r, 300));
    const raised = window.Telegram.WebApp.BackButton.isVisible;
    (window.__bb.handlers[0] || (() => {}))();
    await new Promise(r => setTimeout(r, 300));
    window.Telegram.WebApp.isFullscreen = false;
    return { raised, drill: document.getElementById("drill").classList.contains("show") };
  });
  guard(drillBack.raised && !drillBack.drill,
    `the drill-in still raises the same back control and it still closes that screen (raised ${drillBack.raised}, drill after ${drillBack.drill})`);

  // ---- 5. Guards: hidden, not retired ----------------------------------------------------------
  guard(g.buttons === 4, `all four tab buttons are still in the DOM (${g.buttons})`);
  const reachable = await page.evaluate(async () => {
    const out = {};
    for (const t of ["files", "auto", "settings", "sessions"]) {
      await showTab(t);
      out[t] = document.getElementById("tab-" + t) ? document.getElementById("tab-" + t).classList.contains("show") : "absent";
    }
    return out;
  });
  guard(Object.values(reachable).every(v => v === true || v === "absent"),
    `showTab() still switches every panel — the row can come back by flipping the flag (${JSON.stringify(reachable)})`);
  await page.evaluate(() => showTab("sessions"));
  await page.waitForTimeout(400);
  if (OUT) await page.screenshot({ path: join(OUT, `${shotPrefix}-sessions.png`), fullPage: false });
  await page.close();
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (the page before the flag) ---`);
const mark = results.length;
await measure(BASE, "baseline", "0");
const ctl = results.slice(mark);
const ctlStateFailed = ctl.filter(r => r.kind === "state" && !r.ok).length;
const ctlStateTotal = ctl.filter(r => r.kind === "state").length;
const ctlGuardFailed = ctl.filter(r => r.kind === "guard" && !r.ok).length;
console.log(`\ncontrol: ${ctlStateFailed}/${ctlStateTotal} state checks failed on ${BASELINE} (they must), ${ctlGuardFailed} guards failed (must be 0)`);
// The baseline's failures are the point, so they are not counted as failures of this run — but a
// control where every state check PASSES means the checks measure nothing.
const pageBad = results.slice(0, mark).filter(r => !r.ok).length;
const vacuous = ctlStateFailed < ctlStateTotal || ctlGuardFailed > 0;
console.log(vacuous
  ? "FAIL  the control did not behave: state checks must all fail there and guards must all pass"
  : "OK    the control fails exactly the state checks and passes every guard");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
