import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// FULL BLEED: the transcript owns the whole screen. It scrolls up through the strip where Telegram
// paints its ✕ Close and kebab, and down behind the composer — neither is a grey band any more —
// while the two floating surfaces reserve their space as the scroller's padding instead of taking it
// out of a flex column.
//
//   node bleed.mjs [page]
//
// Control: run against a pre-change copy — the inset, the reservation and both hit tests must FAIL.
//
// Two things here are measured rather than reasoned about, both because a wrong version still looks
// plausible in the stylesheet:
//   · The RESERVATION is dynamic (--dock-h, written by a ResizeObserver). A stale or missing value
//     leaves the newest message under the composer, which is invisible in any static reading of the
//     CSS. A stray `*/` did exactly that during this change: the whole #dfeed rule was dropped, the
//     feed reverted to a static block, and every geometry claim in the file was silently false.
//   · "The transcript scrolls THROUGH the band" is a hit test, never a rect overlap: a message
//     clipped by the scroller still reports a rect inside the band, so rect maths passes on the old
//     in-flow layout and cannot fail.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "bleed-"));

const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc-bridge", alive: true, working: true, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
const FEED = { ...SESSION, status: { verb: "Incubating", elapsed: "2m 11s", tokens: "4.7k tokens" },
  items: Array.from({ length: 16 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `Message ${i + 1}. ` + "Long enough that the transcript overflows the scroller several times over. ".repeat(2),
    ts,
  })) };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const near = (a, b, tol = 0.51) => Math.abs(a - b) <= tol;

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(({ feed, session }) => {
  window.api = async path => path.includes("session/feed") ? feed
    : path.includes("sessions") ? { sessions: [session] } : {};
  openDrill(session.sid, session.name);
}, { feed: FEED, session: SESSION });
await p.waitForTimeout(1200);   // README rule 2 — and the ResizeObserver's first callback lands here

const m = await p.evaluate(() => {
  // Tolerant of a MISSING element, because the control page has no dock at all: throwing there kills
  // the run and prints no FAIL lines, which reads exactly like a clean pass. A structural absence has
  // to arrive as a failed check, not as a stack trace.
  const r = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
  const cs = el => el ? getComputedStyle(el) : new Proxy({}, { get: () => "" });
  const drill = document.getElementById("drill"), feed = document.getElementById("dfeed");
  const dock = document.getElementById("ddock"), head = document.querySelector("#drill .vhead");
  const wrap = document.querySelector(".inputwrap");
  return {
    drill: r(drill), feed: r(feed), dock: r(dock), head: r(head), wrap: r(wrap),
    feedPos: cs(feed).position,
    padTop: parseFloat(cs(feed).paddingTop), padBottom: parseFloat(cs(feed).paddingBottom),
    dockH: dock ? dock.offsetHeight : null,
    // The dock's first INK — the working row if it is up, else the staged strip, else the capsule.
    // What --dock-h is measured to, because the box's top 8px is the composer's padding and paints
    // nothing: reserving the box rests the newest message 8px higher than it looks.
    dockInkH: (() => {
      if (!dock) return null;
      const row = document.getElementById("dwork"), stage = document.getElementById("dstage");
      const ink = (row && row.offsetParent) ? row
        : (stage && stage.classList.contains("on")) ? stage
        : document.querySelector(".inputwrap");
      return Math.round(dock.getBoundingClientRect().bottom - ink.getBoundingClientRect().top);
    })(),
    dockVar: cs(document.documentElement).getPropertyValue("--dock-h").trim(),
    dockBg: cs(dock).backgroundColor,
    // The strip's SCRIM, which is a different claim from the dock's own box — read off the
    // pseudo-element, the same trap the ceiling scrim's read carries a few lines below. It lives on
    // the COMPOSER, not the dock: it starts at the capsule's top edge (the owner's ask), so the
    // working row's band and the air above it stay bare transcript.
    dockScrimBg: getComputedStyle(document.querySelector(".composer"), "::before").backgroundColor,
    dockScrimBlur: getComputedStyle(document.querySelector(".composer"), "::before").backdropFilter,
    // …and WHERE it starts, which is the whole of the correction: its top edge must be the capsule's.
    scrimTop: (() => { const c = document.querySelector(".composer").getBoundingClientRect();
      return c.top + parseFloat(getComputedStyle(document.querySelector(".composer")).paddingTop); })(),
    drillPadTop: cs(drill).paddingTop,
    wrapBg: cs(wrap).backgroundColor, wrapBlur: cs(wrap).backdropFilter,
    // The BACK CHIP, not the title. This read `.dtitle` when the title was a capsule and shared the
    // chip family's fill and frost; it is two bare lines of text now and carries neither, so reading
    // it here compared the composer's glass against `none` and failed a rule that is still true.
    // The two side chips are what remain of that family — see CLAUDE.md.
    headBlur: cs(document.querySelector("#drill .dtitle")).backdropFilter,   // the title PILL since 2026-07-30; it was the back chip, which is gone
    // getComputedStyle's SECOND argument is the pseudo-element, and the local `cs` helper drops it —
    // reading the scrim through that helper measures #drill itself and reports "none" for a gradient
    // that is painting perfectly. Called directly for exactly that reason.
    scrim: getComputedStyle(drill, "::before").backgroundImage,
    scrimH: getComputedStyle(drill, "::before").height,
  };
});

