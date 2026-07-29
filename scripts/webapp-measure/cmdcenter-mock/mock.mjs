// Command-center MOCKUP renderer — design artifact, not a check suite.
// Composes a static page from the REAL webapp/index.html <style> block (so every token, card,
// bubble and composer rule is the shipping one) plus a small command-center layer, and shoots
// the three states for the owner to judge. No app JS runs; fixtures are hand-written.
// Usage: node mock.mjs [outdir]   (default ./out)
import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || join(here, "out"));
mkdirSync(out, { recursive: true });

const page = readFileSync(join(here, "../../../webapp/index.html"), "utf8");
const style = page.match(/<style>([\s\S]*?)<\/style>/)[1];

// ---- The command-center layer: everything here derives from the app's own tokens ----
const CC_CSS = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; overflow: hidden; }
  .tabs { flex: none; }

  /* Usage strip: ONE thin line, account-level, shown once. Meta type, hint ink, the app's own
     .bar anatomy at the foot-bar height. Quiet by design — it must never compete with the fleet. */
  .ccusage { flex: none; display: flex; align-items: center; gap: var(--sp-2);
    padding: 6px var(--sp-4) 2px; color: var(--hint); font-size: var(--t-meta); }
  .ccusage .lbl { flex: none; }
  .ccusage .bar { flex: 1; margin-top: 0; height: 4px; }
  .ccusage .pct { flex: none; min-width: 30px; }
  .ccusage .gap { flex: none; width: var(--sp-3); }

  /* Fleet strip, PEEK mode: one row of chips, horizontally scrollable, attention first.
     Chip anatomy repeats the card's title row: dot + name + state emoji + ctx%. */
  .ccfleet { flex: none; padding: var(--sp-2) 0 var(--sp-2); }
  .ccrailwrap { display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); }
  .ccrail { display: flex; gap: var(--sp-2); overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
  .fchip { flex: none; display: flex; align-items: center; gap: 6px; height: 36px;
    padding: 0 var(--sp-3); border: none; border-radius: 18px; background: var(--sec);
    color: var(--text); font-size: var(--t-sub); cursor: pointer; }
  .fchip .nm { font-weight: var(--w-semi); }
  .fchip .fm { color: var(--hint); font-size: var(--t-meta); }
  /* Attention: low-alpha amber wash + inset ring — fill and ring, never shadow or motion.
     The amber is .dot.wait's own. */
  .fchip.attn, .sess.attn { background: color-mix(in srgb, #e0a33e 9%, var(--sec));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #e0a33e 35%, transparent); }
  .fbtn { flex: none; width: 36px; height: 36px; border-radius: 18px; border: none;
    background: var(--sec); color: var(--hint); display: flex; align-items: center;
    justify-content: center; padding: 6px; cursor: pointer; }
  .fbtn svg { width: 20px; height: 20px; display: block; }

  /* Fleet strip, EXPANDED: header line + today's cards (the existing .sess card, verbatim). */
  .ccfleet .cards { display: none; padding: 0 var(--sp-4); }
  .ccfleet.open .ccrailwrap { display: none; }
  .ccfleet.open .cards { display: block; }
  .cchead { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
  .cchead .t { color: var(--hint); font-size: var(--t-meta); text-transform: uppercase;
    letter-spacing: .06em; flex: 1; }
  .cchead .fbtn.wide { width: auto; padding: 0 var(--sp-3); font-size: var(--t-sub); gap: 6px; color: var(--text); }
  .cchead .fbtn.wide svg { width: 16px; height: 16px; }

  /* Main body: the chat lane. Normal-flow feed + the real composer at the floor. */
  .ccfeed { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-3) var(--sp-4) var(--sp-3);
    display: flex; flex-direction: column; }
  .ccfeed .spacer { flex: 1; }
  .ccdock { flex: none; position: relative; }
  #dsend { display: none; }
`;

const CHEV_D = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
const CHEV_U = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const FIN = '<svg class="fin" width="5" height="5" viewBox="0 0 5 5" aria-hidden="true"><circle cx="2.5" cy="2.5" r="2.5" fill="currentColor"/></svg>';
const XSVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

const TABS = page.match(/<nav class="tabs"[\s\S]*?<\/nav>/)[0];

const usage = `
  <div class="ccusage">
    <span class="lbl">5h</span><div class="bar"><span style="width:10%"></span></div><span class="pct">10%</span>
    <span class="gap"></span>
    <span class="lbl">week</span><div class="bar"><span style="width:34%"></span></div><span class="pct">34%</span>
  </div>`;

const chip = (dot, name, emoji, ctx) =>
  `<button class="fchip"><span class="dot ${dot}"></span><span class="nm">${name}</span><span>${emoji}</span><span class="fm">${ctx}%</span></button>`;
// An ATTENTION chip trades the ctx% for the wait reason: in peek mode the one thing the strip
// must say is what needs the owner, and "smith ⏳ 41%" does not say it.
const attnChip = (name, label) =>
  `<button class="fchip attn"><span class="dot wait"></span><span class="nm">${name}</span><span>⏳ ${label}</span></button>`;

const FLEET_CALM = [chip("on", "cc-bridge", "🧑‍💻", 15), chip("on", "weather", "🧑‍💻", 27), chip("", "memes", "✅", 8)];
const FLEET_ATTN = [attnChip("smith", "approve Fable plan"), ...FLEET_CALM];

const rail = chips => `
  <div class="ccfleet"><div class="ccrailwrap">
    <div class="ccrail">${chips.join("")}</div>
    <button class="fbtn" title="New session">${PLUS}</button>
    <button class="fbtn" title="Expand fleet">${CHEV_D}</button>
  </div></div>`;

const card = (dot, name, chips, task, foot, attn) => `
  <div class="sess${attn ? " attn" : ""}">
    <div class="top"><span class="dot ${dot}"></span><span class="nm">${name}</span>
      ${chips.map(x => `<span class="chip">${x}</span>`).join("")}
      <button class="cardx">${XSVG}</button></div>
    <div class="task">${task}</div>
    ${foot ? `<div class="foot">${foot}</div>` : ""}
  </div>`;

const bar = p => `<div class="bar"><span style="width:${p}%"></span></div>`;

const CARDS = `
  <div class="ccfleet open"><div class="cards">
    <div class="cchead"><span class="t">Fleet · 4</span>
      <button class="fbtn wide">${PLUS}New session</button>
      <button class="fbtn" title="Collapse">${CHEV_U}</button></div>
    ${card("wait", "smith", ["Fable 5 ⚡high", "bypass"], "⏳ waiting: approve Fable plan (ask 731)", `<span>🌿 main</span><span>ctx 41%</span>${bar(41)}`, true)}
    ${card("on", "cc-bridge", ["Opus 5 ⚡high", "bypass"], "🧑‍💻 Bash timeout 600 node suite.mjs 2>&1 | tail -12", `<span>🌿 main</span><span>ctx 15%</span>${bar(15)}`)}
    ${card("on", "weather", ["Fable 5 ⚡high", "bypass"], "🧑‍💻 1 subagent live · Agent Re-verify suite", `<span>ctx 27%</span>${bar(27)}`)}
    ${card("", "memes", ["Fable 5 ⚡high", "bypass"], "✅ Backfill checkpointed at 2026-07-28; nothing queued", `<span>ctx 8%</span>${bar(8)}`)}
  </div></div>`;

const FEED = `
  <div class="ccfeed"><div class="spacer"></div>
    <div class="msg user">Have smith review the composer change before it ships, and keep the deploy for tonight.<span class="tstamp">21:38</span></div>
    <div class="msg assistant">${FIN}Briefed smith over the bus — it is reading the diff now and will hold the deploy until you approve its Fable plan. cc-bridge is mid-verification on the composer suite; nothing ships before both come back.</div>
    <div class="msg user">What came of the weather run?<span class="tstamp">21:52</span></div>
    <div class="msg assistant">${FIN}The re-verify suite passed 34 of 36 — the two failures are the known flaky pair. Full report is in the topic; nothing needs you.</div>
  </div>`;

// The real composer, statically: mic state, dial reads the chat lane's own dials.
const composer = page.match(/<div class="composer">[\s\S]*?<input id="dfpho"[^>]*>\s*<\/div>/)[0]
  .replace('<b id="ddialm">Model</b>', '<b id="ddialm">fable</b>')
  .replace('<span class="eff" id="ddiale"></span>', '<span class="eff" id="ddiale">high</span>');

const shell = body => `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${style}</style><style>${CC_CSS}</style></head>
  <body>${TABS}${body}<div class="ccdock">${composer}</div></body></html>`;

const states = {
  "1-peek-attention": shell(usage + rail(FLEET_ATTN) + FEED),
  "2-expanded": shell(usage + CARDS + FEED),
  "3-peek-calm": shell(usage + rail(FLEET_CALM) + FEED),
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
for (const [name, html] of Object.entries(states)) {
  const file = join(out, name + ".html");
  writeFileSync(file, html);
  const p = await ctx.newPage();
  await p.goto("file://" + file);
  await p.evaluate(() => { const f = document.querySelector(".ccfeed"); if (f) f.scrollTop = 1e6; });
  await p.waitForTimeout(600); // idle before reading — fonts, layout settle
  await p.screenshot({ path: join(out, name + ".png") });
  await p.close();
  console.log("shot", name);
}
await browser.close();
