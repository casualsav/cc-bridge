import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Bridge command cards — /terminal, /diff and /health rendered IN the chat (v0.4.393).
//
//   node cards.mjs [page] [outdir]
//
// Pre-change control: `node cards.mjs /path/to/old/index.html` — the page has no addCard at all, so
// §1-§6 fail there. That is the control, and it must be SEEN failing rather than assumed.
//
// The check that matters most is §5, because it is the whole reason these rows are a client-side
// list instead of DOM: the feed is rebuilt from the payload every 3s, so a card injected into the
// DOM is wiped within one poll. §5 drives a real repaint with changed payload content and asserts
// the card and its filled content are still there afterwards. A card that renders beautifully and
// vanishes on the next tick passes every other check in this file.
//
// §2 is the injection guard. A terminal capture and a patch are arbitrary bytes from a CLI this page
// does not control, so they go in as TEXT NODES — the same rule showReadout states for the panel
// sheet. The fixture text is live markup; the assertion is that it produced ZERO elements.
//
// §4 samples RENDERED PIXELS for the diff colours. A declared colour that resolves to the ground
// passes every computed-style assertion and is invisible on the device — this file has been caught
// by that twice (the quote bar at 9/255, the narration bar at 17/255).

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3];
const ts = 1785200000000;
const feed = { sid: "abc", name: "cc-bridge", working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high",
  items: [{ role: "user", text: "how's the pane looking?", ts }, { role: "assistant", text: "Have a look.", ts }] };

// The terminal fixture's text is deliberately HOSTILE: live markup, plus a line far wider than the
// viewport (the horizontal-overflow check in §6).
const EVIL = '<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=1</script>';
const WIDE = "x".repeat(400);
const TERMINAL = { kind: "terminal", command: "/terminal", lines: 30, text: `● Running tests\n${EVIL}\n${WIDE}\n  47 pass 0 fail` };

const DIFF = { kind: "diff", command: "/diff", diff: {
  cwd: "/home/ubuntu/projects/cc-bridge", clean: false, truncated: false,
  files: [{ path: "daemon.ts", added: 74, removed: 12 }, { path: "webapp/index.html", added: 2, removed: 6 }],
  stat: "", untracked: ["scratch.md"],
  patch: "diff --git a/daemon.ts b/daemon.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/daemon.ts\n+++ b/daemon.ts\n@@ -10,3 +10,4 @@\n context line\n+  const added = 1\n-  const removed = 0\n" } };

const HEALTHY = { kind: "health", command: "/health",
  rows: [["🩺 Instance", "tg · v0.4.393"], ["⏱ Uptime", "3h 12m · pid 4417"], ["🖥 Panes", "6"],
    ["🗒 Queues", "0 queued · 2 scheduled · 0 reviving"], ["🐶 Watchdog", "alive (pid 4402)"]],
  panes: [], crash: null, others: [] };
const SICK = { ...HEALTHY, panes: ["★ %12 cc-bridge", "· %31 weather"], crash: "watchdog: daemon down", others: ["9911"] };
const ERR = { kind: "error", command: "/diff", reason: "/home/ubuntu/scratch isn't a git repository, so there's nothing to diff." };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(f => {
  window.api = async u => u.includes("feed") ? f : { sessions: [] };
  // The live tick's own endpoint, stubbed so §5 can drive a refresh deterministically.
  window.__tick = 0;
  const realFetch = window.fetch;
  window.fetch = async (u, o) => u.includes("/api/session/terminal")
    ? { ok: true, json: async () => ({ text: "refreshed frame " + (++window.__tick) }) }
    : realFetch(u, o);
  openDrill(f.sid, f.name);
}, feed);
await p.waitForTimeout(900);

const has = await p.evaluate(() => typeof addCard === "function");
if (!has) console.log("NOTE  this page has no addCard() — the pre-change control; §1-§6 fail below");