// 1. The scroller IS the screen.
check(m.feedPos === "absolute", `the feed is positioned (${m.feedPos})`);
check(!!m.feed && !!m.drill && near(m.feed.top, m.drill.top) && near(m.feed.bottom, m.drill.bottom),
  `the feed spans the whole surface (${m.feed ? m.feed.top + "–" + m.feed.bottom : "-"} vs ${m.drill.top}–${m.drill.bottom})`);
check(m.drillPadTop === "0px", `#drill no longer pads the top itself (${m.drillPadTop}) — the feed owns that strip`);

// 2. …and reserves both floating surfaces instead of losing the space from a column.
check(!!m.head && !!m.feed && m.padTop >= m.head.bottom - m.feed.top, `top padding clears the header (${m.padTop} >= ${m.head && m.feed ? (m.head.bottom - m.feed.top).toFixed(1) : "-"})`);
check(m.dockInkH != null && m.dockVar !== "" && parseFloat(m.dockVar) === m.dockInkH,
  `--dock-h is MEASURED to the dock's first ink (${m.dockVar} vs ${m.dockInkH}px ink, ${m.dockH}px box)`);
check(m.dockInkH != null && near(m.padBottom, m.dockInkH - 10),
  `bottom padding reserves the ink less the rest gap (${m.padBottom} vs ${m.dockInkH - 10})`);

// 3. Nothing occluded at rest, at either end.
const rest = await p.evaluate(async () => {
  const f = document.getElementById("dfeed");
  f.scrollTop = f.scrollHeight;
  await new Promise(r => requestAnimationFrame(r));
  const msgs = [...f.querySelectorAll(".msg")];
  const dockEl = document.getElementById("ddock") || document.querySelector(".composer");
  const row = document.getElementById("dwork"), stage = document.getElementById("dstage");
  const inkEl = (row && row.offsetParent) ? row
    : (stage && stage.classList.contains("on")) ? stage
    : (document.querySelector(".inputwrap") || dockEl);
  const bottom = { last: msgs[msgs.length - 1].getBoundingClientRect().bottom,
    dock: dockEl.getBoundingClientRect().top, ink: inkEl.getBoundingClientRect().top };
  f.scrollTop = 0;
  await new Promise(r => requestAnimationFrame(r));
  const top = { first: msgs[0].getBoundingClientRect().top, head: document.querySelector("#drill .vhead").getBoundingClientRect().bottom };
  return { bottom, top };
});
check(rest.bottom.last <= rest.bottom.ink + 0.5, `scrolled to the floor, the newest message clears the dock's ink (${rest.bottom.last.toFixed(1)} vs ${rest.bottom.ink.toFixed(1)})`);
// The owner's resting position, measured off two screenshots of the same transcript: the newest
// message rested ~6px above whatever the dock paints first (it was 24px above an invisible box edge).
// NOW 10, and the change is his: the 6 was the clearance a REPLY got, while a user bubble — every
// freshly sent message — carried 8px of margin against the same -10 reservation and landed 2px UNDER
// the working pill. The floor gutter is pinned at 20 rather than per-role (see #dfeed > .msg:last-
// child), which fixes the bubble and moves this number with it; he asked for the extra air.
check(near(rest.bottom.ink - rest.bottom.last, 10, 2),
  `…and rests ~10px above it (${(rest.bottom.ink - rest.bottom.last).toFixed(1)}px)`);
