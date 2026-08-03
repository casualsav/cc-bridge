import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE LEAK, and the CLASS it belongs to: a settings surface painting on a screen that is not
// Settings. Reported from the owner's phone on the Sessions screen.
//
// The sweep is deliberately not "look for the one thing he saw". It walks EVERY screen and asks what
// of the settings build is visible there — the sheet wrappers, their bodies, and any settings row —
// using getBoundingClientRect + computed display, because an element with no `display:none` is laid
// out as ordinary block content and a screenshot of the top of the page can miss it below the fold.
//
// CONTROL: the same sweep on the Settings screen, where these elements SHOULD exist — a fix that
// hides them everywhere would pass a leak check and ship a broken settings screen.
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");

let bad = 0;
const ok = (c, label) => { console.log(`${c ? "OK  " : "FAIL"}  ${label}`); if (!c) bad++; };

// Every element this build added to the document, by id. A sheet WRAPPER is the backdrop: visible,
// it covers the screen; unstyled, it is a plain block that pushes content down.
const ADDED = ["mdef", "voicesheet", "ttssheet", "ghsheet", "mdefbody", "voicebody", "ttsbody", "ghbody", "accaddclaude"];

const SESSIONS = [{ sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, working: true, state: "working", task: "t", model: "Opus 5", effort: "high", ctxPct: 40, branch: "main", subagents: 0 }];

const b = await chromium.launch();
const open = async (tab) => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(([ss, t]) => {
    window.api = async q => q.includes("/api/sessions") ? { sessions: ss }
      // `rows` is the served structure the screen renders (settingsRows() in daemon.ts) — without it
      // the settings screen is empty, and an empty screen leaks nothing for the wrong reason.
      : q.includes("/api/settings") ? { write: true, rows: [
          { id: "accounts", name: "👤 Accounts", keys: ["accounts"], panel: "accounts" },
          { id: "spawnDefaults", name: "🧑‍💻 Model defaults", keys: ["spawnModel", "spawnEffort"], value: "opus · high" },
          { id: "github", name: "🐙 GitHub", keys: ["github"], panel: "github" },
          { id: "batchAllow", name: "⚡ Batch allow", keys: ["batchAllow"] },
          { id: "tts", name: "🔊 Voice replies", keys: ["voice"], value: "off" },
        ], settings: {
          accounts: { value: "1", editable: false }, spawnModel: { value: "opus", editable: true, options: ["opus"] },
          spawnEffort: { value: "high", editable: true, options: ["high"] }, github: { value: "x", editable: false },
          voice: { value: false, editable: true },
          batchAllow: { value: true, editable: true } } }
      : q.includes("/api/github") ? { installed: true, accounts: [], login: { active: false } }
      : q.includes("/api/auto") ? { cron: [], queue: [] } : {};
    showTab(t);
  }, [SESSIONS, tab]);
  await p.waitForTimeout(500);
  return p;
};

// What is actually PAINTED: laid out, non-zero, and not display:none. A rect alone is not enough —
// a hidden element reports zeros — and computed display alone is not enough either, since an
// unstyled div is `display: block` whether or not it has content in it.
const painted = (p) => p.evaluate(ids => ids.map(id => {
  const n = document.getElementById(id);
  if (!n) return { id, present: false };
  const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
  return { id, present: true, display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
           painted: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0 };
}), ADDED);

// ---- The leak: the Sessions screen -------------------------------------------------------------
{
  const p = await open("sessions");
  const seen = await painted(p);
  const leaking = seen.filter(x => x.painted);
  console.log("sessions screen:", JSON.stringify(seen));
  ok(leaking.length === 0, `nothing from the settings build paints on Sessions (leaking: ${JSON.stringify(leaking.map(x => `${x.id} ${x.w}x${x.h} ${x.display}`))})`);
  // The same question asked the other way: does any settings ROW exist outside #tab-settings?
  // #accounts is on the list because the ✳️ Codex dials are settings rows living in that sheet now.
  const stray = await p.$$eval(".setrow", ns => ns.filter(n => !n.closest("#tab-settings") && !n.closest("#mdef") && !n.closest("#voicesheet") && !n.closest("#ttssheet") && !n.closest("#accounts")).length);
  ok(stray === 0, `no settings row is parented outside the settings screen or its sheets (got ${stray})`);
  // And the practical symptom: the sessions list must start at the top of the scroller, not be
  // pushed down by an unstyled block above it.
  const top = await p.$eval("#tab-sessions", n => Math.round(n.getBoundingClientRect().top));
  ok(top < 200, `the sessions panel is not pushed down the page (top=${top})`);
  await p.close();
}

// ---- The same sweep on Scheduled, which shares the screen and never opens a sheet ---------------
{
  const p = await open("scheduled");
  const leaking = (await painted(p)).filter(x => x.painted);
  ok(leaking.length === 0, `nothing from the settings build paints on Scheduled (leaking: ${JSON.stringify(leaking.map(x => x.id))})`);
  await p.close();
}

// ---- CONTROL: on Settings the sheets must EXIST (closed), and the screen must be complete -------
{
  const p = await open("settings");
  const seen = await painted(p);
  ok(seen.every(x => x.present), `every settings element is still in the document (${JSON.stringify(seen.filter(x => !x.present).map(x => x.id))})`);
  const wrappers = seen.filter(x => ["mdef", "voicesheet", "ttssheet", "ghsheet"].includes(x.id));
  ok(wrappers.every(x => !x.painted), "a CLOSED sheet paints nothing even on its own screen");
  ok((await p.$$("#tab-settings .setrow")).length > 0, "the settings screen still renders its rows");
  // Opening one still works — a fix that hid the sheets for good would pass everything above.
  await p.evaluate(() => openSheet("mdef"));
  await p.waitForTimeout(300);
  const open1 = (await painted(p)).find(x => x.id === "mdef");
  ok(!!open1 && open1.painted, `an OPENED sheet paints (${JSON.stringify(open1)})`);
  await p.close();
}

await b.close();
console.log(bad ? `\n❌ ${bad} failure(s)` : "\n✅ all checks passed");
process.exit(bad ? 1 : 0);