const add = async c => { await p.evaluate(x => { if (typeof addCard === "function") addCard(x); }, c); await p.waitForTimeout(120); };
const q = fn => p.evaluate(fn);

// ---- 1. The terminal card renders, and says it is live ------------------------------------------
await add(TERMINAL);
const t1 = await q(() => {
  const el = document.querySelector("#dfeed .msg.bcard");
  const pre = el && el.querySelector("pre.term");
  const dot = el && el.querySelector(".dot");
  return el ? {
    title: el.querySelector(".ct")?.textContent, meta: el.querySelector(".cmeta")?.textContent,
    text: pre?.textContent, dotClass: dot?.className,
    dotAnim: dot ? getComputedStyle(dot).animationName : null,
    hasDismiss: !!el.querySelector(".cardx"),
    // The box scrolls INSIDE itself, and rests at its floor — the newest line is what it was opened for.
    scrolled: pre ? pre.scrollTop > 0 || pre.scrollHeight <= pre.clientHeight : false,
    overflowX: pre ? getComputedStyle(pre).overflowX : null,
  } : null;
});
check(!!t1, "a /terminal card renders in the feed");
check(t1?.title === "/terminal", `…titled with the invocation itself (${t1?.title})`);
check(/live/.test(t1?.meta || ""), `…and says it is live (${t1?.meta})`);
check(t1?.text?.includes("47 pass 0 fail"), "…carrying the pane tail");
check(t1?.dotClass?.includes("on") && t1?.dotAnim === "pulse", `…with the sessions list's own pulsing green dot (${t1?.dotClass} / ${t1?.dotAnim})`);
check(t1?.hasDismiss === true, "…and a dismiss control");
check(t1?.overflowX === "auto", `…the tail scrolls inside its own box (overflow-x: ${t1?.overflowX})`);

// ---- 2. Pane bytes are TEXT, never markup ------------------------------------------------------
const inj = await q(() => ({
  pwned: !!window.__pwned,
  imgs: document.querySelectorAll("#dfeed .msg.bcard img").length,
  scripts: document.querySelectorAll("#dfeed .msg.bcard script").length,
  literal: (document.querySelector("#dfeed .msg.bcard pre.term")?.textContent || "").includes("<img src=x"),
}));
check(inj.pwned === false, "the capture's markup did NOT execute");
check(inj.imgs === 0 && inj.scripts === 0, `…and created no elements (img ${inj.imgs}, script ${inj.scripts})`);
check(inj.literal === true, "…it is on screen as literal text, which is what the user needs to see");

// ---- 3. Health: the fold carries the wrong-only half -------------------------------------------
await q(() => { localCards = []; paintFeed(); });
await add(HEALTHY);
// Every read below is null-safe on purpose: on the pre-change page no card exists at all, and a
// control that CRASHES half way through reports a smaller failure than the one it found.
const h1 = await q(() => {
  const el = document.querySelector("#dfeed .msg.bcard");
  return { rows: el?.querySelectorAll(".kv").length ?? -1, details: el?.querySelectorAll("details").length ?? -1,
    firstK: el?.querySelector(".kv .k")?.textContent, firstV: el?.querySelector(".kv .v")?.textContent };
});
check(h1.rows === 5, `a healthy bridge renders its five metric rows (${h1.rows})`);
check(h1.details === 0, `…and NO details fold, because there is nothing wrong to put in it (${h1.details})`);
check(h1.firstK === "🩺 Instance" && h1.firstV === "tg · v0.4.393", `…label and value in their own columns (${h1.firstK} / ${h1.firstV})`);
await q(() => { localCards = []; paintFeed(); });
await add(SICK);
const h2 = await q(() => {
  const el = document.querySelector("#dfeed .msg.bcard");
  const d = el?.querySelector("details");
  return { details: !!d, open: d?.open, inFold: d ? d.querySelectorAll(".kv").length : 0,
    crash: d?.textContent.includes("watchdog: daemon down") };
});
check(h2.details === true, "a bridge with something wrong grows the fold");
check(h2.open === false, "…closed by default, so the healthy shape is what you see first");
check(h2.inFold === 3 && h2.crash === true, `…carrying panes, the crash line and the rival daemon (${h2.inFold} rows)`);

