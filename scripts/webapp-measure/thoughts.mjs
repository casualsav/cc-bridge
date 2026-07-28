import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// A turn's NARRATION is quoted; its answer is not.
//
// What this is proving, and why each half needs a different instrument:
//
//   THE MARKING is structural — a bar and an indent on narration, neither on the reply — and every
//   check of it FAILS on a pre-change page (`node thoughts.mjs /path/to/old/index.html`), where
//   turnRow rendered both through one branch.
//
//   THE ABSENCE OF A DEMOTION is the opposite kind of claim and passes on BOTH pages by design.
//   Narration is prose by the owner's standing instruction: same size, weight, style, colour and
//   opacity as the reply. It is a guard against a future "improvement", not a control.
//
//   THE BAR IS MEASURED IN PIXELS, off a rendered screenshot, in both themes. This is the check that
//   the obvious version cannot make: the rule this revives declared `2px solid var(--sec)`, and since
//   the page was pinned to Telegram's header colour --sec sits 9/255 from --bg — a bar that any
//   declared-colour assertion passes and no eye can find. Reading getComputedStyle here would prove
//   the CSS parsed, not that anything is on the screen.
//
// The fixture is the real thing: a payload captured from the live daemon (a turn carrying narration,
// a chip and its concluding reply), plus a synthetic one for the shapes a single capture cannot hold
// — several paragraphs in a row, and narration on both sides of a chip.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const HERE = fileURLToPath(new URL(".", import.meta.url));

// Captured from /api/session/feed on the live daemon, 2026-07-28. Trimmed to the turn and its
// neighbours; the shape is verbatim.
const LIVE = JSON.parse(readFileSync(join(HERE, "fixtures", "turn-narration.json"), "utf8"));
// Two paragraphs, a chip, then one more — the merge rule and the split rule in one feed.
const SYNTH = {
  sid: "syn", name: "synthetic", working: false, cwd: "~/x", model: "Opus 5", effort: "high",
  items: [
    { role: "user", text: "have a look at the header", ts: 1785200000000 },
    { role: "turn", ts: 1785200001000, blocks: [
      { t: "p", text: "First I want to see what the header actually renders." },
      { t: "p", text: "The rect will not answer that, so I will hit-test it instead." },
      { t: "chip", kind: "run", label: "Ran 2 commands", calls: [{ verb: "Ran", target: "node header.mjs" }, { verb: "Ran", target: "node bleed.mjs" }] },
      { t: "p", text: "That confirms it: the chips are transparent and the feed passes behind them." },
    ] },
    { role: "assistant", text: "The header is fine — the transcript scrolls behind it as intended.", ts: 1785200002000 },
  ],
};
const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
  "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
const open = async (feed, vars) => {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  // A fixture that injects theme variables must re-run the chrome pin, or the page keeps a
  // dark-pinned --bg under light type and every colour read below is of a screen nobody sees.
  if (vars) await p.evaluate(v => { for (const [k, val] of Object.entries(v))
    document.documentElement.style.setProperty("--tg-theme-" + k, val); pinChromeColour(); }, vars);
  await p.evaluate(f => { window.api = async u => u.includes("feed") ? f : { sessions: [] };
    openDrill(f.sid, f.name); }, feed);
  await p.waitForTimeout(900);
  return p;
};

// ---- 1. The marking, on the REAL payload ------------------------------------------------------
const p = await open(LIVE, null);
const live = await p.evaluate(() => {
  const turn = document.querySelector(".msg.turn");
  const q = turn && turn.querySelector(".tq");
  // Read through the TURN, not through the quote: on the pre-change page there is no quote, and the
  // prose guard has to be able to find narration there too or it "fails" for the wrong reason — it is
  // supposed to pass on both pages.
  const tp = turn && turn.querySelector(".tp");
  const reply = document.querySelector(".msg.assistant");
  const box = e => { if (!e) return null; const c = getComputedStyle(e);
    return { bar: parseFloat(c.borderLeftWidth), padLeft: parseFloat(c.paddingLeft),
      size: c.fontSize, weight: c.fontWeight, style: c.fontStyle, colour: c.color, opacity: c.opacity }; };
  return { turn: !!turn, quotes: turn ? turn.querySelectorAll(".tq").length : 0,
    text: tp && tp.textContent.trim().slice(0, 60),
    quote: box(q), reply: box(reply),
    // the paragraph itself must stay unstyled — the bar belongs to the group
    para: box(tp),
  };
});
check(live.turn, "the live payload renders a turn row");
check(live.quotes === 1, `its narration is quoted (${live.quotes} quote(s))`);
check(live.quote?.bar === 2, `the quote carries a 2px bar (${live.quote?.bar})`);
check(live.quote?.padLeft === 10, `and a 10px indent off it (${live.quote?.padLeft})`);
check(live.reply?.bar === 0 && live.reply?.padLeft === 0,
  `the REPLY carries neither (bar ${live.reply?.bar}, pad ${live.reply?.padLeft})`);
