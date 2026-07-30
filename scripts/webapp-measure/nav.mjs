import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE NAV RESTRUCTURE (2026-07-30, owner-approved design note): Files stops being a global destination
// and becomes a sheet inside the session that owns the folder; the only globals left are the command
// center, Scheduled on its own pill, and Settings in the client's ⋮ menu. The tab row is DELETED, and
// notabs.mjs — which measured the row being hidden — is deleted with it, since a harness whose subject
// no longer exists cannot fail. Its two surviving claims (Settings reachable via ⋮, and back out of it)
// moved here as guards.
//
// This file serves the page over HTTP rather than file://, and that is load-bearing rather than tidier:
// the deep-link legs run through the app's OWN boot() → api() path, and `api()` builds
// `new URL(path, location.origin)`, which on a file:// page is the string "null" and throws. Over HTTP
// the routing under test is the real routing, with the API answered by a route handler.
//
// CONTROL: the page pinned before the restructure. Every state check must FAIL there; the guards held
// before and must hold after.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// e5fbc2d is the last commit with the tab row, the global Files view and no Scheduled pill.
const BASELINE = process.env.NAV_BASELINE || "e5fbc2d";
const BASE = join(mkdtempSync(join(tmpdir(), "nav-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const CWD = "/home/ubuntu/projects/cc-bridge";
const SESSION = { sid: "s1", name: "cc-bridge", cwd: CWD, alive: true, working: false, state: "idle",
  task: "Reading the transcript back", model: "Opus 5", effort: "high", ctxPct: 41, branch: "main", subagents: 0 };
// The folder tree the file API serves. Two levels, so descending and `..` are both real.
const TREE = {
  [CWD]: [{ name: "webapp", type: "dir" }, { name: "daemon.ts", type: "file", size: 900000 }],
  [`${CWD}/webapp`]: [{ name: "index.html", type: "file", size: 278456 }],
};

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// One server per page-under-test, so `data-files="off"` can be injected exactly the way the daemon does
// it (webapp.ts rewrites `<body>` on the way out) rather than by poking the DOM afterwards.
const serve = (path, filesOff) => new Promise(res => {
  const html = readFileSync(path, "utf8").replace("<body>", filesOff ? '<body data-files="off">' : "<body>");
  const srv = createServer((req, r) => {
    if (req.url === "/" || req.url.startsWith("/?")) { r.writeHead(200, { "content-type": "text/html" }); r.end(html); return }
    r.writeHead(404); r.end("");
  });
  srv.listen(0, "127.0.0.1", () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
});

const open = async (path, { query = "", filesOff = false, sessions = [SESSION] } = {}) => {
  const { srv, url } = await serve(path, filesOff);
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.route("**/telegram-web-app.js", r => r.abort());
  await p.addInitScript(() => {
    window.__bb = { shown: 0, hidden: 0, handlers: [] };
    window.__sb = { handlers: [] };
    window.Telegram = { WebApp: { initData: "user=%7B%22id%22%3A1%7D&hash=x", initDataUnsafe: { user: { id: 1 } },
      ready() {}, expand() {}, close() {}, themeParams: {}, colorScheme: "dark", isExpanded: true,
      isFullscreen: false, viewportHeight: 812, onEvent() {}, offEvent() {}, isVersionAtLeast: () => true,
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
      BackButton: { isVisible: false, show() { window.__bb.shown++; this.isVisible = true },
        hide() { window.__bb.hidden++; this.isVisible = false }, onClick(f) { window.__bb.handlers.push(f) }, offClick() {} },
      SettingsButton: { isVisible: false, show() { this.isVisible = true }, hide() {}, onClick(f) { window.__sb.handlers.push(f) }, offClick() {} },
      showConfirm(_m, cb) { cb(true) },
    } };
  });
  // The whole file API, answered off TREE. `/api/resolve` maps a token to the folder AND the session,
  // which is the daemon's new contract; `tok-nosession` is the leg where nothing matches.
  await p.route("**/api/**", route => {
    const u = new URL(route.request().url());
    const j = d => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(d) });
    if (u.pathname === "/api/sessions") return j({ sessions });
    if (u.pathname === "/api/settings") return j({ write: false, settings: { voice: { value: false, editable: false } } });
    if (u.pathname === "/api/auto") return j({ cron: [], queue: [] });
    if (u.pathname === "/api/session/feed") return j({ ...SESSION, cwd: "~/projects/cc-bridge", items: [] });
    if (u.pathname === "/api/resolve") {
      const t = u.searchParams.get("token");
      return t === "tok-nosession" ? j({ cwd: "/home/ubuntu/elsewhere" }) : j({ cwd: CWD, sid: "s1" });
    }
    if (u.pathname === "/api/ls") {
      const path = u.searchParams.get("path");
      const entries = TREE[path] || [];
      return j({ path, write: false, parent: path.split("/").slice(0, -1).join("/") || "/", entries });
    }
    if (u.pathname === "/api/read") return j({ content: "<!doctype html>", mtime: 1, binary: false });
    return j({});
  });
  await p.goto(url + "/" + query, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);   // boot() is async: resolve → sessions → the sheet
  p.__srv = srv;
  return p;
};
const close = async p => { await p.close(); p.__srv.close(); };

const sheet = p => p.evaluate(() => {
  const s = document.getElementById("fbrowse");
  return {
    open: !!s && s.classList.contains("show"),
    crumbs: s ? [...s.querySelectorAll(".crumbs a")].map(a => a.textContent) : [],
    roots: s ? [...s.querySelectorAll(".crumbs a")].map(a => a.dataset.p) : [],
    rows: s ? [...s.querySelectorAll("#fblist li")].map(l => l.textContent) : [],
    root: typeof fbHost === "object" ? fbHost.root : null,
  };
});

async function measure(path, label, shotPrefix) {
  const state = (ok, l) => sink("state", ok, `${label}: ${l}`);
  const guard = (ok, l) => sink("guard", ok, `${label}: ${l}`);

  // ---- 1. the tab row is GONE, not hidden -------------------------------------------------------
  {
    const p = await open(path);
    const dom = await p.evaluate(() => {
      document.documentElement.style.setProperty("--safe-top", "56px");
      return { tabs: !!document.getElementById("tabs"), tabsAny: document.querySelectorAll(".tabs").length,
        filesView: !!document.getElementById("tab-files"), search: !!document.getElementById("q"),
        // The strip the row used to carry now belongs to body; forced, because --safe-top is 0 in every
        // non-fullscreen state and this regression is invisible at rest.
        bodyPad: getComputedStyle(document.body).paddingTop };
    });
    state(!dom.tabs && dom.tabsAny === 0 && !dom.filesView && !dom.search,
      `no tab row, no global Files view, no recursive search left in the DOM (${JSON.stringify(dom)})`);
    // A GUARD: the strip was already being carried (the hidden row's own rule did it), so what must not
    // change is that SOMETHING carries it now that the row is deleted.
    guard(dom.bodyPad === "56px", `body carries the --safe-top strip the row used to (${dom.bodyPad})`);
    guard(await p.evaluate(() => curTab === "sessions" && document.getElementById("tab-sessions").classList.contains("show")),
      "the command center is the view on open");
    await close(p);
  }

  // ---- 2. the paperclip's sheet: three cards, and the relabel ------------------------------------
  {
    const p = await open(path);
    await p.evaluate(() => openDrill("s1", "cc-bridge"));
    await p.waitForTimeout(500);
    await p.evaluate(() => document.getElementById("datt").click());
    await p.waitForTimeout(400);
    const cards = await p.$$eval("#addctx .ctxcard span", n => n.map(x => x.textContent));
    state(cards.join("/") === "Photos/Device/Session folder",
      `the sheet asks WHERE FROM in three answers, with the device card renamed (${cards.join(" · ")})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-attach-sheet.png`), clip: { x: 0, y: 470, width: 390, height: 342 } });

    // ---- 3. …and the browse card opens the session's folder, scoped ------------------------------
    // The card does not exist on the control page, and reaching for it there would throw and take the
    // whole run down — so its absence FAILS these three checks, which is the verdict it deserves.
    const hasCard = await p.evaluate(() => !!document.getElementById("ctxbrowse"));
    if (!hasCard) {
      state(false, "the browse card is not on this page, so nothing opens the session's folder");
      state(false, "…and there is no scope to keep at a root that does not exist");
      state(false, "…nor a trail to descend");
      state(false, "…nor a file to open into the viewer from it");
      await close(p);
      return afterAttach(path, label, shotPrefix, state, guard);
    }
    await p.evaluate(() => document.getElementById("ctxbrowse").click());
    await p.waitForTimeout(600);
    const at = await sheet(p);
    state(at.open && at.root === "/home/ubuntu/projects/cc-bridge" && at.crumbs[0] === "cc-bridge",
      `it opens a sheet rooted at the session's own cwd (root ${at.root}, crumbs ${at.crumbs.join(" › ")})`);
    state(!at.rows.some(r => r.includes("..")),
      `and there is no row out of the scope at its root (${at.rows.map(r => r.trim()).join(" | ")})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-files-sheet.png`), clip: { x: 0, y: 380, width: 390, height: 432 } });
    // Descend: `..` appears, and it cannot walk above the root.
    await p.evaluate(() => [...document.querySelectorAll("#fblist li")].find(l => l.textContent.includes("webapp")).click());
    await p.waitForTimeout(500);
    const deep = await sheet(p);
    state(deep.crumbs.join("›") === "cc-bridge›webapp" && deep.rows.some(r => r.includes("..")),
      `descending keeps the trail inside the scope and offers the way back up (${deep.crumbs.join(" › ")})`);
    // A file opens the viewer, and the sheet must get out from over it (sheets are z 9, the viewer 6).
    await p.evaluate(() => [...document.querySelectorAll("#fblist li")].find(l => l.textContent.includes("index.html")).click());
    await p.waitForTimeout(600);
    const viewer = await p.evaluate(() => ({ viewer: document.getElementById("viewer").classList.contains("show"),
      sheet: document.getElementById("fbrowse").classList.contains("show") }));
    state(viewer.viewer && !viewer.sheet,
      `a file opens in the viewer with the sheet out of the way (viewer ${viewer.viewer}, sheet ${viewer.sheet})`);
    await close(p);
  }

  return afterAttach(path, label, shotPrefix, state, guard);
}