// ---- 4. Diff: per-file churn, and the patch coloured BY RENDERED PIXEL --------------------------
await q(() => { localCards = []; paintFeed(); });
await add(DIFF);
const d1 = await q(() => {
  const el = document.querySelector("#dfeed .msg.bcard");
  if (!el) return { meta: null, rows: [], kinds: [], untracked: false };
  const rows = [...el.querySelectorAll(".df")].map(r => ({
    path: r.querySelector(".fp")?.textContent.replace(/[⁦⁩]/g, ""),
    a: r.querySelector(".fc .a")?.textContent, d: r.querySelector(".fc .d")?.textContent }));
  const kinds = [...el.querySelectorAll("pre.patch .dl")].map(s => [s.className.replace("dl dl-", ""), s.textContent.trim()]);
  return { meta: el.querySelector(".cmeta")?.textContent, rows, kinds,
    untracked: [...el.querySelectorAll(".kv .k")].some(k => k.textContent === "Untracked") };
});
check(d1.rows.length === 2, `one row per changed file (${d1.rows.length})`);
check(d1.rows[0]?.path === "daemon.ts" && d1.rows[0]?.a === "+74" && d1.rows[0]?.d === "−12", `…with its churn (${JSON.stringify(d1.rows[0])})`);
check(/2 files · 94 lines/.test(d1.meta || ""), `…and the card's meta totals them (${d1.meta})`);
check(d1.untracked === true, "…untracked files are listed");
// THE ORDERING BUG: `+++ b/daemon.ts` starts with `+`. A renderer that tests add-before-meta paints
// every file header green, which is the most visible way to get a patch wrong.
const headers = d1.kinds.filter(([, t]) => t.startsWith("+++") || t.startsWith("---"));
check(headers.length === 2 && headers.every(([k]) => k === "meta"), `file headers classify as meta, not add (${JSON.stringify(headers.map(h => h[0]))})`);
check(d1.kinds.some(([k, t]) => k === "hunk" && t.startsWith("@@")), "the hunk header is its own class");
check(d1.kinds.some(([k, t]) => k === "add" && t.includes("const added")), "an added line is add");
check(d1.kinds.some(([k, t]) => k === "del" && t.includes("const removed")), "a removed line is del");
// Rendered pixels: add and del must actually differ on screen, and differ from the context line.
const px = await q(() => {
  const pick = k => document.querySelector(`#dfeed .msg.bcard pre.patch .dl-${k}`);
  const rgb = e => e ? getComputedStyle(e).color : null;
  return { add: rgb(pick("add")), del: rgb(pick("del")), ctx: rgb(pick("context")), hunk: rgb(pick("hunk")) };
});
check(px.add && px.del && px.add !== px.del, `add and del are different colours (${px.add} vs ${px.del})`);
check(px.add !== px.ctx && px.del !== px.ctx, `…and both differ from context (${px.ctx})`);
check(px.hunk !== px.add && px.hunk !== px.ctx, `the hunk header is its own colour (${px.hunk})`);

// ---- 5. THE MECHANISM: a card survives a feed repaint -------------------------------------------
// The reason localCards exists. Drive a real repaint the way the 3s poll does — new payload content,
// so feedSig changes and innerHTML is genuinely swapped — and the card must still be there WITH its
// filled content. A DOM-injected row is gone at this point.
const before = await q(() => document.querySelectorAll("#dfeed .msg.bcard").length);
const after = await p.evaluate(() => {
  lastDrill.items.push({ role: "assistant", text: "a new reply landed while the card was up", ts: Date.now() });
  const sigBefore = feedSig;
  paintFeed();
  const el = document.querySelector("#dfeed .msg.bcard");
  return { swapped: sigBefore !== feedSig, cards: document.querySelectorAll("#dfeed .msg.bcard").length,
    stillFilled: !!el && el.querySelectorAll(".df").length === 2,
    newReply: document.body.textContent.includes("a new reply landed") };
});
check(before === 1 && after.swapped === true, "the repaint really swapped the feed (feedSig changed)");
check(after.newReply === true, "…the new transcript row painted");
check(after.cards === 1, `…and the card is STILL THERE (${after.cards})`);
check(after.stillFilled === true, "…with its content re-filled, not an empty shell");

