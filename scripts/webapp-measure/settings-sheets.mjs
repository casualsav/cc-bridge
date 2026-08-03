import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// PHASE C — the settings screen's three grouped sheets (Model defaults / Voice / GitHub), measured in
// a real browser against a fixture payload.
//
// What this has to prove, and why each claim needs its own check:
//  1. GROUPING IS PRESENTATIONAL. Every key that moved into a sheet is still rendered, by the same row
//     builder, with the same control — it is in a different container, not a different implementation.
//     Counting rows on the main screen cannot see this; the sheet bodies are counted directly.
//  2. THE ROW ORDER IS UNCHANGED. `meta` is still the single source of order (settings-parity.test.ts
//     reads it); this checks the SCREEN agrees — the group row appears where its first key sat.
//  3. A CONTROL STILL WRITES. The POST body is captured per control: key AND value. A sheet that opens
//     and renders but posts nothing looks identical in a screenshot.
//  4. READ-ONLY IS STILL READ-ONLY. With write off, no control in any sheet is operable — the flag
//     split moved which env var decides that, so the OFF case has to be re-proved, not assumed.
//  5. GITHUB'S DEVICE-CODE FLOW SURFACES ITS CODE. The login runs for minutes; the sheet must show the
//     code the daemon reports rather than a spinner that never resolves.
//
// CONTROL: the same page with `write:false`, which must fail every write claim and pass every render
// one. Without it "the toggles didn't post" would pass on a page whose sheets never opened.
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");

let bad = 0;
const ok = (cond, label) => { console.log(`${cond ? "OK  " : "FAIL"}  ${label}`); if (!cond) bad++; };

// The payload shape the daemon serves after phase B, trimmed to what this file measures.
const settingsFixture = (write) => ({
  write,
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
    mcp: { value: false, editable: true },
    mode: { value: null, editable: false }, model: { value: null, editable: false }, effort: { value: null, editable: false },
  },
});

const GH = { installed: true, accounts: [{ user: "casualsav", host: "github.com", active: true }, { user: "alt", host: "github.com", active: false }], login: { active: false } };

const b = await chromium.launch();
const open = async (write, gh = GH) => {
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
  }, [settingsFixture(write), gh]);
  await p.waitForTimeout(400);
  return p;
};

// ---- 1 + 2: grouping and order ----------------------------------------------------------------
{
  const p = await open(true);
  const rows = await p.$$eval("#tab-settings .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(rows[0] === "👤 Accounts", `screen row 1 is Accounts (got ${rows[0]})`);
  ok(rows[1] === "🧑‍💻 Model defaults", `screen row 2 is the Model defaults GROUP, where spawnModel sat (got ${rows[1]})`);
  ok(rows[2] === "🐙 GitHub", `screen row 3 is GitHub (got ${rows[2]})`);
  ok(!rows.includes("Coding session model"), "a grouped key does NOT also render on the screen");

  const mdef = await p.$$eval("#mdefbody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(JSON.stringify(mdef) === JSON.stringify(["Coding session model", "Coding session effort", "Chat agent model", "Chat agent effort", "Auto — agent spawns pick", "Fable for agents"]),
    `the Model defaults sheet holds all six dials in panel order (got ${JSON.stringify(mdef)})`);
  const voice = await p.$$eval("#voicebody .setrow .lbl > div:first-child", ns => ns.map(n => n.textContent.trim()));
  ok(voice.length === 6, `the Voice sheet holds the six voice controls (got ${voice.length}: ${JSON.stringify(voice)})`);
  // Grouping must not lose a control TYPE either: the six model-defaults rows are 5 selects + 1 toggle.
  const kinds = await p.$$eval("#mdefbody .setrow", rs => rs.map(r => r.querySelector("select") ? "select" : r.querySelector("button") ? "toggle" : "ro"));
  ok(kinds.filter(k => k === "select").length === 5 && kinds.filter(k => k === "toggle").length === 1,
    `sheet controls keep their types (got ${JSON.stringify(kinds)})`);
  await p.close();
}

// ---- 3: a control inside a sheet still writes, with the right key and value --------------------
{
  const p = await open(true);
  await p.click("#tab-settings .setrow:nth-child(2)");            // open Model defaults
  await p.waitForTimeout(250);
  // Guarded so the CONTROL run (a page with no sheets) reports failures instead of throwing on the
  // first missing selector and hiding every check after it.
  ok(await p.$eval("#mdef", n => n.classList.contains("show")).catch(() => false), "tapping the group row opens its sheet");
  await p.selectOption("#mdefbody .setrow:nth-child(3) select", "haiku").catch(() => {});   // chatModel
  await p.waitForTimeout(150);
  const posts = await p.evaluate(() => window.__posts);
  const m = posts.find(x => x.path.includes("/api/settings/set"));
  ok(!!m && m.body.key === "chatModel" && m.body.value === "haiku",
    `the chat-model select posts chatModel=haiku (got ${JSON.stringify(m && m.body)})`);
  // And the toggle inside the same sheet, which takes a different branch of the builder.
  await p.click("#mdefbody .setrow:nth-child(5) button").catch(() => {});         // spawnAuto, currently false
  await p.waitForTimeout(150);
  const t = (await p.evaluate(() => window.__posts)).filter(x => x.body && x.body.key === "spawnAuto")[0];
  ok(!!t && t.body.value === true, `the auto toggle posts spawnAuto=true (got ${JSON.stringify(t && t.body)})`);
  await p.close();
}

// ---- 4: read-only stays read-only through the sheets -------------------------------------------
{
  const p = await open(false);
  await p.click("#tab-settings .setrow:nth-child(2)");
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
  await p.click("#tab-settings .setrow:nth-child(3)");            // GitHub row
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
  await p.click("#tab-settings .setrow:nth-child(3)");
  await p.waitForTimeout(300);
  await p.click('#ghbody [data-gh="alt"] [data-gh-switch]').catch(() => {});
  await p.waitForTimeout(150);
  const g = (await p.evaluate(() => window.__posts)).find(x => x.path.includes("/api/github/action"));
  ok(!!g && g.body.action === "switch" && g.body.user === "alt",
    `Make active posts switch/alt (got ${JSON.stringify(g && g.body)})`);
  await p.close();
}

await b.close();
console.log(bad ? `\n❌ ${bad} failure(s)` : "\n✅ all checks passed");
process.exit(bad ? 1 : 0);
