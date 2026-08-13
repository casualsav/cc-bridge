import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The Sessions page restyle: the reference's card GEOMETRY, and a new-session pill that floats over
// the list instead of sitting above it.
//
// Two claims need different kinds of proof and the split is the point:
//
//   GEOMETRY is measured off the rendered boxes — radius, padding, the dot, the type step, and the
//   list starting flush under the tab bar where the dashed row used to be. Every one of these FAILS
//   on a pre-change copy of the page (`node sessions.mjs /path/to/old/index.html`).
//
//   TWO control pages, because there were two rounds. v0.4.169 is the pre-restyle page and fails the
//   radius / padding / type / pill / dashed-row checks. v0.4.170 shipped an icon TILE with the status
//   dot promoted into it, which the owner rejected on device — so it is the control for the three
//   checks that say the tile is gone and the dot is back in the title line at 11px. Neither page
//   alone can fail both sets, and the tile checks would pass vacuously against 0.4.169.
//
//   LAYERING cannot be proved that way. The pre-change page has no pill at all, so "the pill paints
//   over the list" passes vacuously against it. It is hit-tested with elementFromPoint AND carries
//   its own falsifying control: the same probe is re-run with the pill pushed to z-index -1, and the
//   harness fails if that still reports the pill on top. Same for the scroll relief — the list's
//   bottom padding is stripped at runtime and the last card must then be caught under the pill.
//
// The CONTENTS check is a guard, not a control: it runs the same fixture through both pages and
// requires every card's text to match byte for byte. It passes on both by design — the change is
// shape only, and this is what says so.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
// The baseline for the contents diff: HEAD's copy of the page, written out so it can be rendered.
const BASE = join(mkdtempSync(join(tmpdir(), "sess-")), "head.html");
writeFileSync(BASE, execFileSync("git", ["show", "HEAD:webapp/index.html"], { cwd: REPO, maxBuffer: 32e6 }));

// Enough cards to overflow an 812px viewport twice over — the relief check needs a real scroll, and
// the last card has to be one you reach by scrolling rather than one already on screen.
const SESSIONS = Array.from({ length: 9 }, (_, i) => ({
  sid: "s" + i, name: ["cc-bridge", "memes-backfill", "store-template", "suite-index", "polyscan",
    "a-considerably-longer-session-name-than-fits", "dm-bridge", "taste", "webapp"][i],
  alive: i !== 8, working: i % 3 === 0,
  cwd: "~/projects/x", model: i % 2 ? "Opus 5" : "Sonnet 5", effort: i % 2 ? "high" : "medium",
  task: i % 4 === 3 ? "" : "Reading the transcript back and folding the working row into the composer",
  subagents: i === 1 ? 2 : 0, branch: i % 2 ? "main" : "feat/cards",
  ctxPct: i % 2 ? 41 : null, h5Pct: i === 2 ? 68 : null,
}));

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };
const near = (a, b, tol, l) => check(Math.abs(a - b) <= tol, `${l} (${a?.toFixed ? a.toFixed(2) : a} vs ${b})`);

const b = await chromium.launch();
const open = async path => {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + path, { waitUntil: "domcontentloaded" });
  // Driven through showTab, not by calling renderSessions() — boot() is gated on Telegram's init data
  // and never runs from a file:// URL, and the pill's visibility is showTab's to carry. Anything else
  // would measure a screen the app never assembles. The stub answers every tab's fetch, since the
  // harness switches away and back.
  await p.evaluate(list => {
    window.api = async u => u.includes("/api/sessions") ? { sessions: list } : { accounts: [], jobs: [], settings: [], write: false };
    showTab("sessions");
  }, SESSIONS);
  await p.waitForTimeout(600);
  return p;
};
const p = await open(PAGE);