// Everything after the attach sheet, factored out for one reason: the control page has no browse card,
// and the block above has to be able to record that and carry on rather than throw.
async function afterAttach(path, label, shotPrefix, state, guard) {
  // ---- 4. Scheduled: its own pill on the rail ---------------------------------------------------
  {
    const p = await open(path);
    const rail = await p.evaluate(() => {
      const q = document.getElementById("schedfab"), n = document.getElementById("newfab");
      if (!q) return null;
      const qr = q.getBoundingClientRect(), nr = n.getBoundingClientRect();
      const cs = getComputedStyle(q);
      return { shown: cs.display !== "none", square: Math.abs(qr.width - qr.height) < 0.5,
        overlaps: qr.right > nr.left && qr.left < nr.right, label: q.textContent.trim(),
        fill: cs.backgroundColor, blue: getComputedStyle(n).backgroundColor,
        sameFloor: Math.abs(qr.bottom - nr.bottom) < 0.5 };
    });
    state(!!rail && rail.shown && rail.square && !rail.overlaps && rail.label === "" && rail.sameFloor && rail.fill !== rail.blue,
      `Scheduled is a square, icon-only, unfilled pill on the same floor as the blue one and never over it (${JSON.stringify(rail)})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-command-center.png`) });
    // Absent on the control page, and reaching for it would throw — so the two checks it owns fail
    // there, which is the verdict.
    if (!rail) {
      state(false, "there is no Scheduled pill to tap on this page");
      state(false, "…and therefore no ← out of a view it cannot open");
    } else await p.evaluate(() => document.getElementById("schedfab").click());
    await p.waitForTimeout(500);
    if (rail) {
    const on = await p.evaluate(() => ({ cur: curTab, back: window.Telegram.WebApp.BackButton.isVisible,
      pills: [document.getElementById("newfab").classList.contains("show"), document.getElementById("schedfab").classList.contains("show")] }));
    state(on.cur === "auto" && on.back && !on.pills[0] && !on.pills[1],
      `tapping it opens Scheduled, raises the client's ← and takes both pills off screen (${JSON.stringify(on)})`);
    await p.evaluate(() => window.__bb.handlers[0]());
    await p.waitForTimeout(500);
    state(await p.evaluate(() => curTab === "sessions" && !window.Telegram.WebApp.BackButton.isVisible),
      "…and ← is the way back out of it");
    }
    // Settings, the third destination — notabs.mjs's surviving claims, carried as guards.
    guard(await p.evaluate(() => window.__sb.handlers.length === 1 && window.Telegram.WebApp.SettingsButton.isVisible),
      "Settings is still asked of the client's ⋮ menu, exactly once");
    await p.evaluate(() => window.__sb.handlers[0]());
    await p.waitForTimeout(400);
    guard(await p.evaluate(() => curTab === "settings"), "…and that item still opens the Settings view");
    await close(p);
  }

  // ---- 5. deep links ---------------------------------------------------------------------------
  {
    // WITH a matching session (the /files link's own shape): the session opens and its sheet is raised.
    const p = await open(path, { query: `?start=${encodeURIComponent(CWD + "/webapp")}&sid=s1` });
    const linked = await sheet(p);
    const drill = await p.evaluate(() => document.getElementById("drill").classList.contains("show"));
    state(drill && linked.open && linked.root === CWD && linked.crumbs.join("›") === "cc-bridge›webapp",
      `a /files link opens the session that owns the folder and lands in it (drill ${drill}, at ${linked.crumbs.join(" › ")})`);
    await close(p);
  }
  {
    // …and with NOTHING matching: the sheet stands alone over the command center, at the right folder.
    const p = await open(path, { query: "?start=%2Fhome%2Fubuntu%2Felsewhere" });
    const alone = await sheet(p);
    const drill = await p.evaluate(() => document.getElementById("drill").classList.contains("show"));
    state(!drill && alone.open && alone.root === "/home/ubuntu/elsewhere",
      `a link with no matching session opens the sheet standalone over the command center, at that folder (drill ${drill}, root ${alone.root})`);
    if (OUT) await p.screenshot({ path: join(OUT, `${shotPrefix}-deeplink-standalone.png`), clip: { x: 0, y: 380, width: 390, height: 432 } });
    await close(p);
  }
  {
    // The startapp token path, which is where the sid now rides.
    const p = await open(path, { query: "" });
    const viaToken = await p.evaluate(async () => {
      const r = await api("/api/resolve", { token: "tok-abc" });
      return r;
    });
    guard(viaToken.cwd === CWD && viaToken.sid === "s1", `/api/resolve hands back the folder AND its session (${JSON.stringify(viaToken)})`);
    await close(p);
  }

  // ---- 6. the file browser turned off server-side ----------------------------------------------
  {
    const p = await open(path, { filesOff: true });
    await p.evaluate(() => openDrill("s1", "cc-bridge"));
    await p.waitForTimeout(500);
    await p.evaluate(() => document.getElementById("datt").click());
    await p.waitForTimeout(300);
    const off = await p.evaluate(() => ({ card: !!document.getElementById("ctxbrowse"),
      cards: [...document.querySelectorAll("#addctx .ctxcard span")].map(x => x.textContent) }));
    state(!off.card && off.cards.join("/") === "Photos/Device",
      `with the browser off server-side the browse card is REMOVED, not left dead (${off.cards.join(" · ")})`);
    await close(p);
  }
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (tab row, global Files, one pill) ---`);
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
  ? "FAIL  the control did not behave: every state check must fail there and every guard must pass"
  : "OK    the control fails every state check and keeps every guard");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
