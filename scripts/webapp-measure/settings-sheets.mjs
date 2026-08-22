import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The settings screen, measured in a real browser against a fixture payload.
//
// RE-POINTED 2026-08-03 for the owner's 1:1 ruling — "It should be a 1:1 parity of the /settings
// menu, and both should be front ends of the same backend". The screen's structure is no longer the
// client's: `/api/settings` serves `rows` (settingsRows() in daemon.ts) and the client renders them.
// So the claim that used to be "the client's order matches the daemon's" is now falsifiable in one
// browser: feed a WRONG order and watch the screen take it.
//
// What this has to prove, and why each claim needs its own check:
//  1. RENDERED == SERVED. The screen is the served list — same rows, same order, nothing added and
//     nothing dropped. Checked twice: against the real order, then against a scrambled one, because
//     a client with a hard-coded order passes the first and fails the second.
//  2. GROUPING IS PRESENTATIONAL. Every key inside a sub-panel row is still rendered, by the same row
//     builder, with the same control — a different container, not a different implementation.
//     Counting rows on the main screen cannot see this; the sheet bodies are counted directly.
//  3. A CONTROL STILL WRITES. The POST body is captured per control: key AND value. A sheet that opens
//     and renders but posts nothing looks identical in a screenshot.
//  4. READ-ONLY IS STILL READ-ONLY. With write off, no control in any sheet is operable — the flag
//     split moved which env var decides that, so the OFF case has to be re-proved, not assumed.
//  5. GITHUB'S DEVICE-CODE FLOW SURFACES ITS CODE. The login runs for minutes; the sheet must show the
//     code the daemon reports rather than a spinner that never resolves.
//  6. THE ✳️ CODEX DIALS LIVE IN THE ACCOUNTS SHEET, where /settings keeps them — and write from
//     there, with the same keys.
//  7. A ROLE'S OWN DIALS LIVE UNDER ITS TAB IN THAT SAME SHEET (2026-08-21; the 🧑‍💻 Defaults sheet
//     is gone). Which dials show is the SELECTED ROLE's, and the model dial is the one that can be
//     absent: a role defaulting to a GATEWAY account has exactly one model control — the provider
//     row's own select — so this block must show a read-only line naming that account's model and
//     no Anthropic alias list. The control for it is the same fixture with the role's default moved
//     back to a `claude:` account, which must bring the select back; without that control "no
//     select" passes on a block that renders nothing at all.
//
// CONTROL: the same page with `write:false`, which must fail every write claim and pass every render
// one. Without it "the toggles didn't post" would pass on a page whose sheets never opened.
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");

let bad = 0;
const ok = (cond, label) => { console.log(`${cond ? "OK  " : "FAIL"}  ${label}`); if (!cond) bad++; };

// The row structure the daemon serves, in /settings' own order. Both conditional rows (📂 Base
// folder, ☎️ Agent bus) are included so their controls are exercised; the daemon decides whether a
// real install gets them.
const ROWS = [
  { id: "accounts", name: "👤 Accounts", keys: ["accounts"], panel: "accounts" },
  { id: "github", name: "🐙 GitHub", keys: ["github"], panel: "github" },
  { id: "batchAllow", name: "⚡ Batch allow", keys: ["batchAllow"] },
  { id: "transcribe", name: "🎙️ Voice transcription", keys: ["transcribeBackend", "transcribeModel"], value: "off" },
  { id: "tts", name: "🔊 Voice replies", keys: ["voice", "ttsMode", "ttsEngine", "ttsVoice"], value: "off" },
  { id: "stream", name: "💬 Stream", keys: ["stream"] },
  { id: "sessionPin", name: "📌 Pinned message", keys: ["sessionPin"] },
  { id: "prefMode", name: "🧷 Preferred mode", keys: ["prefMode"] },
  { id: "confirmReset", name: "🧹 /clear approval", keys: ["confirmReset"] },
  { id: "fileBrowser", name: "🗂 File browser", keys: ["fileBrowser"] },
  { id: "baseFolder", name: "📂 Base folder", keys: ["baseFolder"] },
  { id: "switchboard", name: "☎️ Agent bus", keys: ["switchboard"] },
];

