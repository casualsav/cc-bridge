import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The six constructs md() was widened to, painted by a real parser — and the two it was NOT.
//
//   node mdwiden.mjs [page] [--shot <path>]
//
// Pre-change control: `node mdwiden.mjs /tmp/old.html` — §1 and §2 must FAIL there, §3 must pass
// (`git show main:webapp/index.html > /tmp/old.html` makes that copy).
//
// WHY A BROWSER AND NOT ONLY THE UNIT: render-parity.test.ts asserts the STRING md()/mdReport()
// emit, which is where the gap was. This asserts what the page does with it — that a link became a
// real <a>, a quote a real bar, a rule a real line — and, the half that matters more, that headings
// and bullets in an ASSISTANT reply still do not, because widening those is the owner's call
// (cc25c02) and was explicitly out of scope for this change.

const REPO = join(fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""));
const raw = process.argv.slice(2);
const shotIx = raw.indexOf("--shot");
const SHOT = shotIx > -1 ? raw[shotIx + 1] : null;
// shotIx === -1 must drop NOTHING: `i !== -1` is true for every index, but `i !== 0`
// silently ate the page argument and ran the control against this checkout.
const positional = shotIx > -1 ? raw.filter((a, i) => i !== shotIx && i !== shotIx + 1) : raw;
const PAGE = positional[0] || join(REPO, "webapp", "index.html");
const ts = 1787000000000;
const SESSION = { sid: "abc", name: "weather", alive: true, working: false, cwd: "~/projects/weather", model: "Opus 5", effort: "high" };

// One bus row carrying all six, and one assistant reply carrying the two that stay out of scope.
const REPORT = [
  "Shipped **v0.5.189** — the ~~frozen~~ live card now survives a restart.",
  "",
  "> The card's whole life was a 5s interval and a 30s timeout in daemon memory.",
  "> A restart inside that window left it frozen in the chat forever.",
  "",
  "---",
  "",
  "Details in [the fix plan](https://example.dev/fix-plan), with _one_ __caveat__: `flushPendingDeletes` is bounded.",
].join("\n");
const REPLY = "## Heading stays literal\n- and so does this bullet\nbut **bold** does not.";

const items = [
  { role: "user", text: "how did it go?", ts },
  { role: "user", bus: true, text: REPORT, ts },
  { role: "assistant", text: REPLY, ts },
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
  const read = e => ({
    text: e.textContent,
    a: e.querySelectorAll("a[href]").length,
    href: e.querySelector("a[href]")?.getAttribute("href") || null,
    target: e.querySelector("a[href]")?.getAttribute("target") || null,
    s: e.querySelectorAll("s").length,
    b: e.querySelectorAll("b").length,
    i: e.querySelectorAll("i").length,
    mq: e.querySelectorAll(".mq").length,
    mqBorder: (() => { const n = e.querySelector(".mq"); return n ? getComputedStyle(n).borderLeftWidth : null; })(),
    mqMargin: (() => { const n = e.querySelector(".mq"); return n ? getComputedStyle(n).marginTop : null; })(),
    mh: e.querySelectorAll(".mh").length,
  });
  return { rows: q("#dfeed > .msg").length, user: q("#dfeed .msg.user").map(read), reply: q("#dfeed .msg.assistant").map(read) };
});

const bus = m.user[1] || {};
const his = m.user[0] || {};
const reply = m.reply[0] || {};

// ---- 1. The six, as real elements ---------------------------------------------------------------
check(m.rows === 3, `the feed painted ${m.rows} rows (3)`);
check(bus.a === 1, `the bus row painted ${bus.a} <a> (1)`);
check(bus.href === "https://example.dev/fix-plan", `its href is the URL, unmangled (${bus.href})`);
check(bus.target === "_blank", `and it opens outside the mini app (target=${bus.target})`);
check(bus.s === 1, `${bus.s} <s> for ~~strike~~ (1)`);
check(bus.i >= 1, `${bus.i} <i> — the _underscore_ italic (>=1)`);
check(bus.b >= 2, `${bus.b} <b> — **bold** and __dunder__ (>=2)`);
check(bus.mq === 1, `${bus.mq} quote span, and the two > lines merged into it (1)`);
check(/──────────/.test(bus.text || ""), `the rule line painted as a glyph run, the same one Telegram emits`);
check(!/\*\*|~~|\]\(http/.test(bus.text || ""), `no literal markers survive (${JSON.stringify((bus.text || "").slice(0, 48))})`);

// ---- 2. The quote is a LINE, not a block box -----------------------------------------------------
// The container is white-space: pre-wrap, so a block box's margin would double-space against the
// newline that is already there — the rule `.mh` states and the reason this is a <span>.
check(parseFloat(bus.mqBorder) >= 1, `the quote wears a left bar (${bus.mqBorder})`);
check(parseFloat(bus.mqMargin) === 0, `and no block margin to double-space against pre-wrap (${bus.mqMargin})`);

// ---- 3. THE CONTROL: what was NOT in scope did not move -------------------------------------------
check(reply.mh === 0, `the assistant reply painted ${reply.mh} headings (0 — the owner's call, out of scope)`);
check(/## Heading stays literal/.test(reply.text || ""), `its hashes are still literal`);
check(/- and so does this bullet/.test(reply.text || ""), `its bullet is still literal`);
check(reply.b === 1, `while its inline bold still renders (${reply.b})`);
check(his.a === 0 && his.b === 0, `and his own message is still exactly what he typed`);

if (SHOT) { await p.screenshot({ path: SHOT, fullPage: false }); console.log(`\nshot: ${SHOT}`); }
console.log(`\npage: ${PAGE}\n${bad ? `${bad} FAILED` : "all checks passed"}`);
await b.close();
process.exit(bad ? 1 : 0);