// ---- 1. Card geometry ------------------------------------------------------------------------
const card = await p.evaluate(() => {
  const c = document.querySelector(".sess"); if (!c) return null;
  const cs = getComputedStyle(c), r = c.getBoundingClientRect();
  const nm = c.querySelector(".nm");
  const dot = c.querySelector(".top .dot");
  const hd = document.getElementById("ddot");
  return {
    radius: parseFloat(cs.borderTopLeftRadius), pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat),
    display: cs.display, fill: cs.backgroundColor, margin: parseFloat(cs.marginBottom),
    tiles: document.querySelectorAll(".stile").length,
    dotsInTitleLine: c.querySelectorAll(".top .dot").length,
    dotSize: dot ? dot.getBoundingClientRect().width : null,
    dotBorder: dot ? getComputedStyle(dot).borderTopWidth : null,
    headDot: hd ? parseFloat(getComputedStyle(hd).width) : null,
    ratio: parseFloat(cs.borderTopLeftRadius) / r.height,
    topRow: c.querySelector(".top").getBoundingClientRect().height,
    cardxMargin: c.querySelector(".cardx") ? parseFloat(getComputedStyle(c.querySelector(".cardx")).marginTop) : null,
    nmClip: nm && getComputedStyle(nm).whiteSpace, nmEllipsis: nm && getComputedStyle(nm).textOverflow,
    nmTitle: !!(nm && nm.title && nm.title.length),
    chipFill: c.querySelector(".chip") && getComputedStyle(c.querySelector(".chip")).backgroundColor,
    // The same class OUTSIDE a card, which is what the scoping claim is about.
    turnChipFill: (() => { const d = document.createElement("span"); d.className = "chip";
      document.body.appendChild(d); const v = getComputedStyle(d).backgroundColor; d.remove(); return v; })(),
    nameSize: nm && parseFloat(getComputedStyle(nm).fontSize),
    taskSize: c.querySelector(".task") && parseFloat(getComputedStyle(c.querySelector(".task")).fontSize),
    pageBg: getComputedStyle(document.body).backgroundColor,
  };
});
check(!!card, "a session card renders at all");
// Round two — DENSITY. The boxiness is the radius-to-height ratio, so both terms are asserted: the
// corner at --r-3xl and the card's own height, measured on the fixture rather than reasoned about.
near(card.radius, 26, 0.5, "card radius is --r-3xl — derived from the height, not the 4px ramp");
check(Math.abs(card.pad[0] - 12) <= 0.5 && Math.abs(card.pad[1] - 14) <= 0.5
   && Math.abs(card.pad[2] - 12) <= 0.5 && Math.abs(card.pad[3] - 14) <= 0.5,
  `card padding is back to 12/14 — the --sp-4 was hosting the tile (${card.pad.join("/")})`);
near(card.margin, 8, 0.5, "and the gap between cards is the reference's own 8");
// --r-3xl (26) is derived, the card is 96 by reflow only: 26/96 = 0.27, nearer the reference (0.33)
// than the 0.22 it read at the pre-clamp 116px height (webapp/CLAUDE.md, "Sessions list and spawn
// sheet" — the 2026-07-29 one-line task-line clamp moved the card, not the radius).
near(card.ratio, 0.27, 0.02, "so the corner is ~0.27 of the card's height (--r-3xl on 96, post-clamp)");
near(card.cardxMargin, -12, 0.5, "the ✕'s 44px target is pulled off the title row's height");
near(card.topRow, 20, 0.6, "which leaves the title row at exactly the name's line box");
check(card.nmClip === "nowrap" && card.nmEllipsis === "ellipsis",
  `the name takes ONE line and ellipsizes, as the reference's own does (${card.nmClip}/${card.nmEllipsis})`);
check(card.nmTitle, "with the full name on `title`, so nothing is unreachable");
// The density claim itself, in pixels. The long-name card is the one that mattered: it wrapped to
// three lines beside the chips and stood 165px tall, and one-line-plus-ellipsis is what makes it the
// same height as every other card rather than the outlier of the list.
const H = await p.evaluate(() => [...document.querySelectorAll(".sess")].map(c => ({
  long: c.querySelector(".nm").textContent.length > 30,
  dead: !!c.textContent.includes("no live pane"),
  task: !!c.querySelector(".task"), h: +c.getBoundingClientRect().height.toFixed(1) })));
const typical = H.filter(c => c.task && !c.long && !c.dead).map(c => c.h);
const longCard = H.find(c => c.long);
check(typical.length > 0 && typical.every(h => h <= 118), `a full card is ≤118px (was 128) — ${typical.join("/")}`);
check(longCard && Math.abs(longCard.h - typical[0]) < 0.5,
  `and a long name no longer makes its own card taller (${longCard?.h} vs ${typical[0]})`);
check(H.filter(c => !c.task).every(h => h.h <= 72), `a card with no task line is ≤72px (${H.filter(c => !c.task).map(c => c.h).join("/")})`);

