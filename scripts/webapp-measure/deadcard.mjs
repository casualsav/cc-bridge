import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A killed session leaves the fleet list, and a revived one comes back. Driven END TO END against a
// REAL throwaway session it spawns, kills and reopens, reading BOTH surfaces at once: the live
// /api/sessions the tab polls, and the tab as it actually renders on the shipped page.
//
//   node deadcard.mjs [outdir]
//
// Two controls, and they are the point:
//   · a session that stays LIVE the whole run must never leave either surface (the failure mode of
//     a too-eager filter is invisible in a one-session test)
//   · the timings are printed, not asserted away — a "prompt" that is 35s is the bug this fixes, so
//     the check is on the measured seconds, and a pre-fix daemon fails it rather than passing slowly.
//
// Same initData minting as minislash.mjs (this box's bot token, the HMAC the server checks), and the
// same **/telegram-web-app.js route abort — without it the real SDK replaces window.Telegram,
// initData comes back empty, and every read measures the sign-in screen instead of the app.

const OUT = process.argv[2] || mkdtempSync(join(tmpdir(), "deadcard-"));
const ENVF = "/home/ubuntu/.claude/channels/telegram/.env";
const env = Object.fromEntries(readFileSync(ENVF, "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const BASE = `http://127.0.0.1:${env.TELEGRAM_WEBAPP_PORT || "8795"}`;
const OWNER = process.env.DEADCARD_USER || "837047563";

function initData(userId) {
  const params = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "deadcard",
    user: JSON.stringify({ id: Number(userId), first_name: "harness", username: "harness" }) };
  const check = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  return new URLSearchParams({ ...params, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const apiSessions = async () => {
  const r = await fetch(new URL("/api/sessions", BASE), { headers: { Authorization: "tma " + initData(OWNER) } });
  return (await r.json()).sessions ?? [];
};

const NAME = "deadcardprobe";
sh("mkdir", ["-p", `/tmp/${NAME}`]);
console.log(sh("tg", ["spawn", NAME, "--dir", `/tmp/${NAME}`, "--model", "haiku"]));
let probe = null;
for (let i = 0; i < 20 && !probe; i++) { await sleep(3000); probe = (await apiSessions()).find(s => s.name === NAME) ?? null }
if (!probe) { console.log("FAIL  the probe session never appeared"); process.exit(1) }
const sid = probe.sid;
// The control: some OTHER session that is live right now and stays live for the whole run.
const control = (await apiSessions()).find(s => s.sid !== sid && s.alive);
if (!control) { console.log("FAIL  no second live session to use as the untouched control"); process.exit(1) }
console.log(`probe sid=${sid}  control="${control.name}" ${control.sid.slice(0, 8)}`);

// ---- the tab, on the shipped page, from the live server ----
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
page.on("pageerror", e => console.log("PAGEERROR:", e.message));
await page.route("**/telegram-web-app.js", r => r.abort());
await page.addInitScript(d => {
  window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, ready() {}, expand() {}, close() {},
    themeParams: {}, colorScheme: "dark", isExpanded: true, viewportHeight: 812,
    onEvent() {}, offEvent() {}, HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
    BackButton: { show() {}, hide() {}, onClick() {} } } };
}, initData(OWNER));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

// What the RENDERED tab says: the card names it is showing, read out of the DOM.
const tabNames = () => page.$$eval("#tab-sessions .sess .nm", ns => ns.map(n => n.textContent));
// The control is followed by SID, never by name: a DM chat lane renders as `Chat (DM <id>)` until the
// handle cache warms and `Chat (@handle)` after, so a name comparison reported the control "gone" on a
// run right after a daemon restart while its card was on screen the whole time. The client's own
// SESSIONS array is what it last rendered, and the DOM count is the guard that it really did render.
const tabHasSid = async sid => await page.evaluate(s =>
  SESSIONS.some(x => x.sid === s) && document.querySelectorAll("#tab-sessions .sess").length === SESSIONS.length, sid);
const shot = name => page.screenshot({ path: join(OUT, name), fullPage: false });

let names = await tabNames();
check(names.includes(NAME), `the live probe is a card in the rendered tab (${names.join(", ")})`);
check(await tabHasSid(control.sid), "the control session is a card too");
await shot("1-alive.png");

// ---- kill it, and time BOTH surfaces out ----
console.log("--- killing ---");
const t0 = Date.now();
console.log(sh("tg", ["kill", NAME]));
let apiGoneMs = null, tabGoneMs = null, deadCardSeen = false;
for (let i = 0; i < 40 && (apiGoneMs === null || tabGoneMs === null); i++) {
  const ss = await apiSessions();
  const row = ss.find(s => s.sid === sid);
  // A corpse the API served — the bug, if it happens. Shot on sight: on a pre-fix daemon this is the
  // 💀 card, and a picture of the defect is worth more than the count of how long it lingered.
  if (row && row.alive === false) { if (!deadCardSeen) await shot("0-corpse.png"); deadCardSeen = true }
  if (!row && apiGoneMs === null) apiGoneMs = Date.now() - t0;
  if (!(await tabNames()).includes(NAME) && tabGoneMs === null) tabGoneMs = Date.now() - t0;
  if (apiGoneMs !== null && tabGoneMs !== null) break;
  // The control must not blink out at ANY point while we wait — checked on every pass, not just at the end.
  if (!ss.some(s => s.sid === control.sid && s.alive)) { check(false, `the control left /api/sessions at t+${Math.round((Date.now() - t0) / 1000)}s`); break }
  await sleep(1500);
}
console.log(`api gone after ${apiGoneMs === null ? "NEVER" : (apiGoneMs / 1000).toFixed(1) + "s"} · tab gone after ${tabGoneMs === null ? "NEVER" : (tabGoneMs / 1000).toFixed(1) + "s"}`);
await shot("2-killed.png");
check(apiGoneMs !== null && apiGoneMs < 15000, `the killed session is off /api/sessions promptly (${apiGoneMs === null ? "never" : (apiGoneMs / 1000).toFixed(1) + "s"}, want <15s)`);
check(tabGoneMs !== null && tabGoneMs < 20000, `its card is off the rendered tab promptly (${tabGoneMs === null ? "never" : (tabGoneMs / 1000).toFixed(1) + "s"}, want <20s, tab polls every 4s)`);
check(!deadCardSeen, "no 💀 dead card was ever served while it went (a corpse is what this removes)");
check(await tabHasSid(control.sid), "the control card is untouched by the kill");

// ---- revive: the same sid comes back, so the card must come back with it ----
console.log("--- reopening ---");
const t1 = Date.now();
console.log(sh("tg", ["reopen", NAME]));
let apiBackMs = null, tabBackMs = null;
for (let i = 0; i < 40 && (apiBackMs === null || tabBackMs === null); i++) {
  const ss = await apiSessions();
  if (ss.some(s => s.sid === sid && s.alive) && apiBackMs === null) apiBackMs = Date.now() - t1;
  if ((await tabNames()).includes(NAME) && tabBackMs === null) tabBackMs = Date.now() - t1;
  if (apiBackMs !== null && tabBackMs !== null) break;
  await sleep(2000);
}
console.log(`api back after ${apiBackMs === null ? "NEVER" : (apiBackMs / 1000).toFixed(1) + "s"} · tab back after ${tabBackMs === null ? "NEVER" : (tabBackMs / 1000).toFixed(1) + "s"}`);
await shot("3-revived.png");
check(apiBackMs !== null, `the revived session is listed again (${apiBackMs === null ? "never" : (apiBackMs / 1000).toFixed(1) + "s"})`);
check(tabBackMs !== null, `its card is back on the rendered tab (${tabBackMs === null ? "never" : (tabBackMs / 1000).toFixed(1) + "s"})`);

// ---- the restart's OTHER shape: the pane survives and only claude bounces in it ----
// `/restart` relaunches in place when the pane outlives the /exit, and respawns into a new pane when
// it doesn't (restartPaneSessionCore). The reopen above is the respawn shape; this is the in-place
// one, and it is also the only case that produces a BARE-SHELL corpse — pane alive, stamps intact,
// claude gone — which nothing in the daemon ever reaps. Driven with the same keys the daemon uses.
const pane = sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id} #{@tg_session}' | awk '$2 ~ /^${sid}/ {print $1}'`]);
if (!pane) { check(false, "could not find the revived probe's pane for the in-place bounce") }
else {
  console.log(`--- in-place bounce of ${pane} ---`);
  const t2 = Date.now();
  sh("tmux", ["send-keys", "-t", pane, "/exit", "Enter"]);
  let bareGoneMs = null;
  for (let i = 0; i < 30 && bareGoneMs === null; i++) {
    if (!(await apiSessions()).some(s => s.sid === sid)) bareGoneMs = Date.now() - t2;
    else await sleep(1500);
  }
  // Pane existence off `list-panes`, not `display -p -t <dead pane>`: that returned an empty string
  // with a zero exit status here, so a `|| echo gone` fallback never fired and the next command ran
  // against a pane that had been gone for seconds.
  const cmd = sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id} #{pane_current_command}' | awk '$1 == "${pane}" {print $2}' || true`]) || "gone";
  console.log(`pane now runs "${cmd}" · listing gone after ${bareGoneMs === null ? "NEVER" : (bareGoneMs / 1000).toFixed(1) + "s"}`);
  check(bareGoneMs !== null && bareGoneMs < 15000, `an exited session leaves the list too (${bareGoneMs === null ? "never" : (bareGoneMs / 1000).toFixed(1) + "s"})`);
  await page.waitForTimeout(5000);   // one full tab poll, or the shot shows the card the API has already dropped
  await shot("4-exited.png");
  // …and comes back when claude is relaunched into that same stamped pane. Only reachable if the pane
  // OUTLIVED its claude — a spawned window whose /exit takes the pane with it is the respawn shape
  // again, already covered above, so say so rather than failing a check that no longer applies.
  if (cmd === "gone") console.log("note: the pane died with claude — in-place relaunch not applicable on this launch shape");
  else {
  const t3 = Date.now();
  sh("tmux", ["send-keys", "-t", pane, `cd /tmp/${NAME} && claude --allow-dangerously-skip-permissions --model haiku`, "Enter"]);
  let backMs = null;
  for (let i = 0; i < 40 && backMs === null; i++) {
    if ((await apiSessions()).some(s => s.sid === sid && s.alive)) backMs = Date.now() - t3;
    else await sleep(2000);
  }
  console.log(`relaunched pane listed again after ${backMs === null ? "NEVER" : (backMs / 1000).toFixed(1) + "s"}`);
  check(backMs !== null, `the bounced session is listed again (${backMs === null ? "never" : (backMs / 1000).toFixed(1) + "s"})`);
  await page.waitForTimeout(5000);
  await shot("5-bounced-back.png");
  }
}
check(await tabHasSid(control.sid), "the control card survived the whole run");

await b.close();
console.log(sh("tg", ["kill", NAME]));
console.log(`shots → ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
