import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// An optimistic bubble must recognise its own CLIPPED echo.
//
// The feed's payload clamp (`transcript.ts`, CONVO_CAP) cuts every row past its cap and flags it
// `clipped: true`. The client reconciled a sent message against its echo by exact text, which over
// that length can never match — so the bubble outlived its echo for the full 120s valve and the feed
// showed the message TWICE. The lost top-pin on the next reply is the smaller half; the feed lying
// about what you sent is the reason this is a defect.
//
//   node ghostecho.mjs [page] [outdir]
//
// Pre-change control: node ghostecho.mjs /path/to/old.html — the two §1 checks must FAIL there
// (that is the reproduction). Everything in §2 and §3 passes on BOTH pages, on purpose: they are the
// guards and the no-regression half, and a guard that only starts holding after the change would
// mean the change had introduced the thing it guards against.
//
// The DOWNSTREAM claim — the next reply's top-pin coming back — is deliberately NOT re-implemented
// here: pinopt.mjs already measures it, against the pin's own untouched code. Run that too.
//
// INSTRUMENT NOTE, inherited from pinopt.mjs and worth repeating: snapshots go in through
// `lastDrill = …; feedSig = ""; paintFeed()`, never through openDrill() — openDrill RESETS
// `optimistic`, so a harness that re-opens the drill to change the snapshot deletes its own fixture.
// (`window.drillSid` is undefined at all times — top-level `let` never lands on window — so the
// `window.drillSid ? renderDrill() : openDrill()` idiom in newest.mjs re-opens on EVERY call.)

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "ghostecho-"));

const CAP = 4000;   // the server's clamp. Named HERE, in the fixture, because the harness has to
                    // build a clamped echo by hand; the page under test must contain no such number.
const ts = 1785200000000;
const clamp = s => s.length > CAP ? s.slice(0, CAP) + "…" : s;
// Two long messages that are different from the first character, so a prefix test cannot confuse
// them, and one pair that shares a prefix but diverges before the cap.
const BIG_A = "A very long brief pasted into the composer. ".repeat(120);          // 5160
const BIG_B = "Zebra notes, an entirely different long message of similar size. ".repeat(90);
const SHORT = "hello";
const LONGER = "hello world, this is the message that was actually sent";

const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: false, cwd: "~/p", model: "Opus 5", effort: "high" };
const feedOf = items => ({ sid: "abc", name: "cc-bridge", working: false, cwd: "~/p", model: "Opus 5", effort: "high", items });
const userItem = text => text.length > CAP
  ? { role: "user", text: clamp(text), ts, uuid: "u-" + text.length, clipped: true }
  : { role: "user", text, ts };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => console.log("PAGEERROR:", e.message));
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(s => {
  window.__feed = null;
  window.api = async path => path.includes("session/feed") ? window.__feed
    : path.includes("sessions") ? { sessions: [s] } : {};
}, SESSION);

// A fresh drill-in per case: openDrill clears `optimistic`, which is exactly what a new case wants.
const open = async items => {
  await p.evaluate(f => { window.__feed = f; }, feedOf(items));
  await p.evaluate(() => openDrill("abc", "cc-bridge"));
  await p.waitForTimeout(700);
};
const send = text => p.evaluate(t => {
  optimistic.push({ text: t, at: Date.now(), state: "sent" }); feedSig = ""; paintFeed();
}, text);
const snap = async items => {
  await p.evaluate(f => { lastDrill = f; feedSig = ""; paintFeed(); }, feedOf(items));
  await p.waitForTimeout(300);
};
const state = needle => p.evaluate(n => ({
  opt: optimistic.length,
  // How many rows on screen carry the sent text. TWO is the defect: the transcript's clamped copy
  // and the optimistic bubble that could not recognise it.
  rows: [...document.querySelectorAll("#dfeed .msg")].filter(m => m.textContent.includes(n)).length,
}), needle);

// ---- 1. THE DEFECT: a >CAP message and its clamped echo -----------------------------------------
// The needle is a slice from deep inside the message but before the cap, so it is present in BOTH
// the full text and the clamped copy — a needle past the cut would count only the ghost and report
// the bug as fixed on the broken page.
const NEEDLE = BIG_A.slice(1000, 1060);
await open([{ role: "user", text: "earlier", ts }]);
await send(BIG_A);
let s = await state(NEEDLE);
check(s.opt === 1 && s.rows === 1, `FIXTURE: the bubble is up and alone before its echo  (opt ${s.opt}, rows ${s.rows})`);
await snap([{ role: "user", text: "earlier", ts }, userItem(BIG_A)]);
s = await state(NEEDLE);
await p.screenshot({ path: join(OUT, "clipped-echo.png") });
check(s.opt === 0, `a clipped echo retires its own bubble  (${s.opt} optimistic left)`);
check(s.rows === 1, `…so the message is on screen ONCE, not twice  (${s.rows} rows carry it)`);

// ---- 2. THE GUARDS: three retirements that must NOT happen --------------------------------------
// (a) an UNCLIPPED item that is merely a prefix of what is pending. The `clipped` guard is the only
//     thing standing between this and a bubble retired by someone else's shorter message.
await open([{ role: "user", text: "earlier", ts }]);
await send(LONGER);
await snap([{ role: "user", text: "earlier", ts }, userItem(SHORT)]);
s = await state(LONGER);
check(s.opt === 1, `an unclipped prefix does NOT retire a longer pending bubble  (${s.opt} optimistic)`);

// (b) a clipped echo of a DIFFERENT long message, while another long bubble is pending.
await open([{ role: "user", text: "earlier", ts }]);
await send(BIG_A);
await snap([{ role: "user", text: "earlier", ts }, userItem(BIG_B)]);
s = await state(BIG_A.slice(1000, 1060));
check(s.opt === 1, `a clipped echo of a DIFFERENT message leaves the bubble alone  (${s.opt} optimistic)`);

// (c) a bubble SHORTER than what survived the clamp cannot be the message that was cut.
await open([{ role: "user", text: "earlier", ts }]);
await send(BIG_A.slice(0, 500));
await snap([{ role: "user", text: "earlier", ts }, userItem(BIG_A)]);
s = await state(BIG_A.slice(100, 160));
check(s.opt === 1, `a bubble shorter than the surviving prefix is not retired by it  (${s.opt} optimistic)`);

// ---- 3. UNDER THE CAP: byte-for-byte the old behaviour ------------------------------------------
await open([{ role: "user", text: "earlier", ts }]);
await send("a short message that fits");
await snap([{ role: "user", text: "earlier", ts }, userItem("a short message that fits")]);
s = await state("a short message that fits");
check(s.opt === 0 && s.rows === 1, `an exact echo still retires exactly as before  (opt ${s.opt}, rows ${s.rows})`);

await open([{ role: "user", text: "earlier", ts }]);
await send("never echoed at all");
await snap([{ role: "user", text: "earlier", ts }, userItem("something else entirely")]);
s = await state("never echoed at all");
check(s.opt === 1 && s.rows === 1, `an unmatched short bubble still lives out its 120s valve  (opt ${s.opt})`);

await b.close();
console.log(`shots → ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
