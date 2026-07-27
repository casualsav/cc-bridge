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
    drillPadTop: cs(drill).paddingTop,
    wrapBg: cs(wrap).backgroundColor, wrapBlur: cs(wrap).backdropFilter,
    // The BACK CHIP, not the title. This read `.dtitle` when the title was a capsule and shared the
    // chip family's fill and frost; it is two bare lines of text now and carries neither, so reading
    // it here compared the composer's glass against `none` and failed a rule that is still true.
    // The two side chips are what remain of that family — see CLAUDE.md.
    headBlur: cs(document.getElementById("dback")).backdropFilter,
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
// message rests ~6px above whatever the dock paints first. It was 24px above an invisible box edge.
check(near(rest.bottom.ink - rest.bottom.last, 6, 2),
  `…and rests ~6px above it (${(rest.bottom.ink - rest.bottom.last).toFixed(1)}px)`);
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
    // The GAP between the back button and the name capsule — measured, not guessed, since the capsule
    // is 20% narrower than its span and the gap moved with it. Only a full-width assistant message
    // reaches this column (a user bubble is right-aligned), so the band scanned here is wide enough
    // to cross one.
    besideHead: hit((document.getElementById("dback").getBoundingClientRect().right
      + document.querySelector("#drill .dtitle").getBoundingClientRect().left) / 2,
      // The band is clamped INSIDE the header's own height. A wider scan reaches past its bottom edge
      // into the feed below, where the in-flow layout has messages too — which is how this check
      // passed on the control page while proving nothing.
      head.top + head.height / 2, head.height / 2 - 2),
    behindWrap: hit(187, wrap.top + wrap.height / 2),          // through the frosted capsule
    besideDock: hit(20, dock.top + 4),                         // the dock's top edge, above the capsule
  };
});
check(through.topStrip, "the transcript SCROLLS through the top strip — it is dissolved there by the scrim, never clipped short of it");
check(through.besideHead, "…and through the header's own band (layout, not paint — see the scrim check below)");
check(through.behindWrap, "…and behind the input capsule");
check(through.besideDock, "…and through the dock's margin, which paints nothing");

// 5. The capsule is the header's surface: translucent AND frosted.
const alpha = s => { const n = s.match(/[\d.]+/g); return n && n.length === 4 ? parseFloat(n[3]) : 1; };
check(alpha(m.wrapBg) < 1, `the input capsule is translucent (${m.wrapBg})`);
check(/blur/.test(m.wrapBlur) && m.wrapBlur === m.headBlur, `…and carries the SAME blur as the header chips (${m.wrapBlur} vs ${m.headBlur})`);
check(alpha(m.dockBg) === 0 || m.dockBg === "rgba(0, 0, 0, 0)", `the dock itself paints nothing (${m.dockBg})`);

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
  return { h, headBottom: head.bottom, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
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
check(atHeadBottom > 40 && atHeadBottom < 235,
  `it is still FADING through the header's band, neither flat nor opaque there (${atHeadBottom}/255 of the probe survives at the header's floor)`);
check(Math.max(...jumps) <= 12, `no cliff anywhere down the ramp (biggest one-pixel step ${Math.max(...jumps)}/255)`);
check(alphas[alphas.length - 1] > 245, `and it is back to nothing by its own floor (${alphas[alphas.length - 1]}/255)`);

await p.screenshot({ path: join(OUT, "bleed.png") });
await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
