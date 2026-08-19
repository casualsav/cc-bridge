import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// A message another agent wrote renders as the document it is; the owner's own words do not.
//
//   node busbubble.mjs [page]
//
// Pre-change control: `node busbubble.mjs /tmp/old.html` — §2 must FAIL there, §1 and §3 must pass
// (`git show HEAD:webapp/index.html > /tmp/old.html` makes that copy).
//
// WHY A BROWSER AND NOT ONLY THE UNIT: webapp-bus-bubble.test.ts asserts the STRING bodyHtml emits.
// This asserts what the page then paints — that the bus row's markup became real elements in the
// bubble, and, the half that matters more, that the row above it did NOT. The owner's report
// (2026-08-19) was a bus ack showing `**bold**` and its wire envelope as prose; the risk in fixing it
// is restyling HIS messages, which is a thing you can only see rendered.
//
// The envelope half of that report is transcript.ts's and is pinned in transcript.test.ts — by the
// time the feed has an item, the `<tg …>` blocks are already gone and `bus: true` is set.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const ts = 1787119250000;
const SESSION = { sid: "abc", name: "killnotice", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const BODY = "Owner-side live verification closed on **ask 782**.\n\n## What changed\n- the `unwrapTg` envelope\n- the renderer";
const items = [
  // His own message, carrying the SAME markdown — the control, and deliberately first so a fix that
  // restyles every user bubble cannot hide behind the bus row painting correctly.
  { role: "user", text: BODY, ts },
  { role: "user", bus: true, text: BODY, ts },
  { role: "assistant", text: "Understood — **shipping** it.", ts },
];
const feed = { ...SESSION, items };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(f => { window.api = async u => u.includes("feed") ? f : { sessions: [] }; openDrill(f.sid, f.name); }, feed);
await p.waitForTimeout(900);

const m = await p.evaluate(() => {
  const q = s => [...document.querySelectorAll(s)];
  const read = e => ({ text: e.textContent, bold: e.querySelectorAll("b").length, code: e.querySelectorAll("code").length });
  return { rows: q("#dfeed > .msg").length, user: q("#dfeed .msg.user").map(read), reply: q("#dfeed .msg.assistant").map(read) };
});

// ---- 1. The fixture reached the page -----------------------------------------------------------
check(m.rows === 3, `the feed painted ${m.rows} rows (3)`);
check(m.user.length === 2, `both user rows are present (${m.user.length})`);

// ---- 2. The bus row is a rendered document ------------------------------------------------------
const bus = m.user[1] || {};
check(bus.bold >= 2, `the bus row painted ${bus.bold} <b> elements — the bold and the heading (>=2)`);
check(bus.code === 1, `and ${bus.code} code span (1)`);
check(!/\*\*/.test(bus.text || ""), `no literal asterisks survive in it (${JSON.stringify((bus.text || "").slice(0, 60))})`);
check(!/##/.test(bus.text || ""), `and no literal hashes`);

// ---- 3. THE CONTROL: his own bubble is untouched -------------------------------------------------
const his = m.user[0] || {};
check(his.bold === 0, `his own message painted ${his.bold} <b> elements (0)`);
check(/\*\*ask 782\*\*/.test(his.text || ""), `his asterisks are still his`);
check(/## What changed/.test(his.text || ""), `his hashes are still his`);
// …and the reply's own renderer did not move either: inline yes, block no (cc25c02's ruling).
check((m.reply[0] || {}).bold === 1, `the reply still renders inline bold (${(m.reply[0] || {}).bold})`);

console.log(`\npage: ${PAGE}\n${bad ? `${bad} FAILED` : "all checks passed"}`);
await b.close();
process.exit(bad ? 1 : 0);