check(card.chipFill === "rgba(0, 0, 0, 0)", `a card chip carries no fill (${card.chipFill})`);
// Scoped, not gutted: the base .chip rule still declares its fill and the CARD overrides it in
// context. (`.msg.turn .chip` drops the same fill for its own reason — "a chip that paints a surface
// here reads as a nested message" — so this probes the base rule on a bare span, which is the only
// thing that can tell an override apart from a deleted declaration.)
check(card.turnChipFill !== "rgba(0, 0, 0, 0)", `the base .chip rule keeps its fill — the card overrides it in context (${card.turnChipFill})`);
// The tile shipped in v0.4.170 and the owner rejected it on device. Its control is that page, not the
// pre-restyle one: `node sessions.mjs <the 0.4.170 cache copy>` must fail these three.
check(card.tiles === 0, `no icon tile, of any kind (${card.tiles} found)`);
check(card.dotsInTitleLine === 1, `the status dot is back in the title line (found ${card.dotsInTitleLine})`);
near(card.dotSize ?? 0, 11, 0.5, "and one fifth larger than the 9px it had before the tile");
check(card.dotBorder === "0px", `with no container or border around it (${card.dotBorder})`);
// The header's #ddot shares the class and its row is measured to the millimetre — the size must be
// scoped to the card.
check(card.headDot === 9, `the chat header's dot is untouched at 9px (${card.headDot})`);
near(card.nameSize, 14, 0.1, "the session name steps down to --t-sub");
near(card.taskSize, 14, 0.1, "the task line is UNTOUCHED at --t-sub");

// The old dashed row is gone, and its space with it: the first card starts one panel padding from the
// top of the list. On the pre-change page the row is there and pushes the first card down.
// Measured from the LIST's own box, not from the tab bar's bottom — the bar was deleted with the nav
// restructure (2026-07-30) and `document.querySelector(".tabs")` threw here, taking the run with it.
// Measured to the panel's FIRST CHILD rather than to the first card: since 2026-07-30 the list can open
// with a usage header or a "Coding Sessions" label above the cards, and reading `.sess` here measured
// past them (53.39 against 12) — a real layout the check had no opinion about, reported as a failure.
// What it is actually asking is unchanged: nothing sits in the panel's own padding any more.
const head = await p.evaluate(() => {
  const t = document.getElementById("tab-sessions").getBoundingClientRect();
  const el = document.getElementById("tab-sessions").firstElementChild;
  // …less that child's OWN margin, so the claim is "nothing but the panel's padding is above the list"
  // whatever the first row happens to be — a card (no margin-top), the usage header, or the section
  // label (which carries --sp-4 above it by design, and 28 = 12 + 16 is that design, not waste).
  const m = parseFloat(getComputedStyle(el).marginTop) || 0;
  return { gap: el.getBoundingClientRect().top - t.top - m, oldRow: document.querySelectorAll(".newsess").length };
});
check(head.oldRow === 0, `the dashed "New session" row is gone (${head.oldRow} found)`);
near(head.gap, 12, 0.5, "the list starts at the panel's own padding");

// ---- 2. The pill: anchored, shaped, and ABOVE the list -----------------------------------------
const fab = await p.evaluate(() => {
  const f = document.getElementById("newfab"); if (!f) return null;
  const cs = getComputedStyle(f), r = f.getBoundingClientRect();
  return { pos: cs.position, z: cs.zIndex, h: r.height, w: r.width, radius: parseFloat(cs.borderTopLeftRadius),
    fill: cs.backgroundColor,
    glyph: f.querySelector("svg") ? f.querySelector("svg").getBoundingClientRect().width : 0,
    right: innerWidth - r.right, bottom: innerHeight - r.bottom, shadow: cs.boxShadow,
    label: f.textContent.trim(), svg: !!f.querySelector("svg"), aria: f.getAttribute("aria-label") };
});
// Every read below is null-safe on purpose: the pre-change page has no pill at all, and a control run
// has to print a readable column of failures rather than die on the first one.
check(!!fab, "the new-session pill exists");
check(fab?.pos === "fixed", `it is fixed to the viewport (${fab?.pos})`);
near(fab?.h ?? 0, 44, 0.5, "pill height — the reference's 38.5 up a tenth on the owner's ask");
// The owner, 2026-08-13: "just a circle with a plus in the middle. Same height." So the height is
// unchanged and the WIDTH is what moved — a square box the half-height radius then rounds to a circle.
near(fab?.w ?? 0, fab?.h ?? -1, 0.5, "it is SQUARE — a circle, not a stadium");
near(fab?.radius ?? 0, (fab?.h ?? 0) / 2 || -1, 0.6, "its radius is half its height — a circle, not an ellipse");
near(fab?.right ?? -1, 16, 0.5, "anchored --sp-4 from the right edge (reference: 14.5)");
near(fab?.bottom ?? -1, 16, 0.5, "and --sp-4 from the bottom (reference: 14)");
check(fab?.shadow === "none", `no drop shadow (${fab?.shadow})`);
check(fab?.label === "", `it carries NO label — the + is the whole button (${JSON.stringify(fab?.label)})`);
check(!!fab?.svg, "the + is a stroke icon, not an emoji");
// The word left, so the name has to survive somewhere a screen reader can reach it.
check(fab?.aria === "New session", `it is still named for assistive tech (${JSON.stringify(fab?.aria)})`);
near(fab?.glyph ?? 0, 20, 0.5, "the + stays EVEN against an even height (see .sendbtn's half-pixel snap)");
// The blue the app already uses. Compared through a rendered probe rather than by string, since --btn
// is a var() chain that resolves differently once Telegram injects a theme.
const btnMatches = await p.evaluate(() => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;left:-99px;top:0;width:4px;height:4px;background:var(--btn)";
  document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c;
});
check(fab?.fill === btnMatches, `it takes --btn, the app's own blue (${fab?.fill} vs ${btnMatches})`);