// The payload shape the daemon serves, trimmed to what this file measures. `codexModel`/`codexEffort`
// and the eight role dials (chat*/spawn*/fableForAgents) are served but named by no ROW — they belong
// to the Accounts panel now, and their absence from the screen is itself a claim below.
const settingsFixture = (write, rows = ROWS) => ({
  write,
  rows,
  settings: {
    accounts: { value: "2 · 🔀 off", editable: false, label: "tap to manage" },
    spawnModel: { value: "opus", editable: true, options: ["fable", "opus", "sonnet", "haiku"], label: "coding sessions" },
    spawnEffort: { value: "high", editable: true, options: ["low", "medium", "high", "xhigh", "max"], label: "coding sessions" },
    chatModel: { value: "fable", editable: true, options: ["fable", "opus", "sonnet", "haiku"], label: "the chat agent" },
    chatEffort: { value: "medium", editable: true, options: ["low", "medium", "high", "xhigh", "max"], label: "the chat agent" },
    chatMode: { value: "🛡 Ask", raw: "default", editable: true, options: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"], label: "the chat agent" },
    spawnMode: { value: "🚨 Bypass", raw: "bypassPermissions", editable: true, options: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"], label: "coding sessions" },
    spawnAuto: { value: false, editable: true, label: "agent spawns pick their own" },
    fableForAgents: { value: "default", editable: true, options: ["default", "allow"] },
    github: { value: "casualsav", editable: false },
    batchAllow: { value: true, editable: true },
    transcribeBackend: { value: "off", editable: true, options: ["off", "local", "groq", "openai"] },
    transcribeModel: { value: "base", editable: true, options: ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"] },
    voice: { value: false, editable: true },
    ttsMode: { value: "off", editable: true, options: ["off", "all"] },
    ttsEngine: { value: "piper", editable: true, options: ["piper", "openai", "elevenlabs"] },
    ttsVoice: { value: "en_US-lessac-medium", editable: true, options: ["en_US-lessac-medium", "en_GB-alan-medium"] },
    stream: { value: "thoughts", editable: true, options: ["thoughts", "actions", "off"] },
    sessionPin: { value: true, editable: true },
    prefMode: { value: "🛡 Ask", raw: "default", editable: true, options: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] },
    confirmReset: { value: true, editable: true },
    fileBrowser: { value: true, editable: true },
    baseFolder: { value: "~/projects", editable: true, kind: "text", placeholder: "Folder path (must exist)", label: "must already exist" },
    switchboard: { value: true, editable: true },
    codexModel: { value: "default", editable: true, kind: "text", placeholder: "Model id, or 'default'" },
    codexEffort: { value: "default", editable: true, options: ["default", "low", "medium", "high", "xhigh"] },
  },
});

const GH = { installed: true, accounts: [{ user: "casualsav", host: "github.com", active: true }, { user: "alt", host: "github.com", active: false }], login: { active: false } };

// ---- the /api/provider-accounts payload, as the projection now builds it -----------------------
// A Claude row is a SUBSCRIPTION (owner's mirror ruling, 2026-08-21), so it carries the config dirs
// behind it with each dir's OWN state (`members`) and the set's state (`state`). The row's dot, its
// meta line and every one of its buttons are drawn from those two and nothing else — a fixture that
// omits them renders a grey row with no actions, which is why they are spelled out here rather than
// defaulted. `dirs` is [name, signedIn] pairs.
const CL = (name, dirs = [[name, true]], over = {}) => ({
  id: "claude:" + name, provider: "claude", providerLabel: "Claude", authLabel: "subscription",
  label: name, models: ["opus"], model: "opus",
  members: dirs.map(([n, ready]) => ({ name: n, ready })),
  ready: dirs.every(([, r]) => r),
  state: dirs.every(([, r]) => r) ? "in" : dirs.some(([, r]) => r) ? "mixed" : "out",
  ...over,
});
const GW = (name, label, over = {}) => ({
  id: "gateway:" + name, provider: "deepseek", providerLabel: label, authLabel: "API key", label,
  ready: true, state: "in", members: [{ name, ready: true }],
  models: ["deepseek-chat"], model: "deepseek-chat", ...over,
});
// `roleOptions` is the per-CONFIG-DIR list a role picks from — the daemon's own expansion of the
// rows above, so a fixture cannot offer the role a subscription id it could never store.
const roleOptionsOf = accounts => accounts.filter(a => !a.roleOnly).flatMap(a =>
  a.id.startsWith("claude:")
    ? a.members.map(m => ({ id: "claude:" + m.name, label: m.name, ready: m.ready, members: [m] }))
    : [{ id: a.id, label: a.label, ready: a.ready, model: a.model, members: a.members }]);
const accView = (accounts, over = {}) => ({
  accounts, roleOptions: roleOptionsOf(accounts),
  activeCount: accounts.filter(a => !a.roleOnly).length,
  defaults: { chat: "claude:main", code: "claude:main" }, catalog: [], auto: false, ...over,
});

const b = await chromium.launch();
const open = async (write, gh = GH, rows = ROWS) => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(([s, g]) => {
    window.__posts = [];
    window.api = async q => q.includes("/api/settings") ? s : q.includes("/api/github") ? g : {};
    // writeOp is what every mutating control goes through; capturing HERE records the key and the
    // value a control actually sends, which is the claim — not merely that something was clicked.
    window.writeOp = async (path, body) => { window.__posts.push({ path, body }); return { ok: true }; };
    showTab("settings");
  }, [settingsFixture(write, rows), gh]);
  await p.waitForTimeout(400);
  return p;
};
const screenRows = p => p.$$eval("#tab-settings .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));

// ---- 1: rendered == served -------------------------------------------------------------------
{
  const p = await open(true);
  const rows = await screenRows(p);
  ok(JSON.stringify(rows) === JSON.stringify(ROWS.map(r => r.name)),
    `the screen is exactly the served rows, in the served order (got ${JSON.stringify(rows)})`);
  // A key the daemon serves under no ROW renders nowhere on the screen. Since 2026-08-21 that is
  // every role dial: they are the accounts sheet's, and the screen inventing a row for them is the
  // same failure as inventing one for the Codex dials.
  ok(!rows.includes("Coding session model") && !rows.includes("Chat agent model"),
    "a key served under no row does NOT render on the screen");
  // The rows /settings has never had. They cannot appear now without the client inventing them —
  // which is the failure this whole change exists to make impossible.
  const strays = rows.filter(r => /MCP|🛠|🤖|⏫|Codex/.test(r));
  ok(strays.length === 0, `no row the daemon did not serve (MCP, the pane dials, the Codex dials): ${JSON.stringify(strays)}`);
  // Every row carries its STATE line, including the two that open panels of their own — /settings
  // shows `2 · 🔀 off` and `casualsav` there, and the app showed "tap to manage" until 2026-08-03.
  const subs = await p.$$eval("#tab-settings .setrow.action .lbl .sub", ns => ns.map(n => n.textContent.trim()));
  ok(subs.includes("2 · 🔀 off") && subs.includes("casualsav"),
    `the 👤 and 🐙 rows show their state, not a "tap to manage" hint (got ${JSON.stringify(subs)})`);
  await p.close();
}
{
  // The falsifier: the SAME payload in a deliberately wrong order. A client holding its own order
  // renders the list above and fails here; a client rendering what it is served follows.
  const scrambled = [ROWS[2], ROWS[0], ROWS[7], ROWS[3], ROWS[5]];
  const p = await open(true, GH, scrambled);
  const rows = await screenRows(p);
  ok(JSON.stringify(rows) === JSON.stringify(scrambled.map(r => r.name)),
    `a scrambled served order is rendered scrambled — the client keeps no order of its own (got ${JSON.stringify(rows)})`);
  await p.close();
}

// ---- 2: grouping is presentational ------------------------------------------------------------
{
  const p = await open(true);
  // VOICE IS TWO ROWS AND TWO SHEETS, because /settings' root has two rows. A merged sheet was this
  // app's own deviation, and it is what a served structure cannot express.
  const voice = await p.$$eval("#voicebody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(voice) === JSON.stringify(["Transcription backend", "Local Whisper model"]),
    `the transcription sheet holds its two controls (got ${JSON.stringify(voice)})`);
  const tts = await p.$$eval("#ttsbody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(tts) === JSON.stringify(["Voice replies", "Speak replies", "Voice engine", "Piper voice"]),
    `the voice-replies sheet holds its four controls (got ${JSON.stringify(tts)})`);
  // Grouping must not lose a control TYPE either: the four voice-replies rows are 3 selects + 1 toggle.
  const kinds = await p.$$eval("#ttsbody .setrow", rs => rs.map(r => r.querySelector("select") ? "select" : r.querySelector("button") ? "toggle" : "ro"));
  ok(kinds.filter(k => k === "select").length === 3 && kinds.filter(k => k === "toggle").length === 1,
    `sheet controls keep their types (got ${JSON.stringify(kinds)})`);
  await p.close();
}

// ---- 3: a control inside a sheet still writes, with the right key and value --------------------
{
  const p = await open(true);
  await p.click("#tab-settings .setrow:nth-child(4)", { timeout: 2000 }).catch(() => {});            // open 🎙️ Voice transcription
  await p.waitForTimeout(250);
  // Guarded so the CONTROL run (a page with no sheets) reports failures instead of throwing on the
  // first missing selector and hiding every check after it.
  ok(await p.$eval("#voicesheet", n => n.classList.contains("show")).catch(() => false), "tapping the group row opens its sheet");
  await p.selectOption("#voicebody .setrow:nth-child(1) select", "local", { timeout: 2000 }).catch(() => {});   // transcribeBackend
  await p.waitForTimeout(150);
  const posts = await p.evaluate(() => window.__posts);
  const m = posts.find(x => x.path.includes("/api/settings/set"));
  ok(!!m && m.body.key === "transcribeBackend" && m.body.value === "local",
    `the transcription select posts transcribeBackend=local (got ${JSON.stringify(m && m.body)})`);
  // And a toggle inside a sheet, which takes a different branch of the builder. A sheet is a
  // full-screen backdrop, so the one standing has to go first — a click that lands on the backdrop
  // posts nothing and reads exactly like a dead control.
  await p.evaluate(() => closeSheet("voicesheet"));
  await p.waitForTimeout(250);
  await p.click("#tab-settings .setrow:nth-child(5)", { timeout: 2000 }).catch(() => {});            // open 🔊 Voice replies
  await p.waitForTimeout(250);
  await p.click("#ttsbody .setrow:nth-child(1) button", { timeout: 2000 }).catch(() => {});          // voice, currently false
  await p.waitForTimeout(150);
  const t = (await p.evaluate(() => window.__posts)).filter(x => x.body && x.body.key === "voice")[0];
  ok(!!t && t.body.value === true, `the voice toggle posts voice=true (got ${JSON.stringify(t && t.body)})`);
  // A flat row on the screen itself.
  await p.evaluate(() => closeSheet("ttssheet"));
  await p.waitForTimeout(250);
  await p.click("#tab-settings .setrow:nth-child(3) button", { timeout: 2000 }).catch(() => {});     // batchAllow, currently true
  await p.waitForTimeout(150);
  const ba = (await p.evaluate(() => window.__posts)).filter(x => x.body && x.body.key === "batchAllow")[0];
  ok(!!ba && ba.body.value === false, `the batch-allow toggle posts batchAllow=false (got ${JSON.stringify(ba && ba.body)})`);
  await p.close();
}

// ---- 4: read-only stays read-only through the sheets -------------------------------------------
{
  const p = await open(false);
  await p.click("#tab-settings .setrow:nth-child(4)", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(250);
  const operable = await p.$$eval("#voicebody .setrow", rs => rs.filter(r => {
    const s = r.querySelector("select"), btn = r.querySelector("button");
    return (s && !s.disabled) || (btn && !btn.disabled);
  }).length);
  ok(operable === 0, `write off: no control in the sheet is operable (got ${operable})`);
  const posts = await p.evaluate(() => window.__posts);
  ok(posts.length === 0, `write off: nothing was posted (got ${posts.length})`);
  await p.close();
}

// ---- 5: GitHub's device-code flow shows its code ------------------------------------------------
{
  const p = await open(true, { ...GH, login: { active: true, code: "WXYZ-1234", url: "https://github.com/login/device" } });
  await p.click("#tab-settings .setrow:nth-child(2)", { timeout: 2000 }).catch(() => {});            // GitHub row
  await p.waitForTimeout(300);
  const body = await p.$eval("#ghbody", n => n.textContent).catch(() => "");
  ok(await p.$eval("#ghsheet", n => n.classList.contains("show")).catch(() => false), "the GitHub row opens its sheet");
  ok(body.includes("casualsav") && body.includes("alt"), "both gh accounts are listed");
  ok(body.includes("WXYZ-1234"), "the in-flight device code is shown, not a bare spinner");
  await p.close();
}
{
  // The actions, on a settled login.
  const p = await open(true);
  await p.click("#tab-settings .setrow:nth-child(2)", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(300);
  await p.click('#ghbody [data-gh="alt"] [data-gh-switch]', { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  const g = (await p.evaluate(() => window.__posts)).find(x => x.path.includes("/api/github/action"));
  ok(!!g && g.body.action === "switch" && g.body.user === "alt",
    `Make active posts switch/alt (got ${JSON.stringify(g && g.body)})`);
  await p.close();
}

// ---- 6: the TEXT row ---------------------------------------------------------------------------
// A field posts on commit, and — the half that is easy to get wrong — does NOT post when the value
// did not change. A tap that opens the keyboard and closes it must be free; without that rule every
// visit to the screen would rewrite the base folder.
{
  const p = await open(true);
  const fields = await p.$$eval("#tab-settings input.ro.edit", ns => ns.map(n => n.value));
  ok(JSON.stringify(fields) === JSON.stringify(["~/projects"]),
    `the screen's one text row renders as a field carrying its value — the Codex field is NOT here (got ${JSON.stringify(fields)})`);

  // Guarded like the sheet checks above so the CONTROL run reports failures instead of throwing.
  const base = await p.$("#tab-settings input.ro.edit");
  if (base) { await base.fill("~/work"); await base.evaluate(n => n.blur()); }
  await p.waitForTimeout(150);
  const w = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "baseFolder");
  ok(!!w && w.body.value === "~/work", `a changed folder posts baseFolder=~/work (got ${JSON.stringify(w && w.body)})`);

  const p2 = await open(true);
  const f2 = await p2.$("#tab-settings input.ro.edit");
  if (f2) { await f2.click(); await f2.evaluate(n => n.blur()); }
  await p2.waitForTimeout(150);
  ok((await p2.evaluate(() => window.__posts)).length === 0, "focus and blur with no edit posts NOTHING");
  // Enter commits too — the keyboard's own done key is the natural gesture on a phone.
  const f3 = await p2.$("#tab-settings input.ro.edit");
  if (f3) { await f3.fill("~/elsewhere"); await f3.press("Enter"); }
  await p2.waitForTimeout(150);
  const e = (await p2.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "baseFolder");
  ok(!!e && e.body.value === "~/elsewhere", `Enter commits (got ${JSON.stringify(e && e.body)})`);
  await p.close(); await p2.close();
}
{
  // Write off: the text rows fall back to plain read-only values, not disabled inputs a thumb can
  // still focus. An input rendered "disabled" would still read as a field that ought to work.
  const p = await open(false);
  ok((await p.$$("#tab-settings input.ro.edit")).length === 0, "write off: no text FIELD is rendered at all");
  await p.close();
}

// ---- 7: the ✳️ Codex dials, in the ACCOUNTS sheet -----------------------------------------------
// /settings keeps them in the Accounts panel, so the app does too. Same settings keys, same builder,
// same POST — only the container and the repaint differ. Served only when Codex is set up.
{
  const p = await open(true);
  const accounts = codex => accView([CL("main")], codex ? { codex } : {});
  await p.evaluate(a => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? { write: true, rows: [], settings: {} } : {}; },
    accounts({ model: "gpt-5.6-sol", effort: "high", efforts: ["default", "low", "medium", "high", "xhigh"] }));
  await p.evaluate(() => openAccounts()).catch(() => {});
  await p.waitForTimeout(300);
  // DIRECT children only: the role block (`#acctdefaults`) is a div inside this same body and now
  // leads with a "Runs on" row of its own, so an unscoped `.setrow` reads two components as one and
  // — worse — `selectOption` below would drive the role picker instead of the Codex effort.
  const names = await p.$$eval("#accbody > .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(names) === JSON.stringify(["✳️ Codex model", "✳️ Codex effort"]),
    `the accounts sheet carries both Codex dials (got ${JSON.stringify(names)})`);
  const f = await p.$("#accbody > .setrow input.ro.edit");
  ok(await f?.inputValue() === "gpt-5.6-sol", "the Codex model field carries the served value");
  if (f) { await f.fill("gpt-5.6-mini"); await f.evaluate(n => n.blur()); }
  await p.waitForTimeout(150);
  const cm = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "codexModel");
  ok(!!cm && cm.body.value === "gpt-5.6-mini", `the Codex field posts codexModel (got ${JSON.stringify(cm && cm.body)})`);
  await p.selectOption("#accbody > .setrow select", "low", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  const ce = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "codexEffort");
  ok(!!ce && ce.body.value === "low", `the Codex effort select posts codexEffort (got ${JSON.stringify(ce && ce.body)})`);

  // No Codex on the box → no dials. The rows are the daemon's to serve here too.
  await p.evaluate(a => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? { write: true, rows: [], settings: {} } : {}; }, accounts(null));
  await p.evaluate(() => openAccounts()).catch(() => {});
  await p.waitForTimeout(250);
  ok((await p.$$("#accbody > .setrow")).length === 0, "no Codex on the box: the accounts sheet shows no Codex dials");
  await p.close();
}

// ---- 8: the Claude-account controls (1.5 register, 1.7 two-step remove) -------------------------
// The claim that matters for 1.7 is the SHAPE: the confirm must show what the DAEMON said would go,
// and a declined confirm must remove nothing. A one-shot remove would look identical until the day
// a row stood for two config dirs.
{
  const p = await open(true);
  await p.evaluate(a => {
    window.api = async q => q.includes("/api/provider-accounts") ? a
      : q.includes("/api/settings") ? { write: true, rows: [], settings: {} } : {};
    window.writeOp = async (path, body) => {
      window.__posts.push({ path, body });
      return body.action === "remove-claude-plan"
        ? { ok: true, plan: { label: "work", doomed: [{ name: "work", configDir: "/home/u/.claude-work" }], kept: ["main"] } }
        : { ok: true };
    };
    window.confirm = m => { window.__confirm = m; return window.__answer; };
    window.prompt = () => window.__prompt;
  }, accView([CL("main"), CL("work")]));
  await p.evaluate(() => { window.__answer = false; window.__prompt = null; return openAccounts(); }).catch(() => {});
  await p.waitForTimeout(300);

  ok(!!(await p.$('[data-account="claude:work"] [data-acc-rmclaude]')), "a non-main Claude row offers Remove");
  ok(!(await p.$('[data-account="claude:main"] [data-acc-rmclaude]')), "the main account offers NO Remove");

  // Declined confirm: the plan is requested, the removal is not sent.
  await p.click('[data-account="claude:work"] [data-acc-rmclaude]', { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(200);
  const posts1 = await p.evaluate(() => window.__posts.filter(x => String(x.body.action || "").startsWith("remove-claude")));
  const shown = await p.evaluate(() => window.__confirm || "");
  ok(posts1.length === 1 && posts1[0].body.action === "remove-claude-plan", `declined: only the PLAN was requested (got ${JSON.stringify(posts1.map(x => x.body.action))})`);
  ok(shown.includes("/home/u/.claude-work") && shown.includes("main"), "the confirm names the daemon's doomed dir AND what is kept");

  // Accepted confirm: now the removal goes.
  await p.evaluate(() => { window.__answer = true; });
  await p.click('[data-account="claude:work"] [data-acc-rmclaude]', { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(200);
  const posts2 = await p.evaluate(() => window.__posts.filter(x => x.body.action === "remove-claude"));
  ok(posts2.length === 1 && posts2[0].body.name === "work", `accepted: remove-claude posted for work (got ${JSON.stringify(posts2.map(x => x.body))})`);

  // 1.5 register: a name posts; a cancelled prompt posts nothing.
  await p.evaluate(() => { window.__prompt = null; });
  await p.click("#accaddclaude", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  ok((await p.evaluate(() => window.__posts.filter(x => x.body.action === "add-claude"))).length === 0, "a cancelled name prompt posts NOTHING");
  await p.evaluate(() => { window.__prompt = "  WORK2 "; });
  await p.click("#accaddclaude", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  const addp = await p.evaluate(() => window.__posts.filter(x => x.body.action === "add-claude"));
  ok(addp.length === 1 && addp[0].body.name === "work2", `register posts the trimmed, lowercased name (got ${JSON.stringify(addp.map(x => x.body))})`);
  await p.close();
}

// ---- 9: the ROLE's own dials, under the role tab in the accounts sheet --------------------------
// One sheet answers "which account" and "what does it run on" (the owner, 2026-08-21). The dials are
// the selected role's, and the model dial is conditional on WHAT that role defaults to: a gateway
// account's model is the provider row's own select, so this block shows it read-only rather than a
// second control offering Anthropic aliases the account cannot serve.
{
  const p = await open(true);
  const accountsFor = codeDefault => accView(
    [CL("main", [["main", true]], { models: ["opus", "sonnet"] }), GW("deepseek", "DeepSeek", { models: ["deepseek-chat", "deepseek-reasoner"] })],
    { defaults: { chat: "claude:main", code: codeDefault } });
  // Re-stub, then re-open: the sheet reads BOTH endpoints on every repaint, so a fixture change is
  // only in effect once it has been read again.
  const load = async (codeDefault, write = true) => {
    await p.evaluate(([a, s]) => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? s : {}; },
      [accountsFor(codeDefault), settingsFixture(write)]);
    await p.evaluate(() => openAccounts()).catch(() => {});
    await p.waitForTimeout(300);
  };
  const labels = () => p.$$eval("#acctdefaults .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  // The role's ACCOUNT is the block's first row since v0.5.213 — "which account" and "what it runs
  // on" are one question, so the picker sits at the head of the dials it governs rather than on each
  // failover row, which stands for a subscription and could not name a config dir.
  const runsOn = () => p.$$eval("#acctdefaults [data-acc-runs-on] option", ns => ns.map(n => n.textContent.trim()));
  // Per row: its control, or — for a read-only row — the value it displays. A row's KIND is the
  // claim here, so "no select" and "the gateway's model is named" are answered by one read.
  const kinds = () => p.$$eval("#acctdefaults .setrow", rs => rs.map(r =>
    r.querySelector("select") ? "select" : r.querySelector("button") ? "toggle" : (r.querySelector(".ro")?.textContent.trim() || "ro")));

  // (b) THE CODING TAB, defaulting to a gateway: five dials, and the model one is read-only.
  await load("gateway:deepseek");
  const code = await labels(), codeKinds = await kinds();
  ok(JSON.stringify(code) === JSON.stringify(["Runs on", "Coding session model", "Coding session effort", "Coding session mode", "Auto — agent spawns pick", "Fable for agents"]),
    `the coding tab leads with Runs on, then the coding role's five dials (got ${JSON.stringify(code)})`);
  ok(JSON.stringify(codeKinds) === JSON.stringify(["select", "deepseek-chat", "select", "select", "toggle", "select"]),
    `a gateway default: the model row NAMES that account's model and carries no select (got ${JSON.stringify(codeKinds)})`);
  const head = await p.$eval("#acctdefaults .accttop", n => n.textContent).catch(() => "");
  ok(head.includes("Coding agent defaults") && !head.includes("Runs on"),
    `the header names the role, and does NOT restate what the Runs-on row below it controls (got ${JSON.stringify(head)})`);
  // PER CONFIG DIR plus the gateways — the id space a role default is stored in. The failover list
  // above collapses `main`/`chat` into one row, so reading it here would offer a role an id it
  // cannot hold. ✓ marks the current pick, ● / ○ is Telegram's own readiness glyph.
  const opts = await runsOn();
  ok(JSON.stringify(opts) === JSON.stringify(["● main", "✓ DeepSeek"]),
    `Runs on lists every role option, current one marked (got ${JSON.stringify(opts)})`);
  await p.selectOption("#acctdefaults [data-acc-runs-on]", "claude:main", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  const dp = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.action === "default");
  ok(!!dp && dp.body.id === "claude:main" && dp.body.role === "code",
    `Runs on posts default/claude:main for the selected role (got ${JSON.stringify(dp && dp.body)})`);
  // Same keys, same POST as any other settings control — only the container differs. Index 1, since
  // the Runs-on select is index 0 and is not a settings key at all.
  const eff = (await p.$$("#acctdefaults .setrow select"))[1];
  if (eff) await eff.selectOption("low").catch(() => {});
  await p.waitForTimeout(150);
  const se = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "spawnEffort");
  ok(!!se && se.body.value === "low", `a dial in the block posts spawnEffort=low (got ${JSON.stringify(se && se.body)})`);

  // (c) THE CONTROL for the check above: move the coding default back to a claude: account and the
  // select must come back. Without it, "no select" passes on a block that renders nothing at all.
  await load("claude:main");
  ok((await kinds())[1] === "select", `a claude: default brings the model SELECT back (got ${JSON.stringify(await kinds())})`);

  // (a) THE CHAT TAB: its own three dials, model included — its default is a claude: account.
  await p.click('[data-acc-role="chat"]', { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(300);
  const chat = await labels();
  ok(JSON.stringify(chat) === JSON.stringify(["Runs on", "Chat agent model", "Chat agent effort", "Chat agent mode"]),
    `the chat tab shows Runs on and the chat role's three dials, in order (got ${JSON.stringify(chat)})`);
  ok((await kinds())[1] === "select", "the chat model row carries a select");
  const chead = await p.$eval("#acctdefaults .accttop", n => n.textContent).catch(() => "");
  ok(chead.includes("Chat agent defaults"), `the header follows the tab (got ${JSON.stringify(chead)})`);
  // …and so does the picker: the chat role's own default is marked, not the coding role's.
  ok(JSON.stringify(await runsOn()) === JSON.stringify(["✓ main", "● DeepSeek"]),
    `Runs on follows the tab (got ${JSON.stringify(await runsOn())})`);
  await p.close();
}
{
  // Read-only reaches the new container too — the write gate is the /api/settings read the sheet
  // now takes itself, so it has to be re-proved here rather than inherited from the screen.
  const p = await open(false);
  await p.evaluate(([a, s]) => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? s : {}; },
    [accView([CL("main")]), settingsFixture(false)]);
  await p.evaluate(() => openAccounts()).catch(() => {});
  await p.waitForTimeout(300);
  const operable = await p.$$eval("#acctdefaults .setrow", rs => rs.filter(r => {
    const s = r.querySelector("select"), btn = r.querySelector("button");
    return (s && !s.disabled) || (btn && !btn.disabled);
  }).length);
  ok(operable === 0, `write off: no dial in the role block is operable (got ${operable})`);
  ok((await p.evaluate(() => window.__posts)).length === 0, "write off: nothing was posted");
  await p.close();
}

// ---- 10: the built-in providers are ROLE TARGETS, not failover hops ----------------------------
// A `roleOnly` row can never be selected by the failover chain, so every number and every control
// that describes that chain must be blind to it: the participate count, the ± bounds, the rank
// arrows and the cut-off divider. The falsifier is the divider pair — count them against the FULL
// list and "Inactive · none" disappears while a cut-off line appears in the middle of the failover
// rows, which is a page that looks plausible and is wrong.
{
  const p = await open(true);
  const PROXIES = [
    { id: "proxy:codex", provider: "proxy", roleOnly: true, active: false, model: null, models: [], ready: true, state: "in", members: [{ name: "codex", ready: true }], label: "OpenAI subscription" },
    { id: "proxy:grok", provider: "proxy", roleOnly: true, active: false, model: null, models: [], ready: false, state: "out", members: [{ name: "grok", ready: false }], label: "xAI subscription" },
  ];
  const withProxies = codeDefault => accView(
    [CL("main"), GW("deepseek", "DeepSeek"), ...PROXIES],
    { defaults: { chat: "claude:main", code: codeDefault } });
  const load = async codeDefault => {
    await p.evaluate(([a, s]) => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? s : {}; },
      [withProxies(codeDefault), settingsFixture(true)]);
    await p.evaluate(() => openAccounts()).catch(() => {});
    await p.waitForTimeout(300);
  };

  await load("claude:main");
  const failover = await p.$$eval("#accbody .accttop .copy", ns => {
    const n = ns.find(x => /failover/.test(x.firstElementChild.textContent));
    return n ? n.lastElementChild.textContent.trim() : "";
  }).catch(() => "");
  ok(failover === "2 of 2 accounts participate", `the participate count excludes the role-only rows (got ${JSON.stringify(failover)})`);
  const plus = await p.$$eval("#accbody [data-acc-count]", bs => bs.map(b => `${b.textContent}:${b.disabled}`)).catch(() => []);
  ok(JSON.stringify(plus) === JSON.stringify(["−:false", "+:true"]), `the ± bounds are the failover list's (got ${JSON.stringify(plus)})`);
  const dividers = await p.$$eval("#accbody .acctdivider", ns => ns.map(n => n.textContent.trim()));
  ok(dividers.length === 1 && dividers[0] === "Inactive · none",
    `every account participates, so the cut-off divider does NOT appear (got ${JSON.stringify(dividers)})`);

  // The section of their own, and its rows: STATE ONLY since v0.5.213, and nothing that ranks,
  // re-models or removes them. The role pair left these rows with every other row's — choosing what
  // a role runs on is one control under the role's own tab, not a writer per row.
  const headers = await p.$$eval("#accbody .accttop .copy", ns => ns.map(n => n.textContent.trim()));
  ok(headers.some(h => h.startsWith("Built-in providers") && h.includes("Role targets only — not part of failover")),
    `the built-in section is headed and says what it is (got ${JSON.stringify(headers)})`);
  const row = async (id, sel) => (await p.$$(`[data-account="${id}"] ${sel}`)).length;
  ok((await p.$$("[data-acc-default]")).length === 0, "no row on the sheet carries a per-row role button any more");
  const junk = (await row("proxy:codex", "[data-acc-move]")) + (await row("proxy:codex", "[data-acc-model]"))
    + (await row("proxy:codex", "[data-acc-key]")) + (await row("proxy:codex", "[data-acc-remove]"))
    + (await row("proxy:codex", "[data-acc-signin]")) + (await row("proxy:codex", "[data-acc-logout]"));
  ok(junk === 0, `a built-in row carries no rank, model, key, forget or login control (got ${junk})`);
  // Scoped to `.identity`, which is where a row's own state line lives.
  const metas = await p.$$eval('[data-account^="proxy:"] .identity .acctmeta', ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(metas) === JSON.stringify(["Signed in", "Needs sign-in"]), `each built-in states its own sign-in state (got ${JSON.stringify(metas)})`);

  // CONTROL: a built-in AS the role's default. It is not in `roleOptions` (a role picks from what he
  // ADDED), so the Runs-on select must still NAME it — a picker that silently selected somebody
  // else's row would report the wrong account as the one the role runs on, which is the one thing
  // this sheet exists to say.
  await load("proxy:codex");
  // Guarded, like every other read in this file: on a page with no Runs-on select at all the
  // unguarded form throws and hides every check after it — which is exactly what a control run is.
  const kept = await p.$$eval("#acctdefaults [data-acc-runs-on] option", ns => ns[0] ? [ns[0].textContent.trim(), ns[0].selected] : []).catch(() => []);
  ok(JSON.stringify(kept) === JSON.stringify(["✓ OpenAI subscription", true]),
    `a default this box no longer offers is still named and still selected (got ${JSON.stringify(kept)})`);
  const sub = await p.$$eval("#acctdefaults .setrow .sub", ns => ns.map(n => n.textContent.trim()));
  ok(sub[1] === "set by the provider", `a built-in has no model control anywhere, and the row says so (got ${JSON.stringify(sub)})`);

  // …AND THE SERVER SENDS NONE OF THEM SINCE v0.5.212 (the owner: the pickers should list only the
  // accounts/providers he ADDED), so the fixture above is now a "if one ever arrives" guard and THIS
  // is the shipped shape. A title over an empty block is a promise the payload did not make, so the
  // header goes with the rows — nothing about the failover half may change either.
  await p.evaluate(([a, s]) => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? s : {}; },
    [{ ...withProxies("claude:main"), accounts: withProxies("claude:main").accounts.filter(x => !x.roleOnly) }, settingsFixture(true)]);
  await p.evaluate(() => openAccounts()).catch(() => {});
  await p.waitForTimeout(300);
  const bare = await p.$$eval("#accbody .accttop .copy", ns => ns.map(n => n.textContent.trim()));
  ok(!bare.some(h => h.includes("Built-in providers")), `no role-only rows ⇒ no built-in section at all, header included (got ${JSON.stringify(bare)})`);
  ok((await p.$$('[data-account^="proxy:"]')).length === 0, "no role-only rows ⇒ no built-in row");
  ok(bare.some(h => h === "Coding failover2 of 2 accounts participate"), `the failover half is untouched by their absence (got ${JSON.stringify(bare)})`);
  await p.close();
}

// ---- 11: an account row is a SUBSCRIPTION, and it answers for every dir behind it ---------------
// The owner's mirror ruling, 2026-08-21 ("yes mirror the slash command settings"): two config dirs on
// one login are ONE row here, exactly as on the 👤 panel. The failure this must catch is the G5 defect
// (v0.5.201), which is why the fixture is MIXED: a row whose dirs disagree used to read green with a
// single Log out aimed at the dir already signed out. It has to say which dir is out, offer that dir
// its own named Sign in, and still offer the one Log out for the login the row does have.
// CONTROL: the same row all-in — one Log out, no Sign in, a solid dot — because "names the dir that
// is out" would pass on a row that always printed a name.
//
// Two checks here are NOT falsifiable in a browser and are stated as bookkeeping: the collapse is
// done server-side, so the pre-change page renders the same one row off this fixture. What the
// projection does with two dirs is provider-accounts.test.ts's; what the PAGE does with the row it
// is handed is everything below them, and all of that fails against 0.5.216.
{
  const p = await open(true);
  const load = async dirs => {
    await p.evaluate(([a, s]) => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? s : {}; },
      [accView([CL("main", dirs, { label: "owner@example.com · Max 20x (main, chat)" }), GW("deepseek", "DeepSeek")]), settingsFixture(true)]);
    await p.evaluate(() => openAccounts()).catch(() => {});
    await p.waitForTimeout(300);
  };
  const btns = () => p.$$eval('[data-account="claude:main"] .acctactions button', ns => ns.map(n => n.textContent.trim()));

  await load([["main", true], ["chat", false]]);
  const rows = await p.$$eval('#accbody [data-account^="claude:"]', ns => ns.map(n => n.dataset.account));
  ok(JSON.stringify(rows) === JSON.stringify(["claude:main"]),
    `two dirs on one subscription are ONE row (got ${JSON.stringify(rows)})`);
  const name = await p.$eval('[data-account="claude:main"] .acctname', n => n.textContent.trim()).catch(() => "");
  ok(name === "owner@example.com · Max 20x (main, chat)", `the row names the subscription AND its dirs (got ${JSON.stringify(name)})`);
  const meta = await p.$eval('[data-account="claude:main"] .identity .acctmeta', n => n.textContent.trim()).catch(() => "");
  ok(meta === "Claude · chat signed out", `a MIXED row names the dir that is out, never "Signed in" (got ${JSON.stringify(meta)})`);
  // The dot is the panel's two colours split, not a third — a flat green or a flat grey would each
  // be a claim about dirs this row cannot make.
  const dot = await p.$eval('[data-account="claude:main"] .acctstatus', n => [n.className.trim(), getComputedStyle(n).backgroundImage !== "none"]).catch(() => []);
  ok(JSON.stringify(dot) === JSON.stringify(["acctstatus mixed", true]), `a MIXED row paints the half dot (got ${JSON.stringify(dot)})`);
  const mixedBtns = await btns();
  ok(JSON.stringify(mixedBtns) === JSON.stringify(["Sign in chat", "Forget chat", "Log out"]),
    `mixed: a NAMED Sign in for the dir that is out, Forget for the non-main dir, one Log out (got ${JSON.stringify(mixedBtns)})`);
  await p.click('[data-account="claude:main"] [data-acc-signin]', { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  const si = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.action === "signin-claude");
  ok(!!si && si.body.name === "chat", `Sign in posts the DIR it names, not the row (got ${JSON.stringify(si && si.body)})`);

  // CONTROL: every dir in.
  await load([["main", true], ["chat", true]]);
  const inBtns = await btns();
  ok(JSON.stringify(inBtns) === JSON.stringify(["Forget chat", "Log out"]),
    `all in: one Log out and no Sign in at all (got ${JSON.stringify(inBtns)})`);
  const inMeta = await p.$eval('[data-account="claude:main"] .identity .acctmeta', n => n.textContent.trim()).catch(() => "");
  ok(inMeta === "Claude · Signed in", `all in: the plain state line (got ${JSON.stringify(inMeta)})`);
  const inDot = await p.$eval('[data-account="claude:main"] .acctstatus', n => n.className.trim()).catch(() => "");
  ok(inDot === "acctstatus ready", `all in: the solid dot (got ${JSON.stringify(inDot)})`);
  // …and the role picker still sees BOTH dirs, which is the whole reason grouping the rows is safe.
  const opts = await p.$$eval("#acctdefaults [data-acc-runs-on] option", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(opts) === JSON.stringify(["✓ main", "● chat", "● DeepSeek"]),
    `Runs on still lists every CONFIG DIR behind the collapsed row (got ${JSON.stringify(opts)})`);
  await p.close();
}

await b.close();
console.log(bad ? `\n❌ ${bad} failure(s)` : "\n✅ all checks passed");
process.exit(bad ? 1 : 0);
