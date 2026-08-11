import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// Two changes of 2026-08-11, measured together because they land on the same rows:
//
//   §1  NO TAP FLASH anywhere. The bulky square is the WebView's own -webkit-tap-highlight-color,
//       painted over the whole element box of anything tappable; the page now declares it away.
//   §2+ A CONCLUDED TURN folds its per-kind chips into ONE "Worked for …" line, and that line opens
//       the calls sheet on EVERY call of the turn, in order.
//
//   node turnworked.mjs [page]
//
// Pre-change control: `node turnworked.mjs /path/to/old/index.html` — §1, §2 and §4 must FAIL there
// (the old page ignores `workedSec` and keeps the chips). §3 (a LIVE turn still shows its chips and
// no summary) and §5 (a live chip still opens its own subset) pass on BOTH pages on purpose: they
// are the guard that this change did not disturb the running-turn rendering, not controls.
//
// WHAT A BROKEN PAGE WOULD GIVE §1: Chromium's initial value for the property is a visible black at
// 18% — so the check reads a real difference, not the absence of a declaration. The elements are
// sampled from three screens (list, drill-in, an open sheet) because the rule is universal and a
// single-screen check would pass on a rule scoped to one component.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const ts = 1785200000000;
// One turn with three chip kinds and narration on both sides of them: the grouping of the quote runs
// is itself under test, since folding the chips away must not re-merge the paragraphs around them.
const BLOCKS = [
  { t: "p", text: "First I want to see what the feed endpoint actually returns for a concluded turn." },
  { t: "chip", kind: "read", label: "Read 2 files", calls: [
    { verb: "Read", target: "daemon.ts" }, { verb: "Read", target: "transcript.ts" } ] },
  { t: "p", text: "That confirms the span is on the payload." },
  { t: "p", text: "Now the client half." },
  { t: "chip", kind: "run", label: "Ran 3 commands", calls: [
    { verb: "Ran", target: "bun test" }, { verb: "Ran", target: "git status" }, { verb: "Ran", target: "bun run deploy" } ] },
  { t: "chip", kind: "edit", label: "Edited a file", plus: 12, minus: 3, calls: [
    { verb: "Edited", target: "index.html", plus: 12, minus: 3 } ] },
  { t: "p", text: "Done — the summary row replaces the chips once the turn ends." },
];
const CALLS = BLOCKS.filter(b => b.t === "chip").flatMap(b => b.calls);
const feed = done => ({
  sid: "abc", name: "cc-bridge", working: !done, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
  items: [
    { role: "user", text: "fold the chips when the turn ends", ts },
    { role: "turn", ts, blocks: BLOCKS, ...(done ? { workedSec: 150 } : {}) },
    ...(done ? [{ role: "assistant", text: "Done.", ts }] : []),
  ],
});

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
const open = async f => {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(x => { window.api = async u => u.includes("feed") ? x : { sessions: [] }; openDrill(x.sid, x.name); }, f);
  await p.waitForTimeout(900);
  return p;
};

const p = await open(feed(true));

// ---- 1. No tap flash, on every screen -----------------------------------------------------------
// Read off elements that are actually tappable, and INCLUDE the sheets: a rule that only reached the
// feed would still leave the flash on the surface a tap opens.
const flash = await p.evaluate(async () => {
  openCalls(1, 1);   // the sheet, opened the way BOTH pages can — §1 is about the flash, not the fold
  await new Promise(r => setTimeout(r, 300));
  const sel = [".msg.turn .chip", "#calllist .row", "#callx", "#dsend", "#dmic", ".msg", "#dfeed", "body"];
  const out = {};
  for (const s of sel) {
    const e = document.querySelector(s);
    out[s] = e ? getComputedStyle(e).webkitTapHighlightColor : "MISSING";
  }
  closeCalls();
  await new Promise(r => setTimeout(r, 300));
  return out;
});
const TRANSPARENT = /^rgba\(0, 0, 0, 0\)$/;
for (const [s, v] of Object.entries(flash)) check(v !== "MISSING" && TRANSPARENT.test(v), `§1 no tap flash on ${s} (${v})`);

