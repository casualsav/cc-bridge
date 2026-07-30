import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// THE SAME SESSION, THE SAME MOMENT, THE SAME DOT — on the Sessions card and on the drill-in header it
// opens onto. The owner, 2026-07-30: his chat lane merely waiting for him showed solid green on the
// list and ORANGE in the chat view at the same instant. Cause: two surfaces, two copies of the mapping,
// and the header's copy had no chat branch (`SessionFeed` carried no `chat` flag to branch on).
//
// So this measures PARITY, not colours-per-state: one fixture per case, rendered into BOTH surfaces in
// the SAME page, and the two dots must agree on all three things a dot says —
//
//   the CLASS (what the client decided), the RENDERED PIXEL (a declared colour that resolves to the
//   ground passes every computed-style assertion and is invisible on the device), and whether it
//   ANIMATES (stillness is what tells waiting from working, so a colour match with a pulse mismatch is
//   still two different indicators).
//
// The matrix is every state a session can be in — working · waiting-with-a-reason · waiting chat lane ·
// unreported · idle · errored — because the ask was parity for EVERY state, not a fix for the one that
// was reported. A per-state colour is asserted only where the parity claim needs an anchor: two
// surfaces agreeing on the WRONG colour would pass a pure-equality check, so the waiting chat lane is
// also pinned to green-and-still and the waiting worker to amber-and-still.
//
// It also found a defect parity alone would have passed: `errored` painted NO dot on either surface
// (the `.err` toast class's `display: none` reaching `.dot.err`), so the two surfaces agreed perfectly
// on nothing. That is asserted as ink, not as equality.
//
// CONTROL: the page pinned before the fix. The chat-lane and errored checks MUST fail there; every
// other state's parity already held and is a guard, which is what says this change moved two states and
// not the mapping.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || null;
// 841ecf8 is the last commit whose drill-in header wrote its own dot mapping.
const BASELINE = process.env.DOTPARITY_BASELINE || "841ecf8";
const BASE = join(mkdtempSync(join(tmpdir(), "dotparity-")), "baseline.html");
writeFileSync(BASE, execFileSync("git", ["show", `${BASELINE}:webapp/index.html`], { cwd: REPO, maxBuffer: 32e6 }));

const GREEN = [76, 175, 80];
const AMBER = [224, 163, 62];

// One session per case. The SAME object feeds the card and the feed — that is the whole point: any
// disagreement is the client's, never two fixtures drifting apart.
const base = { sid: "s1", name: "cc-bridge", cwd: "~/projects/cc-bridge", alive: true, model: "Opus 5",
  effort: "high", branch: "main", ctxPct: 41, subagents: 0, task: "Reading the transcript back" };
const CASES = [
  { key: "working", label: "a working session", s: { ...base, working: true, state: "working" } },
  { key: "waiting", label: "a worker waiting on something outside itself",
    s: { ...base, working: false, state: "waiting", wait: { label: "gh run watch 18832" } } },
  // The reported case. `chat: true` and `waiting` — green at rest on the card since 2026-07-29, and
  // amber in the header until this fix.
  { key: "chatwait", label: "the owner's chat lane, merely waiting for him",
    s: { ...base, name: "Chat (@suchag)", chat: true, working: false, state: "waiting" } },
  { key: "chatwork", label: "the chat lane working", s: { ...base, name: "Chat (@suchag)", chat: true, working: true, state: "working" } },
  { key: "unreported", label: "a session that finished without reporting", s: { ...base, working: false, state: "unreported" } },
  { key: "idle", label: "an idle session", s: { ...base, working: false, state: "idle" } },
  { key: "errored", label: "a turn that died on an upstream API error",
    s: { ...base, working: false, state: "errored", errorStatus: 529 } },
];

let bad = 0;
const results = [];
const sink = (kind, ok, label) => { results.push({ kind, ok, label }); console.log(`${ok ? "OK  " : "FAIL"}  [${kind}] ${label}`); if (!ok) bad++; };
const near = (a, b, tol = 6) => a && b && Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;

const b = await chromium.launch();
if (OUT) mkdirSync(OUT, { recursive: true });