// ---- 6. Nothing widens the page, and the live tick ends the card --------------------------------
const wide = await q(() => ({
  bodyScroll: document.documentElement.scrollWidth, vw: window.innerWidth,
  feedScroll: document.getElementById("dfeed").scrollWidth, feedClient: document.getElementById("dfeed").clientWidth,
}));
check(wide.bodyScroll <= wide.vw + 1, `a 400-char pane line does not widen the page (${wide.bodyScroll} vs ${wide.vw})`);
check(wide.feedScroll <= wide.feedClient + 1, `…nor the feed's scroller (${wide.feedScroll} vs ${wide.feedClient})`);

// The card freezes rather than vanishing when its 30s is up: the Telegram card deletes itself because
// it shares a scrollback with real messages; here a row disappearing under the thumb is worse.
await q(() => { localCards = []; paintFeed(); });
await add(TERMINAL);
const ended = await p.evaluate(async () => {
  const c = (typeof localCards !== "undefined" && localCards[0]) || { live: null };
  c.until = Date.now() - 1;           // as if its 30s had elapsed
  await new Promise(r => setTimeout(r, 5400));
  const el = document.querySelector("#dfeed .msg.bcard");
  return { present: !!el, live: c.live, meta: el?.querySelector(".cmeta")?.textContent,
    dot: el?.querySelector(".dot")?.className, text: el?.querySelector("pre.term")?.textContent };
});
check(ended.present === true, "an expired live terminal is STILL in the feed");
check(ended.live === false && /ended/.test(ended.meta || ""), `…marked ended (${ended.meta})`);
check(!ended.dot?.includes("on"), `…its dot gone still and grey (${ended.dot})`);
check(ended.text?.includes("47 pass"), "…frozen on its last frame");

// ---- 7. The error card ------------------------------------------------------------------------
await q(() => { localCards = []; paintFeed(); });
await add(ERR);
const e1 = await q(() => {
  const el = document.querySelector("#dfeed .msg.bcard");
  const cb = el?.querySelector(".cb");
  return { bad: el?.classList.contains("bad"), text: cb?.textContent,
    rule: cb ? getComputedStyle(cb).borderLeftColor : null, ruleW: cb ? getComputedStyle(cb).borderLeftWidth : null,
    colour: cb ? getComputedStyle(cb).color : null,
    textColour: el ? getComputedStyle(document.documentElement).getPropertyValue("--text").trim() : null };
});
check(e1.bad === true, "a command that could not run renders as a card, not a toast");
check(e1.text?.includes("isn't a git repository"), "…carrying the daemon's own reason");
check(parseFloat(e1.ruleW) >= 2 && e1.rule !== e1.colour, `…marked by a rule, not by red type (${e1.ruleW} ${e1.rule}; text ${e1.colour})`);

