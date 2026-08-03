import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE GREEN BAR IS GONE AND THE RED ONE IS NOT. The owner, 2026-07-30, on a green "Spawned test"
// sliding over his session list: the surface behind the bar already shows the outcome, so the bar
// repeated what the eye had. Failures keep theirs — an action failing silently is worse than a
// redundant confirmation — and that boundary is the whole risk in this change, so it is what this
// measures.
//
// Every case drives the app's OWN write path with `fetch` stubbed, because that is where the branch
// lives (writeOp raises the red bar itself on !ok). Three claims per retired action, and the middle one
// is the one a careless removal breaks:
//
//   1. no bar at all — asserted on the RENDERED element (display + the `.ok` class), not on whether a
//      function was called;
//   2. the OUTCOME still reaches the screen — a new card, a dropped card, a repainted value. Removing a
//      confirmation is only safe because something else says the same thing; if that something is
//      absent the removal is a silent action, which is exactly what the owner did not ask for;
//   3. the failure path still raises the RED bar with the server's own reason.
//
// Plus the one green bar that STAYS: the dial's "… requested…" is not a confirmation — an effort change
// can sit behind Claude Code's own confirm for seconds, so it reports a request, not an outcome. It was
// classified ambiguous and left alone, and this file pins that it still fires (a blanket no-op inside
// showOk would have taken it out silently).
//
// CONTROL: the page pinned before the change. Every "no bar" check MUST fail there — the bars were the
// behaviour — and every outcome + failure check must PASS, since neither was meant to move.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// cf999f2 is the last commit whose successful actions raised a green bar.
const BASELINE = process.env.TOASTS_BASELINE || "cf999f2";
const BASE = join(mkdtempSync(join(tmpdir(), "toasts-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const SESSION = { sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: false,
  state: "idle", task: "Reading the transcript back", model: "Opus 5", effort: "high", ctxPct: 41, branch: "main", subagents: 0 };
const SPAWNED = { ...SESSION, sid: "s2", name: "test", cwd: "~/projects/test", task: null };

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// One page per case: a toast lingers 2.5–4s and cases sharing a page would read each other's bar.
// `fetch` is stubbed rather than `api`/`writeOp` — those two are where the ok/error branch lives, and
// stubbing them would replace the code under test.
const open = async (path, opts = {}) => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.route("**/telegram-web-app.js", r => r.abort());
  await p.addInitScript(() => {
    window.Telegram = { WebApp: { initData: "user=%7B%22id%22%3A1%7D&hash=x", initDataUnsafe: { user: { id: 1 } },
      ready() {}, expand() {}, close() {}, themeParams: {}, colorScheme: "dark", isExpanded: true,
      isFullscreen: false, viewportHeight: 812, onEvent() {}, offEvent() {}, isVersionAtLeast: () => true,
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
      BackButton: { show() {}, hide() {}, onClick() {} },
      SettingsButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
      // Every confirm in this app answers YES here: the dialogs are not what is under test, and an
      // unanswered one would stall the action before it could raise (or not raise) a bar.
      showConfirm(_m, cb) { cb(true); },
      showPopup(_o, cb) { cb && cb("rename"); },
    } };
  });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(([session, spawned, fail]) => {
    // What the fixture serves, mutated by the actions themselves — that is how the OUTCOME checks stay
    // honest: the client re-reads and must render the new truth.
    window.__state = { sessions: [session], settings: { confirmReset: { value: false, editable: true, label: "off" } } };
    window.__posts = [];
    const json = d => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    window.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (init && init.method === "POST") {
        const body = JSON.parse(init.body || "{}");
        window.__posts.push({ url, body });
        // The failure leg: the server refuses with its own reason, which the red bar must carry.
        if (fail) return new Response(JSON.stringify({ reason: "pane is gone" }), { status: 400, headers: { "content-type": "application/json" } });
        if (url.includes("/api/session/spawn")) { window.__state.sessions.push(spawned); return json({ sid: spawned.sid, name: spawned.name }) }
        if (url.includes("/api/session/act")) {
          if (body.action === "close") window.__state.sessions = window.__state.sessions.filter(s => s.sid !== body.sid);
          return json({ ok: true });
        }
        if (url.includes("/api/settings/set")) { window.__state.settings[body.key] = { value: body.value, editable: true, label: String(body.value) }; return json({ ok: true }) }
        return json({ ok: true });
      }
      if (url.includes("/api/sessions")) return json({ sessions: window.__state.sessions });
      // `rows` is the served structure the settings screen renders (settingsRows() in daemon.ts) —
      // the client holds no order of its own, so a payload without it renders an empty screen and
      // the toggle below would have nothing to click.
      if (url.includes("/api/settings")) return json({ write: true, rows: [{ id: "confirmReset", name: "🧹 /clear approval", keys: ["confirmReset"] }], settings: window.__state.settings });
      if (url.includes("/api/session/feed")) return json({ sid: session.sid, name: session.name, working: false, state: "idle", items: [] });
      if (url.includes("/api/auto")) return json({ cron: [], queue: [] });
      return json({});
    };
    showTab("sessions");
  }, [SESSION, SPAWNED, !!opts.fail]);
  await p.waitForTimeout(500);
  return p;
};