// Both surfaces are driven through the page's OWN functions: boot() never runs from file:// (it is
// gated on Telegram init data), so assembling either screen by hand would measure a render the app
// does not produce.
const open = async (path, s) => {
  const p = await b.newPage({ viewport: { width: 390, height: 812 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  await p.evaluate(fx => {
    const feed = { ...fx, items: [
      { role: "user", text: "status?", ts: 1785200000000 },
      { role: "assistant", text: "Waiting on you.", ts: 1785200001000 },
    ] };
    window.api = async u => u.includes("/api/session/feed") ? feed : u.includes("/api/sessions") ? { sessions: [fx] } : {};
    showTab("sessions");
  }, s);
  await p.waitForTimeout(500);
  return p;
};

// The ink at a dot's centre, read off a screenshot. Two device pixels — this is ink, not an edge.
// The pulse is FROZEN AT ITS 0% KEYFRAME first (chatrest.mjs's instrument, and for its reason): a
// working dot animates its opacity between 1 and .35, so an unfrozen read samples green composited
// over whatever ground the frame caught — which made the two surfaces' working dots differ by 20 units
// for no reason but shutter timing. Stillness itself is read from `animationName`, before this runs.
const ink = async (page, sel) => {
  const at = await page.evaluate(q => {
    const d = document.querySelector(q);
    if (!d) return null;
    d.getAnimations().forEach(a => { a.pause(); a.currentTime = 0 });
    const r = d.getBoundingClientRect();
    return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, sel);
  if (!at) return null;
  const shot = await page.screenshot({ clip: { x: at.x - 1, y: at.y - 1, width: 2, height: 2 } });
  return page.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, shot.toString("base64"));
};

const dotOf = async (page, sel) => {
  const meta = await page.evaluate(q => {
    const d = document.querySelector(q);
    if (!d) return null;
    return { cls: d.className.replace(/^dot\s*/, "").trim(), anim: getComputedStyle(d).animationName };
  }, sel);
  return meta && { ...meta, px: await ink(page, sel) };
};

async function measure(path, label, shotPrefix) {
  for (const c of CASES) {
    // A case is a GUARD unless this change moved it. Two did: the chat lane's waiting (the reported
    // disagreement) and `errored`, whose dot could not be COMPARED before because neither surface
    // painted one — an equality check over two absences is not parity, so it is classed as state and
    // must fail on the control like the rest of the fix.
    const kind = c.key === "chatwait" || c.key === "errored" ? "state" : "guard";
    const say = (ok, l) => sink(kind, ok, `${label}/${c.key}: ${l}`);
    const page = await open(path, c.s);

    const card = await dotOf(page, "#tab-sessions .sess .dot");
    const cardPx = card && card.px;
    await page.evaluate(fx => openDrill(fx.sid, fx.name), c.s);
    await page.waitForTimeout(600);
    const head = await dotOf(page, "#ddot");
    const headPx = head && head.px;

    if (!card || !head) { say(false, "one of the two surfaces rendered no dot at all"); await page.close(); continue }
    say(card.cls === head.cls && near(cardPx, headPx) && card.anim === head.anim,
      `${c.label}: card and drill-in header agree — class ${JSON.stringify(card.cls)} vs ${JSON.stringify(head.cls)}, ` +
      `ink ${JSON.stringify(cardPx)} vs ${JSON.stringify(headPx)}, anim ${card.anim} vs ${head.anim}`);

    // The anchors: two surfaces agreeing on the WRONG colour would pass equality alone.
    if (c.key === "chatwait") {
      sink("state", near(headPx, GREEN) && head.anim === "none",
        `${label}/${c.key}: and the agreed dot is GREEN and STILL, not amber (${JSON.stringify(headPx)} / ${head.anim})`);
    }
    // The errored dot has to be VISIBLE, which is not implied by parity: it was invisible on BOTH
    // surfaces (the `.err` toast class's `display: none` reached `.dot.err`), so the two agreed
    // perfectly on nothing at all. A state check — it fails on the control for that reason.
    if (c.key === "errored") {
      sink("state", !!cardPx && !!headPx && near(cardPx, [224, 85, 85]) && card.anim === "pulse",
        `${label}/${c.key}: the errored dot is actually PAINTED, red and pulsing, on both (card ${JSON.stringify(cardPx)}, header ${JSON.stringify(headPx)}, anim ${card.anim})`);
    }
    if (c.key === "waiting") {
      sink("guard", near(headPx, AMBER) && head.anim === "none",
        `${label}/${c.key}: and a worker's waiting is still AMBER on both (${JSON.stringify(headPx)} / ${head.anim})`);
    }
    if (OUT) {
      await page.evaluate(() => closeDrill());
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${shotPrefix}-${c.key}-card.png`), clip: { x: 0, y: 0, width: 390, height: 140 } });
      await page.evaluate(fx => openDrill(fx.sid, fx.name), c.s);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, `${shotPrefix}-${c.key}-drill.png`), clip: { x: 0, y: 0, width: 390, height: 140 } });
    }
    await page.close();
  }
}

await measure(PAGE, "page", "1");

console.log(`\n--- control: ${BASELINE} (the header's own mapping) ---`);
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
  ? "FAIL  the control did not behave: the chat-lane and errored checks must fail there, and every other state must already agree"
  : "OK    the control fails exactly the checks this change moved, and every other state agrees on both");
console.log(`\n${pageBad === 0 && !vacuous ? "PASS" : "FAIL"}  page failures: ${pageBad}`);
await b.close();
process.exit(pageBad === 0 && !vacuous ? 0 : 1);