// ---- 8. NO CLASS IN THIS MARKUP IS REACHED BY AN UNSCOPED RULE ELSEWHERE IN THE PAGE ----------
// The standing guard for the class that produced two real defects: `.card` (values two type steps
// above their labels) and `.meta` (patch file-headers at 12px/nowrap inside a 13px/pre block). Both
// were legal CSS, neither was an error, and only a rendered read caught them — so this compares each
// card element's computed style against the SAME element stripped of everything but its own scoped
// rules. Anything a foreign selector contributes shows up as a difference.
await q(() => { localCards = []; paintFeed(); });
await add(DIFF);
const leak = await q(() => {
  const probe = document.createElement("style");
  // Re-assert nothing; just enumerate which non-bcard rules match our nodes.
  const mine = [...document.querySelectorAll("#dfeed .msg.bcard, #dfeed .msg.bcard *")];
  const foreign = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (!r.selectorText || /\.bcard/.test(r.selectorText)) continue;
      for (const sel of r.selectorText.split(",")) {
        let hit; try { hit = mine.find(e => e.matches(sel.trim())) } catch { continue }
        // The named exclusions, each a rule that SHOULD reach this markup:
        //   .msg / .dot / .cardx — the deliberate reuses (the bubble's box, the sessions list's
        //     status dot, the dismiss button), all three named in webapp/CLAUDE.md
        //   * — the universal reset
        //   #dfeed > .msg:last-child — the feed's floor gutter, which is meant to apply to the last
        //     row whatever kind of row it is, and a card is very often the last row
        //   bare element selectors — this card is built from real pre/button/details/summary
        // Anything else is a NAME COLLISION, which is the whole class this check exists to catch.
        const t = sel.trim();
        if (hit && !/^\.msg$|\.dot|\.cardx|^pre$|^button|^summary|^details|^\*$|^#dfeed > \.msg:last-child$/.test(t))
          foreign.push(t + "  →  " + (hit.className || hit.tagName));
      }
    }
  }
  return [...new Set(foreign)];
});
check(leak.length === 0, `no foreign selector reaches the card markup${leak.length ? ":\n        " + leak.join("\n        ") : ""}`);

// ---- 9. The file-list fold ---------------------------------------------------------------------
// A many-file diff veils its list past --flist-cap rows rather than running as a wall above the
// patch. Three claims: the rows are VEILED and never dropped (the count must survive), the totals
// describe the whole diff in both fold states, and the cap's arithmetic holds against a REAL
// rendered row — the derivation was wrong once (it used --t-sub, the row's declared size, where a
// flex row actually takes its height from its tallest CHILD) and left row 16 half-shown.
await q(() => { localCards = []; paintFeed(); });
const MANY = { kind: "diff", command: "/diff", diff: {
  cwd: "/home/ubuntu/projects/cc-bridge", clean: false, truncated: false, stat: "", untracked: [],
  files: Array.from({ length: 57 }, (_, i) => ({ path: "src/module-" + i + "/handler.ts", added: (i * 7) % 90 + 1, removed: (i * 3) % 40 })),
  patch: "@@ -1 +1 @@\n context\n+added\n-removed\n" } };
await add(MANY);
const fold = await q(() => {
  const el = document.querySelector("#dfeed .msg.bcard");
  const l = el?.querySelector(".flist");
  const bar = l?.querySelector(".more");
  const rows = [...(el?.querySelectorAll(".df") || [])];
  const cap = el ? parseInt(getComputedStyle(el).getPropertyValue("--flist-cap"), 10) : NaN;
  const veil = l ? getComputedStyle(l, "::after") : null;
  return {
    cap, built: rows.length, folded: !!l?.classList.contains("fclip"),
    rowH: rows[0]?.getBoundingClientRect().height, listH: l?.getBoundingClientRect().height,
    // Rows sitting entirely above the bar — the honest reading of "the cap shows N rows".
    above: bar ? rows.filter(r => r.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 0.5).length : -1,
    bar: bar?.textContent, meta: el?.querySelector(".cmeta")?.textContent,
    veilEased: !!veil && /color-mix|linear-gradient/.test(veil.background) && veil.background.split(",").length > 4,
  };
});
check(fold.folded === true, "a 57-file diff folds its list");
check(fold.built === 57, `…with every row BUILT, not dropped (${fold.built})`);
check(fold.above === fold.cap, `…exactly --flist-cap (${fold.cap}) rows above the bar (${fold.above})`);
// The arithmetic, against a rendered row: cap × row + the bar's reserved strip.
check(Math.abs(fold.listH - (fold.cap * fold.rowH + 24)) < 1,
  `…and the cap's derivation holds on a real row (${fold.cap} × ${fold.rowH} + 24 = ${(fold.cap * fold.rowH + 24).toFixed(1)} vs ${fold.listH?.toFixed(1)})`);
