import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Slash commands typed into a mini app session chat, driven END TO END: the SHIPPED page, loaded
// from the LIVE webapp server, text typed into the real composer, the real send button clicked,
// against a REAL throwaway session it spawns and kills.
//
// Nothing here is stubbed — no window.api override, no fixture transcript. That is the point: every
// defect this replaces was invisible to a stubbed harness, because the bug was in what the pane and
// the transcript did, not in what the client drew.
//
//   node minislash.mjs [outdir]
//
// It mints its own Mini App initData with this box's bot token (the same HMAC the server checks),
// so it authenticates exactly as the real app does. Operator-side only.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const OUT = process.argv[2] || mkdtempSync(join(tmpdir(), "minislash-"));
const ENVF = "/home/ubuntu/.claude/channels/telegram/.env";
const env = Object.fromEntries(readFileSync(ENVF, "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const PORT = env.TELEGRAM_WEBAPP_PORT || "8795";
const BASE = `http://127.0.0.1:${PORT}`;
const SETTINGS = "/home/ubuntu/.claude/settings.json";

function initData(userId) {
  const params = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "minislash",
    user: JSON.stringify({ id: Number(userId), first_name: "harness", username: "harness" }) };
  const check = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  return new URLSearchParams({ ...params, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}
const OWNER = process.env.MINISLASH_USER || "837047563";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- a real throwaway session ----
const NAME = "minislashprobe";
sh("mkdir", ["-p", `/tmp/${NAME}`]);
console.log(sh("tg", ["spawn", NAME, "--dir", `/tmp/${NAME}`, "--model", "haiku"]));
let sid = null;
for (let i = 0; i < 15 && !sid; i++) {
  await sleep(3000);
  const r = await fetch(new URL("/api/sessions", BASE), { headers: { Authorization: "tma " + initData(OWNER) } });
  const d = await r.json().catch(() => null);
  sid = d?.sessions?.find(s => s.name === NAME)?.sid ?? null;
}
if (!sid) { console.log("FAIL  the probe session never appeared"); process.exit(1); }
console.log(`probe sid=${sid}`);

const b = await chromium.launch();
async function openApp(userId = OWNER) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => console.log("PAGEERROR:", e.message));
  // The page loads Telegram's real SDK from telegram.org, which REPLACES window.Telegram and hands
  // back an empty initData outside a Telegram client — so the stub has to survive it. Blocking the
  // script is the only way; without this every request 401s with "no initData" and the harness
  // measures the sign-in screen instead of the app. (fullscreen.mjs deliberately does the opposite,
  // because the thing it measures IS the SDK's own event.)
  await p.route("**/telegram-web-app.js", r => r.abort());
  // Everything after this — auth, fetches, rendering — is the shipped code path.
  await p.addInitScript(d => {
    window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, ready() {}, expand() {}, close() {},
      themeParams: {}, colorScheme: "dark", isExpanded: true, viewportHeight: 812,
      onEvent() {}, offEvent() {}, HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
      MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
      BackButton: { show() {}, hide() {}, onClick() {} } } };
  }, initData(userId));
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  await p.evaluate(s => openDrill(s, "minislashprobe"), sid);
  await p.waitForTimeout(1500);
  return p;
}
// Type into the REAL composer and click the REAL send button.
async function typeSend(p, text) {
  await p.fill("#dtext", text);
  await p.dispatchEvent("#dtext", "input");
  await p.waitForTimeout(200);
  await p.click("#dsend");
  await p.waitForTimeout(800);
}
const feedText = p => p.evaluate(() => document.getElementById("dfeed").innerText);
// The composer's error strip is #err — the same element showErr()/showOk() write. It is CLEARED
// before each action that should raise one: showErr only drops the .show class on a timer and
// leaves its text behind, so reading it blind returns the PREVIOUS refusal and every check passes
// on a stale string.
const toastText = p => p.evaluate(() => document.getElementById("err")?.textContent ?? "");
const clearErr = p => p.evaluate(() => { document.getElementById("err").textContent = ""; });
async function waitErr(p, ms = 6000) {
  for (let i = 0; i < ms / 250; i++) { const t = await toastText(p); if (t) return t; await sleep(250); }
  return "";
}
const commandRows = p => p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.command")]
  .map(r => ({ name: r.querySelector(".cn")?.textContent ?? "", text: r.querySelector(".co")?.innerText ?? "" })));

