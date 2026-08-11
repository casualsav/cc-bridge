import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The .work row (last child of #dfeed, painted by paintWork() off lastDrill.status). Stub the fetch
// layer with the EXACT payload the daemon produced, per the theming trap in the README: colours come
// from --tg-theme-* vars, not prefers-color-scheme, so light has to be injected the way themes.mjs does.
const LIGHT = { "bg-color":"#ffffff","secondary-bg-color":"#f1f1f1","text-color":"#000000",
                "hint-color":"#707579","link-color":"#2481cc","button-color":"#2481cc","button-text-color":"#ffffff" };
const FEED = { sid:"eea261db", name:"cc-bridge", working:true,
  cwd:"~/projects/cc-bridge", model:"Opus 5", effort:"high",
  status:{ verb:"Incubating", elapsed:"2m 11s", tokens:"4.7k tokens" },
  items:[
    { role:"user", text:"bring through the token amount and everything on that line", ts:1785200000000 },
    { role:"assistant", text:"Reading the client's feed renderer to place this correctly.", ts:1785200060000 },
  ] };
// Nothing running and nothing to show: the row must not exist. `working: false` as well as no status,
// because since 2026-08-11 the transcript's own `working` is a second reason to keep the row up (see
// THE HOLD below) — a control that left it true would be asserting the opposite of the rule.
const NO_STATUS = { ...FEED, status: undefined, working: false };
// The pane's line went unreadable mid-turn while the transcript still says the turn is running.
// Measured: four consecutive seconds of exactly this on a real turn (`scripts/work-row-gap.ts`).
const HOLE = { ...FEED, status: undefined, working: true };
// A status with the transcript NOT yet showing a turn — the seconds between his message landing and
// the first assistant entry. The row must be up: the pane knows first, and a gate on `working` here
// (tried and reverted 2026-08-11) blanked the row for the whole thinking pause after every prompt.
// The mis-parse this looks like it should catch is gated in the DAEMON instead, which ships no status
// for a pane `detectWorking` calls idle — see prompt.test.ts, "a REPLY is not a spinner line".
const EARLY_STATUS = { ...FEED, working: false };
const SESSION = { sid:"eea261db", name:"cc-bridge", alive:true, working:true, cwd:"~/projects/cc-bridge",
  model:"Opus 5", effort:"high" };
const OUT = process.argv[2] || "work";
// The page under test, so the checks below can be run against a PRE-CHANGE copy — the harness's own
// first rule (validate the instrument against a known-truth control). On a page without the hold, the
// HOLD check must report GONE.
const PAGE = process.argv[3] || "/home/ubuntu/projects/cc-bridge/webapp/index.html";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });

async function openPage(b, { vars, feed, reducedMotion }) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", () => {});
  if (reducedMotion) await p.emulateMedia({ reducedMotion: "reduce" });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(300);
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v))
    document.documentElement.style.setProperty("--tg-theme-" + k, val); }, vars);
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed
      : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed, session: SESSION });
  await p.waitForTimeout(600);   // idle: let the 3s poll's first paint and the glyph timer settle
  return p;
}

const b = await chromium.launch();

// ---- Known-truth control FIRST (per README rule 1): status absent -> no .work row at all. ----
{
  const p = await openPage(b, { vars: null, feed: NO_STATUS });
  const has = await p.evaluate(() => !!document.querySelector(".work"));
  console.log("CONTROL (status absent) — .work present:", has, has ? "FINDING: renders anyway!" : "OK, absent as expected");
  await p.close();
}

// ---- Second control: a status BEFORE the transcript catches up -> the row is already up. ----
{
  const p = await openPage(b, { vars: null, feed: EARLY_STATUS });
  const has = await p.evaluate(() => !!document.querySelector(".work"));
  console.log("CONTROL (status present, transcript not yet working) — .work present:", has,
    has ? "OK, the pane knows first" : "FINDING: blank for the whole thinking pause!");
  await p.close();
}

