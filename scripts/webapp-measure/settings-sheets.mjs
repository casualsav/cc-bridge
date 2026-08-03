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
  { id: "spawnDefaults", name: "🧑‍💻 Model defaults", keys: ["spawnModel", "spawnEffort", "chatModel", "chatEffort", "spawnAuto", "fableForAgents"], value: "💬 fable · medium · 🧑‍💻 opus · high" },
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
// are served but named by no ROW — they belong to the Accounts panel now, and their absence from the
// screen is itself a claim below.
const settingsFixture = (write, rows = ROWS) => ({
  write,
  rows,
  settings: {
    accounts: { value: "2 · 🔀 off", editable: false, label: "tap to manage" },
    spawnModel: { value: "opus", editable: true, options: ["fable", "opus", "sonnet", "haiku"], label: "coding sessions" },
    spawnEffort: { value: "high", editable: true, options: ["low", "medium", "high", "xhigh", "max"], label: "coding sessions" },
    chatModel: { value: "fable", editable: true, options: ["fable", "opus", "sonnet", "haiku"], label: "the chat agent" },
    chatEffort: { value: "medium", editable: true, options: ["low", "medium", "high", "xhigh", "max"], label: "the chat agent" },
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
  ok(!rows.includes("Coding session model"), "a grouped key does NOT also render on the screen");
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
  const scrambled = [ROWS[3], ROWS[0], ROWS[8], ROWS[1], ROWS[6]];
  const p = await open(true, GH, scrambled);
  const rows = await screenRows(p);
  ok(JSON.stringify(rows) === JSON.stringify(scrambled.map(r => r.name)),
    `a scrambled served order is rendered scrambled — the client keeps no order of its own (got ${JSON.stringify(rows)})`);
  await p.close();
}

// ---- 2: grouping is presentational ------------------------------------------------------------
{
  const p = await open(true);
  const mdef = await p.$$eval("#mdefbody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(mdef) === JSON.stringify(["Coding session model", "Coding session effort", "Chat agent model", "Chat agent effort", "Auto — agent spawns pick", "Fable for agents"]),
    `the Model defaults sheet holds all six dials in panel order (got ${JSON.stringify(mdef)})`);
  // VOICE IS TWO ROWS AND TWO SHEETS, because /settings' root has two rows. A merged sheet was this
  // app's own deviation, and it is what a served structure cannot express.
  const voice = await p.$$eval("#voicebody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(voice) === JSON.stringify(["Transcription backend", "Local Whisper model"]),
    `the transcription sheet holds its two controls (got ${JSON.stringify(voice)})`);
  const tts = await p.$$eval("#ttsbody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(tts) === JSON.stringify(["Voice replies", "Speak replies", "Voice engine", "Piper voice"]),
    `the voice-replies sheet holds its four controls (got ${JSON.stringify(tts)})`);
  // Grouping must not lose a control TYPE either: the six model-defaults rows are 5 selects + 1 toggle.
  const kinds = await p.$$eval("#mdefbody .setrow", rs => rs.map(r => r.querySelector("select") ? "select" : r.querySelector("button") ? "toggle" : "ro"));
  ok(kinds.filter(k => k === "select").length === 5 && kinds.filter(k => k === "toggle").length === 1,
    `sheet controls keep their types (got ${JSON.stringify(kinds)})`);
  await p.close();
}

// ---- 3: a control inside a sheet still writes, with the right key and value --------------------
{
  const p = await open(true);
  await p.click("#tab-settings .setrow:nth-child(2)", { timeout: 2000 }).catch(() => {});            // open Model defaults
  await p.waitForTimeout(250);
  // Guarded so the CONTROL run (a page with no sheets) reports failures instead of throwing on the
  // first missing selector and hiding every check after it.
  ok(await p.$eval("#mdef", n => n.classList.contains("show")).catch(() => false), "tapping the group row opens its sheet");
  await p.selectOption("#mdefbody .setrow:nth-child(3) select", "haiku", { timeout: 2000 }).catch(() => {});   // chatModel
  await p.waitForTimeout(150);
  const posts = await p.evaluate(() => window.__posts);
  const m = posts.find(x => x.path.includes("/api/settings/set"));
  ok(!!m && m.body.key === "chatModel" && m.body.value === "haiku",
    `the chat-model select posts chatModel=haiku (got ${JSON.stringify(m && m.body)})`);
  // And the toggle inside the same sheet, which takes a different branch of the builder.
  await p.click("#mdefbody .setrow:nth-child(5) button", { timeout: 2000 }).catch(() => {});         // spawnAuto, currently false
  await p.waitForTimeout(150);
  const t = (await p.evaluate(() => window.__posts)).filter(x => x.body && x.body.key === "spawnAuto")[0];
  ok(!!t && t.body.value === true, `the auto toggle posts spawnAuto=true (got ${JSON.stringify(t && t.body)})`);
  // A flat row on the screen itself. The sheet above is a full-screen backdrop, so it has to go
  // first — a click that lands on the backdrop posts nothing and reads exactly like a dead control.
  await p.evaluate(() => closeSheet("mdef"));
  await p.waitForTimeout(250);
  await p.click("#tab-settings .setrow:nth-child(4) button", { timeout: 2000 }).catch(() => {});     // batchAllow, currently true
  await p.waitForTimeout(150);
  const ba = (await p.evaluate(() => window.__posts)).filter(x => x.body && x.body.key === "batchAllow")[0];
  ok(!!ba && ba.body.value === false, `the batch-allow toggle posts batchAllow=false (got ${JSON.stringify(ba && ba.body)})`);
  await p.close();
}

// ---- 4: read-only stays read-only through the sheets -------------------------------------------
{
  const p = await open(false);
  await p.click("#tab-settings .setrow:nth-child(2)", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(250);
  const operable = await p.$$eval("#mdefbody .setrow", rs => rs.filter(r => {
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
  await p.click("#tab-settings .setrow:nth-child(3)", { timeout: 2000 }).catch(() => {});            // GitHub row
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
  await p.click("#tab-settings .setrow:nth-child(3)", { timeout: 2000 }).catch(() => {});
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
  const accounts = codex => ({
    accounts: [{ id: "claude:main", label: "main", providerLabel: "Claude", authLabel: "subscription", ready: true, models: ["opus"], model: "opus" }],
    activeCount: 1, defaults: { chat: "claude:main", code: "claude:main" }, catalog: [], auto: false, ...(codex ? { codex } : {}),
  });
  await p.evaluate(a => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? { write: true, rows: [], settings: {} } : {}; },
    accounts({ model: "gpt-5.6-sol", effort: "high", efforts: ["default", "low", "medium", "high", "xhigh"] }));
  await p.evaluate(() => openAccounts()).catch(() => {});
  await p.waitForTimeout(300);
  const names = await p.$$eval("#accbody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(names) === JSON.stringify(["✳️ Codex model", "✳️ Codex effort"]),
    `the accounts sheet carries both Codex dials (got ${JSON.stringify(names)})`);
  const f = await p.$("#accbody input.ro.edit");
  ok(await f?.inputValue() === "gpt-5.6-sol", "the Codex model field carries the served value");
  if (f) { await f.fill("gpt-5.6-mini"); await f.evaluate(n => n.blur()); }
  await p.waitForTimeout(150);
  const cm = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "codexModel");
  ok(!!cm && cm.body.value === "gpt-5.6-mini", `the Codex field posts codexModel (got ${JSON.stringify(cm && cm.body)})`);
  await p.selectOption("#accbody .setrow select", "low", { timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(150);
  const ce = (await p.evaluate(() => window.__posts)).find(x => x.body && x.body.key === "codexEffort");
  ok(!!ce && ce.body.value === "low", `the Codex effort select posts codexEffort (got ${JSON.stringify(ce && ce.body)})`);

  // No Codex on the box → no dials. The rows are the daemon's to serve here too.
  await p.evaluate(a => { window.api = async q => q.includes("/api/provider-accounts") ? a : q.includes("/api/settings") ? { write: true, rows: [], settings: {} } : {}; }, accounts(null));
  await p.evaluate(() => openAccounts()).catch(() => {});
  await p.waitForTimeout(250);
  ok((await p.$$("#accbody .setrow")).length === 0, "no Codex on the box: the accounts sheet shows no Codex dials");
  await p.close();
}

// ---- 8: the Claude-account controls (1.5 register, 1.7 two-step remove) -------------------------
// The claim that matters for 1.7 is the SHAPE: the confirm must show what the DAEMON said would go,
// and a declined confirm must remove nothing. A one-shot remove would look identical until the day
// a row stood for two config dirs.
{
  const p = await open(true);
  await p.evaluate(() => {
    window.api = async q => q.includes("/api/provider-accounts") ? {
      accounts: [{ id: "claude:main", label: "main", providerLabel: "Claude", authLabel: "subscription", ready: true, models: ["opus"], model: "opus" },
                 { id: "claude:work", label: "work", providerLabel: "Claude", authLabel: "subscription", ready: true, models: ["opus"], model: "opus" }],
      activeCount: 2, defaults: { chat: "claude:main", code: "claude:main" }, catalog: [], auto: false,
    } : q.includes("/api/settings") ? { write: true, rows: [], settings: {} } : {};
    window.writeOp = async (path, body) => {
      window.__posts.push({ path, body });
      return body.action === "remove-claude-plan"
        ? { ok: true, plan: { label: "work", doomed: [{ name: "work", configDir: "/home/u/.claude-work" }], kept: ["main"] } }
        : { ok: true };
    };
    window.confirm = m => { window.__confirm = m; return window.__answer; };
    window.prompt = () => window.__prompt;
  });
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

await b.close();
console.log(bad ? `\n❌ ${bad} failure(s)` : "\n✅ all checks passed");
process.exit(bad ? 1 : 0);