const page = await openApp();
try {
  // ---- 1. /context: runs, and its output is VISIBLE. Before the system_command predicate it ran
  // and rendered nothing at all, which is the payoff this whole change is for. ----
  await typeSend(page, "/context");
  await sleep(9000);
  await page.evaluate(() => renderDrill());
  await sleep(1500);
  let rows = await commandRows(page);
  const ctx = rows.find(r => r.name === "/context");
  check(!!ctx && ctx.text.length > 40, `/context renders in the feed as a command row  (${ctx ? JSON.stringify(ctx.text.slice(0, 50)) : "MISSING"})`);
  check(!!ctx && !/\x1b/.test(ctx.text), "…with no escape codes in it");

  // ---- 2. an unknown command is an answer, not a silence ----
  await typeSend(page, "/nosuchcommand");
  await sleep(7000);
  await page.evaluate(() => renderDrill());
  await sleep(1500);
  rows = await commandRows(page);
  const unk = rows.find(r => r.name === "/nosuchcommand");
  check(!!unk && /Unknown command/i.test(unk.text), `an unknown command renders as a command row  (${unk ? JSON.stringify(unk.text) : "MISSING — it vanished"})`);

  // ---- 3. THE REGRESSION CONTROL: /model must not touch the box-global default ----
  const before = readFileSync(SETTINGS, "utf8");
  await typeSend(page, "/model sonnet");
  await sleep(9000);
  const after = readFileSync(SETTINGS, "utf8");
  check(before === after, `/model <alias> leaves ~/.claude/settings.json byte-identical  (${before === after ? "unchanged" : "MUTATED — the box default moved"})`);
  if (before !== after) sh("cp", ["/dev/stdin", SETTINGS]);   // never leave the box changed by a test

  // ---- 4. prose that starts with a slash is delivered as prose ----
  const feed0 = await feedText(page);
  await typeSend(page, "/tmp/foo is where I put it");
  await sleep(2500);
  const feed1 = await feedText(page);
  check(feed1.includes("/tmp/foo is where I put it") && feed1.length > feed0.length,
    "a path-shaped message is delivered as prose, not run as a command");
  rows = await commandRows(page);
  check(!rows.some(r => r.name.startsWith("/tmp")), "…and it produced no command row");

  // ---- 5. a modal command is refused instead of wedging the pane ----
  await clearErr(page);
  await typeSend(page, "/status");
  const statusErr = await waitErr(page);
  check(/Status screen|can't drive/i.test(statusErr), `/status is refused with a reason  (${JSON.stringify(statusErr.slice(0, 80))})`);
  const pane = sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id} #{pane_current_path}' | grep ${NAME} | head -1 | cut -d' ' -f1`]);
  const screen = sh("tmux", ["capture-pane", "-p", "-t", pane]);
  check(/bypass permissions on/.test(screen) && !/Esc to cancel/.test(screen),
    "…and the pane is still at its resting prompt, not parked on a dialog");

  // ---- 6. mid-turn, a command is refused with its reason ----
  await typeSend(page, "Count slowly from 1 to 60, one number per line.");
  // Wait for the pane to ACTUALLY be mid-turn before testing the mid-turn guard. A fixed sleep tests
  // whichever state the model happened to be in, which is not the same claim.
  let working = false;
  for (let i = 0; i < 24 && !working; i++) {
    await sleep(500);
    // The daemon's OWN predicate, not a regex invented here — the guard under test is built on
    // detectWorking, so anything else would be measuring a different question.
    working = sh("bun", ["-e", `import {detectWorking} from '${REPO}/prompt.ts';`
      + `import {execFileSync} from 'node:child_process';`
      + `console.log(detectWorking(execFileSync('tmux',['capture-pane','-p','-t','${pane}'],{encoding:'utf8'})))`]) === "true";
  }
  check(working, "FIXTURE: the probe is genuinely mid-turn before the guard is tested");
  await clearErr(page);
  await typeSend(page, "/clear");
  const midErr = await waitErr(page);
  check(/mid-turn/i.test(midErr), `a command sent mid-turn is refused with its reason  (${JSON.stringify(midErr.slice(0, 80))})`);
  // …while PROSE mid-turn still delivers, which is the asymmetry the guard is built on.
  const midFeed0 = await feedText(page);
  await typeSend(page, "and then stop");
  await sleep(2500);
  check((await feedText(page)).includes("and then stop") && (await feedText(page)).length > midFeed0.length,
    "…while prose mid-turn still delivers");

  await page.screenshot({ path: join(OUT, "minislash.png") });
} finally {
  await page.close().catch(() => {});
  await b.close();
  try { console.log(sh("tg", ["kill", NAME])); } catch {}
}
console.log(`\n${bad ? `${bad} FAILED` : "all checks passed"} — screenshot in ${OUT}`);
process.exit(bad ? 1 : 0);
