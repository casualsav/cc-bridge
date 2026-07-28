import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// A turn's NARRATION IS NOT MARKED AT ALL — no bar, no indent — and these checks defend that absence,
// which is the owner's ruling (v0.4.187) and not a regression.
//
// He was shown three renders side by side: the bar, the bar removed with the indent kept, and both
// removed. He picked both removed. So this file inverted twice in one session, and the second
// inversion is the one that needs saying out loud: an unmarked narration measures byte-identical to
// the reply, which is the exact measurement v0.4.173 treated as a BUG. Same number, different
// situation — that release was fixing narration nobody had ever marked; this is narration whose
// marking he has now seen and declined.
//
// What this is proving, and why each half needs a different instrument:
//
//   THE STRUCTURE still is what it always was — narration grouped into quotes, adjacent paragraphs
//   merged, a chip splitting the run — and those checks FAIL on a pre-turn-card page
//   (`node thoughts.mjs /path/to/old/index.html`), where turnRow rendered narration and reply
//   through one branch and there were no groups at all.
//
//   THE BAR'S ABSENCE is checked IN PIXELS, off a rendered screenshot, in both themes, and the
//   sampling is kept from the version that asserted the bar's presence rather than replaced by a
//   getComputedStyle read. The reason is unchanged and cuts both ways: a declared-colour assertion
//   cannot see what is painted. It passed a `2px solid var(--sec)` that sat 9/255 from --bg and no
//   eye could find; it would equally pass a bar someone reintroduced at any value. The render is the
//   only witness, so a reinstated bar fails HERE, on the screen, not on the stylesheet.
//
//   THE ABSENCE OF A DEMOTION is the opposite kind of claim and passes on BOTH pages by design.
//   Narration is prose by the owner's standing instruction: same size, weight, style, colour and
//   opacity as the reply. It is a guard against a future "improvement", not a control — and it is
//   UNCHANGED through both inversions, because nothing here ever demoted anything. Every state in
//   this story — v0.4.107's, the revival's, the two offered, the one chosen — was full prose; what
//   moved was only whether something was drawn beside it.
//
//   THE PRICE IS KEPT AS A NUMBER (§5), not because it argues against the choice but because it
//   records it: the count of box properties on which narration differs from the reply is zero, and
//   if it ever moves someone has re-marked narration deliberately rather than repaired it.
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
check(live.quote?.bar === 0, `the quote carries NO bar — the owner's ruling (${live.quote?.bar}px)`);
check(live.quote?.padLeft === 0, `and no indent either — he picked that off the render (${live.quote?.padLeft}px)`);
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

// ---- 3. NO bar, in PIXELS, both themes ---------------------------------------------------------
// With the indent gone there is no blank strip INSIDE the box to sample against — text now starts at
// the box's own left edge, and a probe a few pixels in lands on glyphs. So the sample is taken along
// the TOP of the box instead: a border paints the element's full height including the half-leading
// above the first line's ink, where no glyph can reach. One pixel at the box's left edge against one
// in the feed's gutter 6px to its left, both of which must be page ground.
// Any reinstated border — at ANY colour, including one too faint for an eye — separates them.
for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  const pg = theme === "dark" ? p2 : await open(SYNTH, vars);
  const r = await pg.evaluate(() => {
    const e = document.querySelector(".msg.turn .tq"); if (!e) return null;
    const q = e.getBoundingClientRect();
    return { x: q.left, y: q.top };
  });
  if (!r) { check(false, `${theme}: no quote to measure`); continue; }
  // 8 CSS px of the feed's gutter, then the box's own left edge; 2 CSS px tall off the TOP of the
  // box, which is half-leading in every variant and glyph ink in none.
  const shot = await pg.screenshot({ clip: { x: r.x - 8, y: r.y, width: 12, height: 2 } });
  const px = await pg.evaluate(async data => {
    const img = new Image(); img.src = "data:image/png;base64," + data;
    await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    const at = x => { const d = ctx.getImageData(x, Math.floor(img.height / 2), 1, 1).data; return [d[0], d[1], d[2]]; };
    // deviceScaleFactor 2, clip starting 8 CSS px left of the box: device 16-19 is where a 2px
    // border would paint. Device 4 is CSS 6 to its LEFT — the feed's gutter, page ground always.
    return { wasBar: at(17), gutter: at(4) };
  }, shot.toString("base64"));
  const delta = Math.max(...px.wasBar.map((v, i) => Math.abs(v - px.gutter[i])));
  check(delta <= 6, `${theme}: NOTHING is painted where the bar was — ${delta}/255 (was-bar ${px.wasBar}, gutter ${px.gutter})`);
  if (theme === "light") await pg.close();
}

// ---- 5. THE PRICE, PAID — a number kept as the record of a decision -----------------------------
// Narration and the reply now differ in NOTHING. That is the same measurement the v0.4.173 revival
// treated as the bug ("the app read as having lost thoughts"), and it is here as a passing check
// rather than a failing one because the two situations are not the same situation: that release was
// fixing narration nobody had ever marked, and this is narration whose marking the owner has seen —
// bar, then indent-without-bar, rendered side by side — and declined both. The count stays so the
// choice stays legible: if it ever moves off zero, someone has re-marked narration, and that is a
// decision to be taken deliberately and not a repair.
const boxDiff = ["bar", "padLeft", "size", "weight", "style", "colour", "opacity"]
  .filter(k => live.quote?.[k] !== live.reply?.[k]);
check(boxDiff.length === 0,
  `narration measures byte-identical to the reply — the A1 state, picked off the render (differs on: ${boxDiff.join(", ") || "NOTHING"})`);

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