// Hit-test, not rect maths: park a card under the pill and ask the page what is on top there.
const probe = async () => p.evaluate(() => {
  const f = document.getElementById("newfab"); if (!f) return { top: false, cardBehind: false };
  const r = f.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const under = document.elementFromPoint(x, y);
  const stack = document.elementsFromPoint(x, y);
  return { top: under && (under.id === "newfab" || f.contains(under)),
    cardBehind: stack.some(e => e.classList && e.classList.contains("sess")) };
});
// Scroll to wherever a card's own middle lines up with the pill's, computed from the rendered
// rects rather than a fixed pixel guess — the 96px-tall reflowed card (was 116) leaves less than
// half the scroll range this fixture used to need, so a fixed 300 overshoots past the last card
// entirely and lands on bare list background. Targets the SECOND-TO-LAST card, keeping this
// distinct from the relief check below, which scrolls to the true end of the list.
// Null-safe like every other read in this section: the pre-change control page has no #newfab,
// and 300 is as good a guess as any when there's no pill to line a card up with.
const scrollTarget = await p.evaluate(() => {
  const fe = document.getElementById("newfab"); if (!fe) return 300;
  const cards = [...document.querySelectorAll(".sess")];
  const c = cards[cards.length - 2].getBoundingClientRect();
  const f = fe.getBoundingClientRect();
  return scrollY + (c.top + c.height / 2) - (f.top + f.height / 2);
});
await p.evaluate(y => scrollTo(0, y), scrollTarget);
await p.waitForTimeout(200);
const hit = await probe();
console.log(`  (scrolled to ${scrollTarget.toFixed(1)}, measured overlap: cardBehind=${hit.cardBehind}, top=${hit.top})`);
check(hit.cardBehind, "a card really is behind the pill at this scroll position (else the probe proves nothing)");
check(hit.top, "the pill is what you hit there — it paints ABOVE the list");
// The falsifying control for that probe: break the layering and require the same check to fail.
await p.evaluate(() => { const f = document.getElementById("newfab"); if (f) f.style.zIndex = "-1"; });
await p.waitForTimeout(100);
check(!(await probe()).top, "control: with the pill at z-index -1 the same probe reports the list on top");
await p.evaluate(() => { const f = document.getElementById("newfab"); if (f) f.style.zIndex = ""; });

// The reason the pill is static markup: the list is wiped and rebuilt every 4s, and a control
// rebuilt under the thumb loses the tap that lands in the swap. Hold the node's identity across a
// full poll cycle and require the SAME element to still be there.
await p.evaluate(() => { window.__fab = document.getElementById("newfab"); });
await p.waitForTimeout(4600);
const survived = await p.evaluate(() => ({
  same: !!window.__fab && window.__fab === document.getElementById("newfab"),
  cards: document.querySelectorAll(".sess").length,
  repainted: !!(window.__fab && window.__fab.parentElement && !document.getElementById("tab-sessions").contains(window.__fab)),
}));
check(survived.cards === SESSIONS.length, "the list is still there after a poll cycle");
check(survived.same, "the pill is the SAME node after a repaint — it is not rebuilt under the thumb");
check(survived.repainted, "because it lives outside the list the poll wipes");

