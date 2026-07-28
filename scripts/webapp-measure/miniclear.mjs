import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The 🧹 /clear approval setting, honoured by the MINI APP — driven end to end: the shipped page from
// the live server, text typed into the real composer, the real send button, a real throwaway session.
// Nothing stubbed, because the defect was never in what the client drew: `confirmReset` was read in
// exactly one place (confirmResetSession, the Telegram chat's own /clear), so a composer /clear went
// through planSlash straight to the pane and reset a box that had asked for approvals.
//
//   node miniclear.mjs [outdir]
//
// THE CONTROL IS TEMPORAL, as in deadcard.mjs, because the change is DAEMON-side: there is no
// pre-change copy of a page to pass in. Run this against the live PRE-FIX daemon first and it fails
// 5 checks — both of §1 and §3's ask ("0 confirms"), plus §2's pane probe and its draft hand-back.
// §4 and §5 pass on both builds on purpose: they are the "nothing else moved" half, not the finding.
//
// Two checks pass on the pre-fix daemon for reasons worth knowing before you trust them:
//   • §2's FEED check ("2 → 2 items") passes there, and that is the whole reason the pane probe
//     beside it exists. A /clear rotates the transcript FILE, and the daemon's session→file mapping
//     lags a few seconds — so three seconds after a clear that really happened, the feed still serves
//     the old file and reports a transcript that is already gone. The pane is the surface that knows.
//   • §3's "saying yes clears the conversation" passes vacuously there, because §1's ungated /clear
//     already emptied the session. Its own pane probe fails, which is what says so.
//
// It flips prefs.json's confirmReset itself and restores the box's own value in `finally`, so a
// crashed run leaves the owner's setting where it found it.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const OUT = process.argv[2] || mkdtempSync(join(tmpdir(), "miniclear-"));
const CHAN = "/home/ubuntu/.claude/channels/telegram";
const ENVF = join(CHAN, ".env");
const PREFS = join(CHAN, "prefs.json");
const env = Object.fromEntries(readFileSync(ENVF, "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const BASE = `http://127.0.0.1:${env.TELEGRAM_WEBAPP_PORT || "8795"}`;
const OWNER = process.env.MINISLASH_USER || "837047563";

function initData(userId) {
  const params = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: "miniclear",
    user: JSON.stringify({ id: Number(userId), first_name: "harness", username: "harness" }) };
  const check = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
  return new URLSearchParams({ ...params, hash: createHmac("sha256", secret).update(check).digest("hex") }).toString();
}

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const apiGet = async p => (await fetch(new URL(p, BASE), { headers: { Authorization: "tma " + initData(OWNER) } })).json();

// The setting under test. Read the box's own value first and put it back at the end — this is the
// owner's live daemon, and prefs.json is his configuration, not the harness's scratch space.
const ownPref = JSON.parse(readFileSync(PREFS, "utf8")).confirmReset;
const setConfirm = v => {
  const p = JSON.parse(readFileSync(PREFS, "utf8"));
  if (v === undefined) delete p.confirmReset; else p.confirmReset = v;
  writeFileSync(PREFS, JSON.stringify(p, null, 2));
};

// ---- a real throwaway session ----
const NAME = "miniclearprobe";
sh("mkdir", ["-p", `/tmp/${NAME}`]);
console.log(sh("tg", ["spawn", NAME, "--dir", `/tmp/${NAME}`, "--model", "haiku"]));
let sid = null;
for (let i = 0; i < 15 && !sid; i++) {
  await sleep(3000);
  sid = (await apiGet("/api/sessions").catch(() => null))?.sessions?.find(s => s.name === NAME)?.sid ?? null;
}
if (!sid) { console.log("FAIL  the probe session never appeared"); process.exit(1); }
console.log(`probe sid=${sid}`);
const pane = sh("bash", ["-lc", `tmux list-panes -a -F '#{pane_id} #{pane_current_path}' | grep ${NAME} | head -1 | cut -d' ' -f1`]);

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
page.on("pageerror", e => console.log("PAGEERROR:", e.message));
// Telegram's real SDK would REPLACE window.Telegram and hand back an empty initData outside a client,
// so the stub has to survive it — blocking the script is the only way (minislash.mjs, same reason).
await page.route("**/telegram-web-app.js", r => r.abort());
// The stub's showConfirm is the harness's HAND on the dialog: it records the message it was asked and
// answers with whatever `answer` currently says. That is the whole instrument — a confirm nobody can
// answer is indistinguishable from a confirm that never appeared.
await page.addInitScript(d => {
  window.__confirms = [];
  window.__answer = true;
  window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, ready() {}, expand() {}, close() {},
    themeParams: {}, colorScheme: "dark", isExpanded: true, viewportHeight: 812,
    onEvent() {}, offEvent() {}, HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    MainButton: { show() {}, hide() {}, setText() {}, onClick() {} },
    BackButton: { show() {}, hide() {}, onClick() {} },
    showConfirm(msg, cb) { window.__confirms.push(msg); setTimeout(() => cb(window.__answer), 0); } } };
  // The no-Telegram fallback askConfirm() uses. Stubbed too, so a page that took the other branch is
  // still measured rather than hanging headless Chromium on a native dialog.
  window.confirm = msg => { window.__confirms.push(msg); return window.__answer; };
}, initData(OWNER));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.evaluate(s => openDrill(s, "miniclearprobe"), sid);
await page.waitForTimeout(1500);

