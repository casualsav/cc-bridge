import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// One message may not change the FONT of the messages after it.
//
//   node mdnest.mjs [page]
//
// Pre-change control: `node mdnest.mjs /path/to/old/index.html` — §2 and §3 must FAIL there.
// (`git show HEAD:webapp/index.html > /tmp/old.html` is how that copy is made.)
//
// WHY A BROWSER AND NOT THE UNIT: webapp-md-nesting.test.ts asserts the STRING md() emits, which is
// where the fault is. This asserts what the PARSER then does with it, which is where the damage is,
// and the two are not the same claim — `<code>` is an HTML formatting element, so a span that opens
// in a `<th>` and closes in a later `<td>` is not merely ugly markup: the adoption agency keeps it on
// the list of active formatting elements and RECONSTRUCTS it inside every following bubble. No string
// assertion can show that, and it is the thing the owner saw (2026-08-15): his feed flipped to
// monospace at a subagent's table card and every message after it, his own included, rendered as one
// grey code chip through every 3s repaint.
//
// The fixture is that exact card off the live feed — an agent report the 4000-char payload clamp cut
// inside a fenced block, so its closing ``` is gone.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const CARD = readFileSync(join(REPO, "fixtures", "clipped-table-card.txt"), "utf8");
const ts = 1785200000000;
const SESSION = { sid: "abc", name: "weather", alive: true, working: false, cwd: "~/projects/weather", model: "Opus 5", effort: "high" };
// The card, then one of every row kind that followed it in his feed — the claim is about the rows
// AFTER the bad one, so a fixture that ends at the card would prove nothing.
const items = [
  { role: "user", text: "map the hourly lane for me", ts },
  { role: "agent", agent: "explorer", status: "completed", text: CARD, clipped: true, ts },
  { role: "assistant", text: "Stopped. **Nothing to stash or discard.**\n\nState: all three trees clean. `weather` main `415e360` (0 dirty).", ts },
  { role: "user", text: "good — hold there", ts },
  { role: "turn", ts, blocks: [
    { t: "p", text: "Now the handler and route:" },
    { t: "chip", kind: "run", label: "Ran a command", calls: [{ verb: "Ran", target: "bun test" }] },
    { t: "p", text: "Now the tests:" },
  ] },
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
  const mono = e => getComputedStyle(e).fontFamily.startsWith("ui-monospace");
  return {
    rows: q("#dfeed > .msg").length,
    // A code span is a few words. Anything holding a paragraph is holding it by accident.
    runaway: q("#dfeed code").map(c => c.textContent.length).filter(n => n > 300),
    // The reader's own words, in the rows after the bad card.
    reply: q("#dfeed .msg.assistant").map(mono),
    user: q("#dfeed .msg.user").map(mono),
    narration: q("#dfeed .msg.turn .tp").map(mono),
    chips: q("#dfeed .msg.turn .chip .cl").map(mono),
    // …and the guard half: real code spans must STILL be mono, or the fix cured the disease by
    // deleting the feature. Passes on both pages on purpose.
    realCode: q("#dfeed .msg.assistant code").map(c => [c.textContent, mono(c)]),
    body: getComputedStyle(document.body).fontFamily.slice(0, 20),
  };
});

// ---- 1. The fixture reached the page -----------------------------------------------------------
check(m.rows === 5, `the feed painted ${m.rows} rows (5)`);
check(m.realCode.length >= 2, `the reply after the card carries ${m.realCode.length} real code spans (>=2)`);

// ---- 2. No span swallows a paragraph -----------------------------------------------------------
check(m.runaway.length === 0, `no code span holds more than 300 characters (found ${JSON.stringify(m.runaway)})`);

// ---- 3. Prose after the bad card is still prose -------------------------------------------------
const proseFont = l => l.length > 0 && l.every(x => x === false);
check(proseFont(m.reply), `the reply after the card renders in the app font (${JSON.stringify(m.reply)})`);
check(proseFont(m.user), `his own message renders in the app font (${JSON.stringify(m.user)})`);
check(proseFont(m.narration), `turn narration renders in the app font (${JSON.stringify(m.narration)})`);
check(proseFont(m.chips), `activity chips render in the app font (${JSON.stringify(m.chips)})`);

// ---- 4. The guard: inline code is still inline code ---------------------------------------------
check(m.realCode.every(([, isMono]) => isMono), `every real code span is still monospace (${JSON.stringify(m.realCode)})`);

console.log(`\npage: ${PAGE}\nbody font: ${m.body}\n${bad ? `${bad} FAILED` : "all checks passed"}`);
await b.close();
process.exit(bad ? 1 : 0);