check(rest.top.first >= rest.top.head - 0.5, `scrolled to the top, the first message clears the header (${rest.top.first.toFixed(1)} vs ${rest.top.head.toFixed(1)})`);

// 4. …but everything scrolls THROUGH both bands. Hit-tested, not rect maths.
await p.evaluate(() => { const f = document.getElementById("dfeed"); f.scrollTop = Math.round(f.scrollHeight / 2); });
await p.waitForTimeout(300);
const through = await p.evaluate(() => {
  // Scans a BAND rather than probing one pixel: the 16px margin between two messages belongs to no
  // element, so a single-point probe lands in a gap and reports "nothing is scrolling here" about a
  // transcript that plainly is. The claim is "message ink passes through this band", so the band is
  // what gets sampled.
  const hit = (x, y, span = 14) => {
    for (let dy = -span; dy <= span; dy += 2) {
      if (document.elementsFromPoint(x, y + dy).some(e => e.closest && e.closest("#dfeed .msg"))) return true;
    }
    return false;
  };
  const head = document.querySelector("#drill .vhead").getBoundingClientRect();
  const dock = (document.getElementById("ddock") || document.querySelector(".composer")).getBoundingClientRect();
  const wrap = document.querySelector(".inputwrap").getBoundingClientRect();
  return {
    topStrip: hit(187, Math.max(2, head.top / 2)),            // above the header — Telegram's own chrome band
    // BESIDE the pill, halfway between the row's left edge and the pill itself — the strip the back
    // chip used to occupy, empty since 2026-07-30. Measured rather than guessed, since the pill is
    // shrink-wrapped and that strip moves with the name's width. Only a full-width assistant message
    // reaches this column (a user bubble is right-aligned), so the band scanned here is wide enough
    // to cross one.
    besideHead: hit((head.left
      + document.querySelector("#drill .dtitle").getBoundingClientRect().left) / 2,
      // The band is clamped INSIDE the header's own height. A wider scan reaches past its bottom edge
      // into the feed below, where the in-flow layout has messages too — which is how this check
      // passed on the control page while proving nothing.
      head.top + head.height / 2, head.height / 2 - 2),
    behindWrap: hit(187, wrap.top + wrap.height / 2),          // through the frosted capsule
    // The dock's top edge, above the capsule — sampled in TWO columns, because which role's message
    // crosses that edge depends on how tall the dock is, and a user bubble is right-aligned: at 20 it
    // is not there at all. (The two-row composer moved this band onto a bubble and the check failed
    // for a transcript that was plainly still scrolling under the dock.) The claim is ink in the
    // message column, not ink at one x; a clipped feed has none at either.
    besideDock: hit(20, dock.top + 4) || hit(187, dock.top + 4),
  };
});
check(through.topStrip, "the transcript SCROLLS through the top strip — it is dissolved there by the scrim, never clipped short of it");
check(through.besideHead, "…and through the header's own band (layout, not paint — see the scrim check below)");
check(through.behindWrap, "…and behind the input capsule");
// LAYOUT, not paint: the dock's margin now carries a scrim, so the transcript is dimmed there rather
// than untouched. That it is still THERE — reachable, not clipped short of the strip — is what this
// hit test says, and how much of it survives is dockscrim.mjs's job.
check(through.besideDock, "…and through the dock's margin, where the dock's scrim dissolves it rather than clipping it");