const confirms = () => page.evaluate(() => window.__confirms.slice());
const resetConfirms = a => page.evaluate(v => { window.__confirms = []; window.__answer = v; }, a);
const draft = () => page.evaluate(() => document.getElementById("dtext").value);
async function typeSend(text) {
  await page.fill("#dtext", text);
  await page.dispatchEvent("#dtext", "input");
  await page.waitForTimeout(200);
  await page.click("#dsend");
  await page.waitForTimeout(1500);
}
const feedItems = async () => ((await apiGet(`/api/session/feed?sid=${sid}`)).items || []).length;
const isIdle = async () => (await apiGet(`/api/session/feed?sid=${sid}`)).working !== true;
const waitIdle = async (max = 90) => { for (let i = 0; i < max; i++) { if (await isIdle()) return true; await sleep(1000); } return false; };
// Fill the transcript with something a clear would destroy, and do not return until the turn is over
// on BOTH surfaces — the word on the pane, the session idle. Waiting on the item count alone is not
// enough and cost a run: a seed that gave up early sent its /clear into a running turn, where the
// mid-turn guard correctly refuses it, and the check read that as the fix failing. The leading
// waitIdle matters as much — the command before this one may still be finishing.
async function seed(word) {
  await waitIdle();
  await typeSend(`Reply with just the word ${word}.`);
  // THREE conditions, and each one was needed: the word on the pane, the session idle, and the
  // FEED carrying both halves of the turn. The feed lags the pane by a second or two, so a seed that
  // returned on pane+idle handed back a count of 1 that had become 2 by the time the "untouched"
  // check re-read it — a moving baseline reported as a transcript that changed.
  for (let i = 0; i < 90; i++) { await sleep(1000); if (paneText().includes(word) && await feedItems() >= 2 && await isIdle()) break; }
  return feedItems();
}
// The pane's own answer to "did a /clear land here", independent of the feed: Claude Code's cleared
// screen carries its welcome banner and no conversation. Check 3 needs this — a feed that still reads
// full proves the transcript file was not rotated, not that nothing was typed into the pane.
const paneText = () => sh("tmux", ["capture-pane", "-p", "-t", pane]);

try {
  // ---- 1. THE FINDING: setting ON, and the composer's /clear asks first ----
  setConfirm(true);
  await sleep(1000);
  let before = await seed("BANANAS");
  check(before >= 2, `FIXTURE: the probe has a transcript to lose  (${before} items)`);
  check(paneText().includes("BANANAS"), "FIXTURE: …and that turn is on the PANE, so check 2's pane probe can fail");
  await resetConfirms(false);          // cancel, so the finding's check cannot destroy check 2's fixture
  await typeSend("/clear");
  let asked = await confirms();
  check(asked.length === 1, `setting ON: a composer /clear ASKS before it clears  (${asked.length} confirms: ${JSON.stringify(asked)})`);
  check(asked.length === 1 && /clear this conversation/i.test(asked[0]), "…and the question names what is lost");

  // ---- 2. CANCEL leaves the session untouched — proven at the PANE, not just in the feed ----
  // The feed reading the same length says the transcript FILE was not rotated. It does not say the
  // pane never got the paste, and those are different claims: the word from the seeded turn is still
  // on the pane's screen iff no /clear ran there. Guarded by its own fixture line, because a check
  // that "BANANAS is absent" would pass on a pane that never had it.
  await sleep(3000);
  const afterCancel = await feedItems();
  check(afterCancel === before, `cancel: the transcript is untouched  (${before} → ${afterCancel} items)`);
  check(paneText().includes("BANANAS"), "…and the seeded turn is still on the pane — no /clear ran there");
  check((await draft()) === "/clear", `…and the composer has the draft back  (${JSON.stringify(await draft())})`);

  // ---- 3. CONFIRM proceeds ----
  await resetConfirms(true);
  await page.fill("#dtext", "");        // the cancelled draft is still sitting there
  await page.dispatchEvent("#dtext", "input");
  await typeSend("/clear");
  asked = await confirms();
  check(asked.length === 1, `confirm: the same question is asked  (${asked.length})`);
  let cleared = 99;
  for (let i = 0; i < 15; i++) { await sleep(1000); cleared = await feedItems(); if (cleared === 0) break; }
  check(cleared === 0, `…and saying yes clears the conversation  (${cleared} items left)`);
  check(!paneText().includes("BANANAS"), "…at the PANE too — the same probe that held on the cancel");
  check((await draft()) === "", "…and the composer does not hand the draft back on a send that went through");

  // ---- 4. the over-trigger guard: with the setting ON, an ordinary command still passes ----
  await resetConfirms(true);
  await typeSend("/context");
  check((await confirms()).length === 0, `setting ON: a non-reset command is NOT gated  (${(await confirms()).length} confirms)`);
  await sleep(8000);

  // ---- 5. setting OFF: today's behaviour, byte for byte ----
  setConfirm(false);
  await sleep(1000);
  before = await seed("PLUMS");
  check(before >= 2, `FIXTURE: a fresh transcript to lose  (${before} items)`);
  await resetConfirms(true);
  await typeSend("/clear");
  check((await confirms()).length === 0, `setting OFF: no surface asks  (${(await confirms()).length} confirms)`);
  cleared = 99;
  for (let i = 0; i < 15; i++) { await sleep(1000); cleared = await feedItems(); if (cleared === 0) break; }
  check(cleared === 0, `…and the clear runs straight through  (${cleared} items left)`);

  await page.screenshot({ path: join(OUT, "miniclear.png") });
} finally {
  setConfirm(ownPref);
  console.log(`restored confirmReset = ${JSON.stringify(JSON.parse(readFileSync(PREFS, "utf8")).confirmReset)}`);
  await page.close().catch(() => {});
  await b.close();
  try { console.log(sh("tg", ["kill", NAME])); } catch {}
}
console.log(`\n${bad ? `${bad} FAILED` : "all checks passed"} — screenshot in ${OUT}`);
process.exit(bad ? 1 : 0);