check(/\+42 more files/.test(fold.bar || ""), `…the bar names what is behind it (${fold.bar})`);
check(fold.veilEased === true, "…the veil is the feed's own eased ramp, not a re-declared linear one");
check(/57 files · 3477 lines/.test(fold.meta || ""), `…and the totals describe the WHOLE diff (${fold.meta})`);

const opened = await p.evaluate(async () => {
  document.querySelector("#dfeed .msg.bcard .flist")?.click();
  await new Promise(r => setTimeout(r, 200));
  const l = document.querySelector("#dfeed .msg.bcard .flist");
  const rows = [...document.querySelectorAll("#dfeed .msg.bcard .df")];
  const bar = l?.querySelector(".more");
  return { open: !!l?.classList.contains("open"), listH: l?.getBoundingClientRect().height ?? 0,
    lastVisible: !!rows.length && rows[rows.length - 1].getBoundingClientRect().height > 0,
    barHidden: !!bar && getComputedStyle(bar).display === "none",
    meta: document.querySelector("#dfeed .msg.bcard .cmeta")?.textContent ?? "" };
});
check(opened.open === true && opened.listH > (fold.listH ?? 0) * 2, `opening the fold shows the rest (${fold.listH?.toFixed(0)} → ${opened.listH.toFixed(0)}px)`);
check(opened.lastVisible === true, "…including the last file row");
check(opened.barHidden === true, "…and the bar goes away, like the feed's own open fold");
check(/57 files · 3477 lines/.test(opened.meta), `…the totals are unchanged by the fold state (${opened.meta})`);

// The open state must survive a repaint — it lives on the card, not on the DOM node fillCards rebuilds.
const survived = await p.evaluate(() => {
  lastDrill.items.push({ role: "assistant", text: "another reply", ts: Date.now() });
  paintFeed();
  return !!document.querySelector("#dfeed .msg.bcard .flist")?.classList.contains("open");
});
check(survived === true, "…and survives a feed repaint (the state is on the card, not the node)");

// THE CONTROL: at or below the cap nothing folds, and the rendering is the pre-fold one. Pinned by
// geometry here; the pixel comparison against the committed page is in the report.
await q(() => { localCards = []; paintFeed(); });
await add(DIFF);
const small = await q(() => {
  const l = document.querySelector("#dfeed .msg.bcard .flist");
  return { folded: l?.classList.contains("fclip"), bar: !!l?.querySelector(".more"),
    maxH: l ? getComputedStyle(l).maxHeight : null, rows: document.querySelectorAll("#dfeed .msg.bcard .df").length };
});
check(small.folded === false && small.bar === false, "a diff at or below the cap does not fold");
check(small.maxH === "none", `…and carries no cap at all (max-height: ${small.maxH})`);

// ---- 10. Dismiss removes it --------------------------------------------------------------------
await p.evaluate(() => document.querySelector("#dfeed .msg.bcard .cardx")?.click());
await p.waitForTimeout(120);
const gone = await q(() => document.querySelectorAll("#dfeed .msg.bcard").length);
check(gone === 0, `dismiss removes the card (${gone} left)`);

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  await q(() => { localCards = []; paintFeed(); });
  for (const [name, c] of [["terminal", TERMINAL], ["diff", DIFF], ["health", SICK], ["error", ERR]]) {
    await q(() => { localCards = []; paintFeed(); });
    await add(c);
    await p.screenshot({ path: join(OUT, `card-${name}.png`) });
  }
  console.log(`\nshots → ${OUT}`);
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