// ---- 3. Scroll relief: nothing is permanently occluded -----------------------------------------
const relief = async () => p.evaluate(async () => {
  scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 250));
  const cards = [...document.querySelectorAll(".sess")];
  const last = cards[cards.length - 1].getBoundingClientRect();
  const fe = document.getElementById("newfab"); if (!fe) return { clear: -1e4, atBottom: true };
  const f = fe.getBoundingClientRect();
  return { clear: f.top - last.bottom, atBottom: Math.abs(scrollY + innerHeight - document.body.scrollHeight) < 2 };
});
const rel = await relief();
check(rel.atBottom, "the list really did scroll to its end");
// --sp-4 of reserved gutter plus the card's own 10px margin, which its rect does not include.
check(rel.clear >= 15, `at full scroll the last card clears the pill (${rel.clear.toFixed(2)}px)`);
// Control: take the reserved padding away and the last card must be caught under the pill.
await p.evaluate(() => document.getElementById("tab-sessions").style.paddingBottom = "12px");
const noRelief = await relief();
check(noRelief.clear < 0, `control: without the reserved padding the pill covers the last card (${noRelief.clear.toFixed(2)}px)`);
await p.evaluate(() => document.getElementById("tab-sessions").style.paddingBottom = "");

// The pill belongs to this screen only.
await p.evaluate(() => showTab("settings"));
await p.waitForTimeout(400);
check(await p.evaluate(() => { const f = document.getElementById("newfab"); return !!f && getComputedStyle(f).display === "none"; }),
  "it is gone on another tab");
await p.evaluate(() => showTab("sessions"));
await p.waitForTimeout(500);
check(await p.evaluate(() => { const f = document.getElementById("newfab"); return !!f && getComputedStyle(f).display !== "none"; }),
  "and back when the Sessions tab is");

// The safe area is declared, not assumed: headless has no inset to measure, so the claim is that the
// two bottom-anchored lengths ASK for one.
const declares = await p.evaluate(() => {
  const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText); } catch { return []; } });
  const f = css.find(r => r.startsWith(".newfab ")) || "";
  const t = css.find(r => r.startsWith("#tab-sessions")) || "";
  return { fab: f.includes("safe-area-inset-bottom"), tab: t.includes("safe-area-inset-bottom") };
});
check(declares.fab, "the pill's bottom clears the safe-area inset");
check(declares.tab, "so does the list's reserved padding");

// ---- 4. Contents unchanged (a guard: it passes on BOTH pages, and that is the claim) -----------
const textOf = pg => pg.evaluate(() =>
  [...document.querySelectorAll(".sess")].map(c => c.textContent.replace(/\s+/g, " ").trim()));
const p0 = await open(BASE);
const [before, after] = [await textOf(p0), await textOf(p)];
check(before.length === after.length && before.length === SESSIONS.length,
  `both pages render ${SESSIONS.length} cards (${before.length} / ${after.length})`);
const diff = before.map((t, i) => t === after[i] ? null : `#${i}\n  HEAD: ${t}\n  now : ${after[i]}`).filter(Boolean);
check(diff.length === 0, "every card's text is byte-identical to HEAD's — shape only" + (diff.length ? "\n" + diff.join("\n") : ""));

// ---- 5. Shots, if asked: the same fixture on both pages, both themes -----------------------------
// `node sessions.mjs <page> <outdir>` — the owner compares these against his reference.
const OUT = process.argv[3];
if (OUT) {
  const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000",
    "hint-color": "#707579", "link-color": "#2481cc", "button-color": "#2481cc", "button-text-color": "#ffffff" };
  mkdirSync(OUT, { recursive: true });
  for (const [label, path] of [["before", BASE], ["after", PAGE]]) {
    for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
      const s = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
      s.on("pageerror", () => {});
      await s.goto("file://" + path, { waitUntil: "domcontentloaded" });
      // The page pins --bg off the client's header colour and only re-reads it on themeChanged, so a
      // fixture that sets the variables alone leaves a dark-pinned page under light type.
      if (vars) await s.evaluate(v => { for (const [k, val] of Object.entries(v))
        document.documentElement.style.setProperty("--tg-theme-" + k, val); pinChromeColour(); }, vars);
      await s.evaluate(list => {
        window.api = async u => u.includes("/api/sessions") ? { sessions: list } : { accounts: [], jobs: [], settings: [], write: false };
        showTab("sessions");
      }, SESSIONS);
      await s.waitForTimeout(900);
      await s.screenshot({ path: join(OUT, `sessions-${label}-${theme}.png`) });
      // The end of the list too, where the reserved padding is the whole claim: whether the pill can
      // ever sit on top of the last card is not visible from the top of the page.
      if (label === "after") {
        await s.evaluate(() => scrollTo(0, document.body.scrollHeight));
        await s.waitForTimeout(400);
        await s.screenshot({ path: join(OUT, `sessions-${label}-${theme}-bottom.png`) });
      }
      await s.close();
    }
  }
  console.log(`\nshots → ${OUT}`);
}

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
