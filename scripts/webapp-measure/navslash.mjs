import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE COMPOSER'S BRIDGE-COMMAND LAYER. A slash typed into a session chat used to have exactly two
// fates: a name slash-policy.ts recognised (refused with prose, or routed to a dial), or the CLI.
// `/files` was in NEITHER table, so it took the CLI path and the slash palette fuzzy-matched it —
// observed on the owner's screen, one predicate from running `/fable-method` in a live coding
// session. Now a bridge command with a destination in this app OPENS that destination.
//
// This file measures the CLIENT half: given the daemon's answer, does the right screen appear, and
// for `/files` does the sheet open at the right session's real folder. The SERVER half — which
// command maps to which destination — is slash-policy.test.ts.
//
// The two halves are joined rather than assumed: the route handler below does NOT hand-write the
// navigate payload. It shells out to bun ONCE and asks the real `planSlash` what each command plans,
// so a table edit that this script does not know about still drives it. A fixture would have let the
// two drift and still passed.
//
// CONTROL: the page pinned before this shipped. Every navigation must FAIL there — that page has no
// goNavigate, so it receives the same 200 and does nothing with it. Without that leg a green run
// would only prove the harness can click a button.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const BASELINE = process.env.NAVSLASH_BASELINE || "d25a7c7";   // last commit before the nav layer
const BASE = join(mkdtempSync(join(tmpdir(), "navslash-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const CWD = "/home/ubuntu/projects/cc-bridge";
const SESSION = { sid: "s1", name: "cc-bridge", cwd: CWD, alive: true, working: false, state: "idle",
  task: "Reading the transcript back", model: "Opus 5", effort: "high", ctxPct: 41, branch: "main", subagents: 0 };

// The REAL classifier, once, for every command this script exercises. Anything that is not a
// `navigate` comes back as its own kind and the checks below assert the page leaves it alone.
const COMMANDS = ["/files", "/sessions", "/settings", "/cron", "/voice", "/clear"];
const PLANS = JSON.parse(execFileSync("bun", ["-e", `
  const { planSlash } = await import(${JSON.stringify(join(REPO, "slash-policy.ts"))})
  const out = {}
  for (const c of ${JSON.stringify(COMMANDS)}) out[c] = planSlash(c)
  process.stdout.write(JSON.stringify(out))
`], { cwd: REPO }).toString());

let bad = 0;
const sink = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();

const serve = path => new Promise(res => {
  const html = readFileSync(path, "utf8");
  const srv = createServer((req, r) => {
    if (req.url === "/" || req.url.startsWith("/?")) { r.writeHead(200, { "content-type": "text/html" }); r.end(html); return }
    r.writeHead(404); r.end("");
  });
  srv.listen(0, "127.0.0.1", () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
});

const open = async path => {
  const { srv, url } = await serve(path);
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.route("**/telegram-web-app.js", r => r.abort());
  await p.addInitScript(() => {
    window.Telegram = { WebApp: { initData: "user=%7B%22id%22%3A1%7D&hash=x", initDataUnsafe: { user: { id: 1 } },
      ready() {}, expand() {}, close() {}, themeParams: {}, colorScheme: "dark", isExpanded: true,
      isFullscreen: false, viewportHeight: 812, onEvent() {}, offEvent() {}, isVersionAtLeast: () => true,
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
      BackButton: { isVisible: false, show() { this.isVisible = true }, hide() { this.isVisible = false }, onClick() {}, offClick() {} },
      SettingsButton: { isVisible: false, show() {}, hide() {}, onClick() {}, offClick() {} },
      showConfirm(_m, cb) { cb(true) },
    } };
    window.__acts = [];
  });
  await p.route("**/api/**", route => {
    const u = new URL(route.request().url());
    const j = d => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(d) });
    if (u.pathname === "/api/sessions") return j({ sessions: [SESSION] });
    if (u.pathname === "/api/settings") return j({ write: false, settings: { voice: { value: false, editable: false } } });
    if (u.pathname === "/api/auto") return j({ cron: [], queue: [] });
    // The drill-in's own cwd is HOME-ABBREVIATED, exactly as the daemon serves it. That is the trap
    // the wire's `cwd` exists to avoid: a root taken from this line cannot be resolved by /api/ls.
    if (u.pathname === "/api/session/feed") return j({ ...SESSION, cwd: "~/projects/cc-bridge", items: [] });
    if (u.pathname === "/api/ls") {
      const path = u.searchParams.get("path");
      return j({ path, write: false, parent: path.split("/").slice(0, -1).join("/") || "/",
        entries: path === CWD ? [{ name: "daemon.ts", type: "file", size: 900000 }] : [] });
    }
    if (u.pathname === "/api/session/act") {
      const body = JSON.parse(route.request().postData() || "{}");
      const plan = PLANS[String(body.text || "").trim()];
      // Mirrors daemon.ts: a navigate is a 200 that did nothing to the session, and the files target
      // carries the daemon's own absolute cwd. Everything else answers as an ordinary send.
      if (plan && plan.kind === "navigate") {
        return j({ navigate: { to: plan.to, note: plan.note, ...(plan.to === "files" ? { cwd: CWD } : {}) } });
      }
      return j({ ok: true });
    }
    return j({});
  });
  await p.goto(url + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);
  await p.evaluate(() => openDrill("s1", "cc-bridge"));
  await p.waitForTimeout(400);
  p.__srv = srv;
  return p;
};
const close = async p => { await p.close(); p.__srv.close(); };

const typeSend = async (p, text) => {
  await p.evaluate(() => { if (document.getElementById("drill").classList.contains("show")) return; openDrill("s1", "cc-bridge") });
  await p.fill("#dtext", text);
  await p.dispatchEvent("#dtext", "input");
  await p.waitForTimeout(120);
  await p.click("#dsend");
  await p.waitForTimeout(500);
};

// What the user can actually SEE afterwards. `.show` on a view is how showTab() switches, and the
// sheet's root is read from its crumb trail's own data — the same place the browser navigates from.
const screen = p => p.evaluate(() => {
  const shown = [...document.querySelectorAll(".tab")].filter(t => t.classList.contains("show")).map(t => t.id);
  const s = document.getElementById("fbrowse");
  const err = document.querySelector(".err");
  return {
    tabs: shown,
    drill: document.getElementById("drill").classList.contains("show"),
    sheet: !!s && s.classList.contains("show"),
    sheetRoots: s ? [...s.querySelectorAll(".crumbs a")].map(a => a.dataset.p) : [],
    toast: err && err.classList.contains("show") ? err.textContent : "",
  };
});

const run = async (path, live) => {
  const tag = live ? "live" : "control";
  // The control asserts the ABSENCE of every navigation, so it must SAY so — a control line reading
  // "OK [control] /files opens the sheet" is the same words as the live pass and invites exactly the
  // wrong conclusion, that the old page did it too and the run proves nothing.
  const expect = (got, label) => sink(live === got, live ? `[live] ${label}` : `[control] does NOT — ${label}`);
  let p = await open(path);

  // /files — THE REPORTED CASE. The sheet opens, and its root is the session's REAL folder, never the
  // `~`-abbreviated line the drill-in header shows.
  await typeSend(p, "/files");
  let s = await screen(p);
  expect(s.sheet, "/files opens the session-folder sheet");
  if (live) sink(s.sheetRoots.some(r => r === CWD), `[live] the sheet is rooted at the session's absolute cwd (${CWD})`);
  if (live) sink(!s.sheetRoots.some(r => String(r).startsWith("~")), "[live] no root came from the home-abbreviated subtitle");
  await close(p);

  // The three view targets. Each must leave the drill-in, which is an overlay above every view — a
  // switch underneath it would change a screen nobody can see.
  for (const [cmd, tab] of [["/sessions", "tab-sessions"], ["/settings", "tab-settings"], ["/cron", "tab-auto"]]) {
    p = await open(path);
    await typeSend(p, cmd);
    s = await screen(p);
    expect(s.tabs.includes(tab) && !s.drill, `${cmd} → ${tab}, drill-in closed`);
    await close(p);
  }

  // A REDIRECT says why; a self-evident destination does not. This app retired success bars on the
  // rule that a visible outcome needs no confirmation, so a note over the settings screen for
  // `/settings` would be exactly the bar that was retired.
  p = await open(path);
  await typeSend(p, "/voice");
  s = await screen(p);
  expect(s.tabs.includes("tab-settings") && /settings row/i.test(s.toast), "/voice → settings, and says why");
  await close(p);

  p = await open(path);
  await typeSend(p, "/settings");
  s = await screen(p);
  expect(s.tabs.includes("tab-settings") && !s.toast, "/settings navigates with NO note");
  await close(p);

  // The four ambiguous verbs stay pane-passed. `/clear` is the one with a real CLI meaning AND a real
  // button, so it is the control for "the layer did not swallow a session command": it must send, and
  // it must not navigate anywhere, on BOTH pages.
  p = await open(path);
  await typeSend(p, "/clear");
  s = await screen(p);
  sink(!s.sheet && s.drill && !s.tabs.includes("tab-settings"), `[${tag}] /clear still goes to the session, navigating nothing (same on both)`);
  await close(p);
};

console.log(`— live (${PAGE})`);
await run(PAGE, true);
console.log(`— control (${BASELINE}, before the nav layer)`);
await run(BASE, false);

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