// The guard, not a control: this passes on the pre-change page too, and that is the claim.
const demoted = ["size", "weight", "style", "colour", "opacity"].filter(k => live.para?.[k] !== live.reply?.[k]);
check(demoted.length === 0,
  `narration is still PROSE — same size/weight/style/colour/opacity as the reply${demoted.length ? " · differs on " + demoted.join(", ") + " " + JSON.stringify({ narration: live.para, reply: live.reply }) : ""}`);

// ---- 2. Merge and split, on the synthetic feed -------------------------------------------------
const p2 = await open(SYNTH, null);
const syn = await p2.evaluate(() => {
  const turn = document.querySelector(".msg.turn");
  if (!turn) return { kids: [], quotes: 0, paras: 0 };
  const kids = [...turn.children].map(e => e.classList.contains("tq") ? "quote:" + e.querySelectorAll(".tp").length
    : e.classList.contains("chip") ? "chip" : e.className);
  return { kids, quotes: turn.querySelectorAll(".tq").length, paras: turn.querySelectorAll(".tp").length };
});
check(syn.paras === 3, `all three narration paragraphs render (${syn.paras})`);
check(syn.quotes === 2, `in TWO quotes, not three — adjacent ones merge (${syn.quotes})`);
check(JSON.stringify(syn.kids) === JSON.stringify(["quote:2", "chip", "quote:1"]),
  `and the chip is what splits them (${syn.kids.join(" · ")})`);

// ---- 3. The bar, in PIXELS, both themes --------------------------------------------------------
// A screenshot of the quote's own left edge against the same strip one paragraph-width to the right,
// which is page ground. If the bar is not painted the two are the same colour — which is exactly what
// `2px solid var(--sec)` produces on the pinned page, while passing any check of the declared value.
for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  const pg = theme === "dark" ? p2 : await open(SYNTH, vars);
  const r = await pg.evaluate(() => {
    const e = document.querySelector(".msg.turn .tq"); if (!e) return null;
    const q = e.getBoundingClientRect();
    return { x: q.left, y: q.top + q.height / 2 };
  });
  if (!r) { check(false, `${theme}: no quote to measure a bar on`); check(false, `${theme}: —`); continue; }
  const shot = await pg.screenshot({ clip: { x: r.x - 2, y: r.y - 4, width: 24, height: 8 } });
  const px = await pg.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data;
    await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const at = x => { const d = ctx.getImageData(x, Math.floor(img.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; };
    // deviceScaleFactor 2: the clip started 2 CSS px left of the bar, so the bar is device px 4-7.
    return { bar: at(5), ground: at(img.width - 3) };
  }, shot.toString("base64"));
  const delta = Math.max(...px.bar.map((v, i) => Math.abs(v - px.ground[i])));
  check(delta >= 30, `${theme}: the bar is PAINTED and visible against the page — ${delta}/255 (bar ${px.bar}, ground ${px.ground})`);
  check(delta <= 120, `${theme}: and still a hairline rather than a rule — ${delta}/255`);
  if (theme === "light") await pg.close();
}

// ---- 4. Shots, if asked ------------------------------------------------------------------------
if (process.argv[3]) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(process.argv[3], { recursive: true });
  for (const [name, feed, vars] of [["live-dark", LIVE, null], ["synthetic-dark", SYNTH, null], ["synthetic-light", SYNTH, LIGHT]]) {
    const s = await open(feed, vars);
    await s.evaluate(() => { const t = document.querySelector(".msg.turn"); if (t) t.scrollIntoView({ block: "center" }); });
    await s.waitForTimeout(400);
    await s.screenshot({ path: join(process.argv[3], `thoughts-${name}.png`) });
    await s.close();
  }
  console.log(`\nshots → ${process.argv[3]}`);
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