// 5. The capsule is the header's surface: translucent AND frosted.
const alpha = s => { const n = s.match(/[\d.]+/g); return n && n.length === 4 ? parseFloat(n[3]) : 1; };
check(alpha(m.wrapBg) < 1, `the input capsule is translucent (${m.wrapBg})`);
check(/blur/.test(m.wrapBlur) && m.wrapBlur === m.headBlur, `…and carries the SAME blur as the header's title pill (${m.wrapBlur} vs ${m.headBlur})`);
// The dock's own BOX still carries no fill, and that is not pedantry: the scrim has to sit on the
// ::before or it tints the working row, the capsule and their text instead of the backdrop behind
// them. What the box must not have and what the scrim must have are two halves of one claim, so
// neither is checked alone — the old single check read only the box and could not see a scrim at all.
check(alpha(m.dockBg) === 0 || m.dockBg === "rgba(0, 0, 0, 0)", `the dock's own box paints nothing (${m.dockBg})`);
check(alpha(m.dockScrimBg) > 0 && alpha(m.dockScrimBg) < 1, `…and its SCRIM is translucent, on the pseudo-element (${m.dockScrimBg})`);
// INVERTED, and it is the point rather than an omission: this strip must NOT frost. The owner asked
// for message text to stay readable as it passes under the composer, and a blur is precisely what
// takes that away — it went out with one for a release. Everything else in the file that carries
// --chip-glass has its own text to win over what passes behind it; this surface has none.
check(!/blur/.test(m.dockScrimBlur), `…and does NOT frost — text under it stays readable (${m.dockScrimBlur})`);
check(!!m.wrap && Math.abs(m.scrimTop - m.wrap.top) <= 0.5, `…and it starts at the capsule's own top edge, not the dock's (${m.scrimTop.toFixed(1)} vs ${m.wrap ? m.wrap.top.toFixed(1) : "-"})`);