// ---- 2. A concluded turn: chips folded into one summary line ------------------------------------
const doneRow = await p.evaluate(() => {
  const t = document.querySelector(".msg.turn");
  const chips = [...t.querySelectorAll(".chip")];
  const w = t.querySelector("[data-worked]");
  return {
    chips: chips.length,
    worked: w ? w.querySelector(".cl").textContent : null,
    arrow: w ? w.querySelector(".cv").textContent : null,
    last: chips.length ? chips[chips.length - 1].hasAttribute("data-worked") : false,
    quotes: [...t.querySelectorAll(".tq")].map(q => q.querySelectorAll(".tp").length),
  };
});
check(doneRow.chips === 1, `§2 one chip left on a concluded turn (${doneRow.chips})`);
check(doneRow.worked === "Worked for 2m 30s", `§2 label is the turn's own clock ("${doneRow.worked}")`);
check(doneRow.arrow === "›", `§2 the chevron the live chips carry ("${doneRow.arrow}")`);
check(doneRow.last === true, "§2 the summary is the turn's last line");

// ---- 3. A LIVE turn is untouched (guard, passes on both pages) -----------------------------------
const live = await open(feed(false));
const liveRow = await live.evaluate(() => {
  const t = document.querySelector(".msg.turn");
  return {
    chips: [...t.querySelectorAll(".chip")].map(c => c.querySelector(".cl").textContent),
    worked: t.querySelectorAll("[data-worked]").length,
    quotes: [...t.querySelectorAll(".tq")].map(q => q.querySelectorAll(".tp").length),
  };
});
check(liveRow.chips.join("|") === "Read 2 files|Ran 3 commands|Edited a file", `§3 live chips intact (${liveRow.chips.join("|")})`);
check(liveRow.worked === 0, "§3 no summary while the turn runs");
// The paragraphs group the same either side of the end — the chips still flush their quote run when
// they render nothing, so no reflow lands on the reader at turn end.
check(JSON.stringify(doneRow.quotes) === JSON.stringify(liveRow.quotes),
  `§3 quote grouping unchanged by the fold (done ${JSON.stringify(doneRow.quotes)} vs live ${JSON.stringify(liveRow.quotes)})`);

// ---- 4. The summary opens the WHOLE turn, in order ----------------------------------------------
const sheet = await p.evaluate(async () => {
  // Missing on a pre-change page — reported as a failure rather than thrown, so a control runs to
  // the end and shows WHICH checks the change is responsible for.
  const w = document.querySelector("[data-worked]");
  if (!w) return { open: false, title: "NO SUMMARY ROW", rows: [] };
  w.click();
  await new Promise(r => setTimeout(r, 300));
  const rows = [...document.querySelectorAll("#calllist .row")].map(r => ({
    verb: r.children[0].textContent, target: r.querySelector(".tgt").textContent,
    plus: r.querySelector(".cp") ? r.querySelector(".cp").textContent : "",
  }));
  return { open: document.getElementById("calls").classList.contains("up"), title: document.getElementById("calltitle").textContent, rows };
});
check(sheet.open, "§4 the summary opens the calls sheet");
check(sheet.title === "Worked for 2m 30s", `§4 the sheet is titled by the turn ("${sheet.title}")`);
check(sheet.rows.length === CALLS.length, `§4 every call in the turn is a row (${sheet.rows.length}/${CALLS.length})`);
check(sheet.rows.map(r => r.target).join(",") === CALLS.map(c => c.target).join(","),
  `§4 rows in the order they ran (${sheet.rows.map(r => r.target).join(",")})`);
check(sheet.rows.some(r => r.plus === "+12"), "§4 an edit keeps its line stat in the flattened list");

// ---- 5. A live chip still opens its OWN subset (guard, passes on both pages) ---------------------
const one = await live.evaluate(async () => {
  document.querySelectorAll(".msg.turn .chip")[1].click();
  await new Promise(r => setTimeout(r, 300));
  return { title: document.getElementById("calltitle").textContent,
    rows: [...document.querySelectorAll("#calllist .row")].map(r => r.querySelector(".tgt").textContent) };
});
check(one.title === "Ran 3 commands", `§5 a chip is still titled by itself ("${one.title}")`);
check(one.rows.join(",") === "bun test,git status,bun run deploy", `§5 a chip still shows only its own calls (${one.rows.join(",")})`);

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