// The bar as RENDERED: its display, its colour class, and its text. `display` is read because `.show`
// is what makes it visible and a class check alone would pass on a bar whose rule changed.
const bar = page => page.evaluate(() => {
  const e = document.getElementById("err");
  const st = getComputedStyle(e);
  return { shown: st.display !== "none", ok: e.classList.contains("ok"), text: e.textContent, bg: st.backgroundColor };
});
const cardNames = page => page.$$eval("#tab-sessions .sess .nm", ns => ns.map(n => n.textContent));

async function measure(path, label, shotPrefix) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);

  // ---- spawn: the bar he screenshotted -----------------------------------------------------------
  {
    const p = await open(path);
    await p.evaluate(async () => { openSpawnSheet(); document.getElementById("spname").value = "test"; });
    await p.waitForTimeout(300);
    await p.evaluate(() => document.getElementById("spgo").click());
    await p.waitForTimeout(900);
    const t = await bar(p);
    state(!t.shown, `a successful SPAWN raises no bar (shown ${t.shown}, text ${JSON.stringify(t.text)})`);
    guard((await cardNames(p)).includes("test"), `…and the new session is a card, which is what says the outcome (${(await cardNames(p)).join(", ")})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-spawn.png`), clip: { x: 0, y: 512, width: 390, height: 300 } });
    await p.close();
  }
  // ---- close a session --------------------------------------------------------------------------
  {
    const p = await open(path);
    await p.evaluate(() => document.querySelector("#tab-sessions .sess .cardx").click());
    await p.waitForTimeout(900);
    const t = await bar(p);
    state(!t.shown, `a successful CLOSE raises no bar (shown ${t.shown}, text ${JSON.stringify(t.text)})`);
    guard(!(await cardNames(p)).includes("cc-bridge"), `…and the card is gone from the list (${(await cardNames(p)).join(", ") || "empty"})`);
    await p.close();
  }
  // ---- a settings toggle ------------------------------------------------------------------------
  {
    const p = await open(path);
    await p.evaluate(async () => { await showTab("settings"); });
    await p.waitForTimeout(400);
    await p.evaluate(() => [...document.querySelectorAll("#tab-settings .toggle")].pop().click());
    await p.waitForTimeout(900);
    const t = await bar(p);
    state(!t.shown, `a successful SETTINGS write raises no bar (shown ${t.shown}, text ${JSON.stringify(t.text)})`);
    // The toggle's own label is the outcome: Off → On, repainted from the re-read payload.
    const repainted = await p.evaluate(() => [...document.querySelectorAll("#tab-settings .toggle")].pop().textContent);
    guard(repainted === "On", `…and the row repaints with the value the write set (${repainted})`);
    await p.close();
  }
  // The INTERRUPT case that used to sit here is gone with the control: v0.4.270 removed the drill-in's
  // pause chip entirely (the owner's ask), so there is no longer a site to silence — the retired family
  // is 10 sites, not 11, and its `showDone("Interrupted")` went with the handler.
  // ---- the failure leg, on the same action ------------------------------------------------------
  {
    // Driven through SPAWN now that the pause chip is gone. Same writeOp path, which is where the
    // ok/error branch actually lives, so the leg proves the same thing it did through interrupt.
    const p = await open(path, { fail: true });
    await p.evaluate(async () => { openSpawnSheet(); document.getElementById("spname").value = "test"; });
    await p.waitForTimeout(300);
    await p.evaluate(() => document.getElementById("spgo").click());
    await p.waitForTimeout(700);
    const t = await bar(p);
    guard(t.shown && !t.ok && t.text.includes("pane is gone"),
      `a FAILED action still raises the red bar, carrying the server's reason (shown ${t.shown}, ok ${t.ok}, ${JSON.stringify(t.text)}, ${t.bg})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-failure.png`), clip: { x: 0, y: 512, width: 390, height: 300 } });
    await p.close();
  }
  // ---- the ambiguous one that STAYS ------------------------------------------------------------
  {
    const p = await open(path);
    await p.evaluate(() => openDrill("s1", "cc-bridge"));
    await p.waitForTimeout(600);
    await p.evaluate(() => applyDial("effort", "low"));
    await p.waitForTimeout(700);
    const t = await bar(p);
    guard(t.shown && t.ok && /requested/.test(t.text),
      `the dial's "requested…" notice still fires and is still green — it reports a REQUEST, not an outcome (shown ${t.shown}, ok ${t.ok}, ${JSON.stringify(t.text)})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-dial-request.png`), clip: { x: 0, y: 512, width: 390, height: 300 } });
    await p.close();
  }
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (every success still bar-ed) ---`);
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
  ? "FAIL  the control did not behave: every no-bar check must fail there, and every outcome/failure check must pass"
  : "OK    the control raises a bar for every retired confirmation and keeps every outcome and failure");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