// 6. The ceiling scrim. It dissolves the transcript on its way up so a line of text never slides
//    under Telegram's own buttons.
//
//    This check USED to be `scrim height === the header's bottom`, written to lock out a shape that
//    had been tried and rejected: the ramp finished ABOVE the chips, which makes them hold their
//    colour perfectly and paints a bar across the band the transcript had just been given. That
//    remains rejected. But the equality could not tell it apart from the OPPOSITE change — a longer
//    tail below the header, which fades through the band exactly as before and only spends the extra
//    length landing softly. Both move the element's height; only one of them empties the band. So the
//    height equality is retired in favour of measuring what actually mattered all along: the rendered
//    alpha PROFILE down the strip. Sampled over the page's own ground, which is the one backdrop
//    whose answer is known.
//
//    Three claims, and the rejected shape fails the first two:
//      - it is still FADING through the header's band (not flat, not opaque there),
//      - it has no CLIFF — no single pixel step big enough to read as an edge,
//      - it is back to nothing by its own floor.
const prof = await p.evaluate(() => {
  const drill = document.getElementById("drill");
  const h = Math.round(parseFloat(getComputedStyle(drill, "::before").height));
  const head = document.querySelector("#drill .vhead").getBoundingClientRect();
  // A white probe UNDER the scrim, read through it: the scrim's own computed style is a gradient
  // string, and parsing one tells you what was declared rather than what is painted. It has to be a
  // child of #drill at z-index 0 — inside the scrim's own context, above the feed (also 0, earlier
  // sibling) and below the scrim (1). Appending it to <body> instead puts it outside #drill's
  // stacking context entirely, where the scrim never reaches it and the profile reads flat.
  const probe = document.createElement("div");
  probe.id = "scrimprobe";
  probe.style.cssText = "position:absolute;left:0;right:0;top:0;height:" + h + "px;background:#fff;z-index:0";
  drill.appendChild(probe);
  const r = probe.getBoundingClientRect();
  // Where the solid part ends, read from the SAME custom property the gradient's stops are built on,
  // so this cannot drift from the CSS the way a restated pixel figure would.
  const solid = parseFloat(getComputedStyle(drill).getPropertyValue("--scrim-solid-px") || "0")
    || (() => { const d = document.createElement("div");
      d.style.cssText = "position:absolute;height:var(--scrim-solid);visibility:hidden"; drill.appendChild(d);
      const v = d.getBoundingClientRect().height; d.remove(); return v; })();
  return { h, solid, headBottom: head.bottom, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
});
const strip = await p.screenshot({ clip: prof.rect });
const { execFileSync } = await import("node:child_process");
const alphas = execFileSync("python3", ["-c", `
import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
w, h = im.size
px = im.load()
# White probe under a --bg scrim: the darker the row, the more opaque the scrim. Sample a column
# clear of the chips so only the scrim is in the way.
print(" ".join(str(px[8, y][0]) for y in range(h)))
`], { input: strip }).toString().trim().split(/\s+/).map(Number);
await p.evaluate(() => document.getElementById("scrimprobe")?.remove());
const dpr = 2, atHeadBottom = alphas[Math.min(alphas.length - 1, Math.round(prof.headBottom * dpr) - 2)];
const jumps = alphas.slice(1).map((v, i) => Math.abs(v - alphas[i]));
check(!!m.scrim && /gradient/.test(m.scrim), `the top scrim is a gradient (${String(m.scrim).slice(0, 40)}…)`);
// RE-AIMED, and by an explicit instruction rather than by a shift in taste. This asserted that the
// ramp was still fading THROUGH the header's band — the guard against a shape that had been tried and
// rejected for painting a bar across it. The owner then asked for the opposite ("have it start about
// the same height as one line of regular text below the cwd"), so the band is now inside the solid
// part by construction and that check could only fail. What survives it is the part that was never
// about where the solid ends: the profile must still be a RAMP — mid-way down its runway it is
// neither gone nor solid — and it must reach zero by its own floor with no cliff anywhere.
const solid = Math.round(prof.solid * dpr), rampMid = Math.min(alphas.length - 1, solid + Math.round((alphas.length - solid) / 2));
check(alphas[Math.max(0, solid - 4)] < 40, `it is at full strength where the title sits (${alphas[Math.max(0, solid - 4)]}/255 of the probe survives just above the solid part's floor)`);
check(alphas[rampMid] > 40 && alphas[rampMid] < 235,
  `…and still a RAMP below it, neither flat nor opaque half way down (${alphas[rampMid]}/255)`);
// SMOOTHNESS, scale-free — the absolute 12/255 this replaces was really measuring the ramp's
// LENGTH, and the owner has now shortened it twice ("one line of text distance beneath the name/cwd
// is all that's needed"). The same total drop over a third of the distance is three times as steep
// per pixel while being no less smooth. What a cliff actually looks like is one step far out of
// line with its neighbours, so that is what this asks: no step more than 3x the ramp's own mean.
const rampSteps = jumps.filter(j => j > 0);
const meanStep = rampSteps.reduce((a, c) => a + c, 0) / Math.max(1, rampSteps.length);
check(Math.max(...jumps) <= meanStep * 3, `no cliff anywhere down the ramp (biggest step ${Math.max(...jumps)}/255 against a ${meanStep.toFixed(1)} mean — a cliff is one step out of line, not a short ramp)`);
check(alphas[alphas.length - 1] > 245, `and it is back to nothing by its own floor (${alphas[alphas.length - 1]}/255)`);

await p.screenshot({ path: join(OUT, "bleed.png") });
await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