// ---- THE HOLD: a mid-turn poll with no readable status must not blink the row out. ----
// The owner, 2026-08-11: "the clauding indicator is still dropping between when I send a prompt and
// work begins". Driven as a SEQUENCE, because that is the defect — one payload with a status, then
// one without while the turn runs on. A single-payload check passes on the broken page.
{
  const p = await openPage(b, { vars: null, feed: FEED });
  const before = await p.evaluate(() => document.querySelector("#dwork .v").textContent);
  await p.evaluate(hole => { window.api = async path => path.includes("session/feed") ? hole
    : path.includes("sessions") ? { sessions: [{ sid: "eea261db", name: "cc-bridge", alive: true, working: true }] } : {};
    return renderDrill(); }, HOLE);
  await p.waitForTimeout(300);
  const held = await p.evaluate(() => {
    const el = document.querySelector("#dwork");
    return el ? { verb: el.querySelector(".v").textContent, meta: el.querySelector(".m").textContent } : null;
  });
  console.log("HOLD (turn running, pane line unreadable) — row:", held ? JSON.stringify(held) : "GONE",
    held ? (held.verb === before ? "OK, held with its verb" : "row kept, verb changed to " + held.verb) : "FINDING: blinks out mid-turn!");
  // …and the turn ENDING still tears it down, which is the half a hold is most likely to break.
  await p.evaluate(idle => { window.api = async path => path.includes("session/feed") ? idle
    : path.includes("sessions") ? { sessions: [{ sid: "eea261db", name: "cc-bridge", alive: true, working: false }] } : {};
    return renderDrill(); }, NO_STATUS);
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => !!document.querySelector("#dwork"));
  console.log("HOLD RELEASE (turn ended) — .work present:", after, after ? "FINDING: the row outlived the turn!" : "OK, gone");
  await p.close();
}

// ---- Reduced motion: glyph must be static, verb/elapsed/tokens still render. ----
{
  const p = await openPage(b, { vars: null, feed: FEED, reducedMotion: true });
  const g0 = await p.locator("#dwork .g").textContent();
  await p.waitForTimeout(500);   // several 130ms glyph-tick intervals, if one were (wrongly) running
  const g1 = await p.locator("#dwork .g").textContent();
  const text = await p.evaluate(() => ({ v: document.querySelector("#dwork .v").textContent,
    m: document.querySelector("#dwork .m").textContent }));
  console.log("REDUCED MOTION — glyph t0:", JSON.stringify(g0), "glyph t1 (+500ms):", JSON.stringify(g1),
    "static:", g0 === g1, "verb:", JSON.stringify(text.v), "meta:", JSON.stringify(text.m));
  await p.close();
}

// ---- Dark + light: full view and cropped view (message-above + .work row) + measurements. ----
for (const [name, vars] of [["dark", null], ["light", LIGHT]]) {
  const p = await openPage(b, { vars, feed: FEED });

  const full = `${OUT}/work-${name}-full.png`;
  await p.screenshot({ path: full });

  const cropRect = await p.evaluate(() => {
    const work = document.getElementById("dwork");
    const msgs = [...document.querySelectorAll("#dfeed .msg")];
    const above = msgs[msgs.length - 1];   // last real message, immediately above .work
    const wr = work.getBoundingClientRect(), ar = above.getBoundingClientRect();
    const x = Math.min(wr.x, ar.x), y = Math.min(wr.y, ar.y);
    const right = Math.max(wr.x + wr.width, ar.x + ar.width);
    const bottom = Math.max(wr.y + wr.height, ar.y + ar.height);
    return { x, y, width: right - x, height: bottom - y };
  });
  const cropped = `${OUT}/work-${name}-crop.png`;
  await p.screenshot({ path: cropped, clip: cropRect });

  const measure = await p.evaluate(() => {
    const work = document.getElementById("dwork");
    const m = document.querySelector("#dwork .m");
    const cs = getComputedStyle(work), ms = getComputedStyle(m);
    const wr = work.getBoundingClientRect();
    const composer = document.querySelector(".composer").getBoundingClientRect();
    const overlap = wr.bottom > composer.top;   // .work's bottom edge crossing the composer's top edge
    return {
      workColor: cs.color, workFontSize: cs.fontSize, workHeight: +wr.height.toFixed(2),
      mFontFamily: ms.fontFamily, mFontVariantNumeric: ms.fontVariantNumeric,
      workBottom: +wr.bottom.toFixed(2), composerTop: +composer.top.toFixed(2), overlap,
    };
  });
  console.log(name.toUpperCase(), JSON.stringify(measure));
  console.log(name, "full:", full, "crop:", cropped, "cropRect:", JSON.stringify(cropRect));
  await p.close();
}

await b.close();
