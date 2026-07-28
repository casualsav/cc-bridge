import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The dock is a SCRIM, and the working line sits close over the field.
//
// Three claims, and the third is the one that keeps the first two from fighting:
//   1. over the page — which is what is behind the strip nearly all the time — the scrim is
//      INVISIBLE. Its fill is --bg's own colour, so this is true by construction and is checked
//      anyway, because "true by construction" is how a grey bar ships.
//   2. a message passing under the strip is SHADED, not erased: it keeps roughly two thirds of its
//      own excursion above the page colour, so it still reads as a bubble moving under glass.
//   3. the WORKING LINE's own band is unchanged. The dock lays down 45% and `.work::before` 60%,
//      which composite to the 78% that line was accepted at. Raise one without lowering the other
//      and the band behind the status line darkens into a stripe — so this measures the line's
//      contrast over a bright bubble and requires the number the single scrim used to give.
// Plus the geometry the owner asked for: the row's box sits 6px above the capsule, not 10.
//
//   node dockscrim.mjs [page] [outdir]
//
// Pre-change control: node dockscrim.mjs /path/to/old.html — claims 2 and the geometry must FAIL
// there (no dock scrim at all, and a 10px gap), while 1 and 3 pass on both. That split is the point:
// the change had to ADD shading to the strip without moving the line's own ground.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = process.argv[3] || mkdtempSync(join(tmpdir(), "dockscrim-"));

const ts = 1785200000000;
const SESSION = { sid: "abc", name: "cc", alive: true, working: true, cwd: "~/p", model: "Opus 5", effort: "high",
  status: { verb: "Incubating", elapsed: "2m 11s", tokens: "4.7k tokens" } };
const EMPTY = { ...SESSION, items: [{ role: "user", text: "hi", ts }] };
const LONG = { ...SESSION, items: Array.from({ length: 16 }, (_, i) => ({
  role: "user", text: `Message ${i + 1}. ` + "Long enough that the transcript overflows several times over. ".repeat(2), ts })) };

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b) };
const ratio = (a, c) => { const [x, y] = [lum(a), lum(c)].sort((p, q) => q - p); return (x + .05) / (y + .05) };

const b = await chromium.launch();

// One page per state. `killScrim` renders the same frame with the dock's veil gone, which is what
// turns "the strip is dark" into "the strip is dark BECAUSE of the scrim" — and gives claim 2 its
// undimmed reference from the same pixels rather than from a second fixture.
async function frame(feed, { killScrim = false, parkBubble = false, name }) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (killScrim) await p.addStyleTag({ content: "#ddock::before{display:none!important}" });
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed, session: SESSION });
  await p.waitForTimeout(900);   // README rule 2
  const geo = await p.evaluate(park => {
    const dock = document.getElementById("ddock"), row = document.querySelector(".work");
    const wrap = document.querySelector(".inputwrap"), feed = document.getElementById("dfeed");
    if (park) {
      // A bubble's BODY behind the row, not the 16px margin between two of them — the single-point
      // probe that lands in a gap is bleed.mjs's lesson, and it reads as "no shading" here.
      const msgs = [...feed.querySelectorAll(".msg")];
      feed.scrollTop += msgs[msgs.length - 3].getBoundingClientRect().top - row.getBoundingClientRect().top + 6;
    }
    const rgb = s => s.match(/\d+/g).slice(0, 3).map(Number);
    const r = row ? row.getBoundingClientRect() : null;
    return {
      row: r && { top: r.top, bottom: r.bottom, h: r.height },
      wrapTop: wrap.getBoundingClientRect().top,
      dockTop: dock.getBoundingClientRect().top,
      hint: rgb(getComputedStyle(row || document.body).color),
      bg: rgb(getComputedStyle(document.getElementById("drill")).backgroundColor),
    };
  }, parkBubble);
  await p.waitForTimeout(250);
  // Sampled to the RIGHT of the row's own text: the glyphs legitimately differ between builds
  // (a translucent layer flips them from subpixel to grayscale AA), the ground is what carries this.
  const clip = { x: 260, y: Math.round(geo.row ? geo.row.top : geo.dockTop), width: 100, height: Math.round(geo.row ? geo.row.h : 24) };
  const buf = await p.screenshot({ clip });
  if (name) writeFileSync(join(OUT, name + ".png"), buf);
  const ground = await p.evaluate(async src => {
    const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + src });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    const d = c.getContext("2d").getImageData(0, 0, img.width, img.height).data;
    const ch = k => { const v = []; for (let i = 0; i < d.length; i += 4) v.push(d[i + k]); return v.sort((a, b2) => a - b2)[v.length >> 1] };
    return [ch(0), ch(1), ch(2)];
  }, buf.toString("base64"));
  await p.close();
  return { ...geo, ground };
}

// ---- 1. invisible over the page ----------------------------------------------------------------
const bare = await frame(EMPTY, { name: "empty-with" });
const bareOff = await frame(EMPTY, { killScrim: true, name: "empty-without" });
const drift = Math.max(...[0, 1, 2].map(i => Math.abs(bare.ground[i] - bareOff.ground[i])));
check(drift <= 3, `with nothing behind it the dock's scrim is invisible (worst channel drift ${drift}/255 against the same frame with it killed)`);

// ---- 2. a message under it is shaded, not erased ------------------------------------------------
const over = await frame(LONG, { parkBubble: true, name: "message-with" });
const overOff = await frame(LONG, { parkBubble: true, killScrim: true, name: "message-without" });
const retained = (lum(over.ground) - lum(over.bg)) / (lum(overOff.ground) - lum(overOff.bg));
console.log(`   ground with ${JSON.stringify(over.ground)} · without ${JSON.stringify(overOff.ground)} · page ${JSON.stringify(over.bg)}`);
check(retained < 0.85, `a message passing under the strip is SHADED (${(100 - retained * 100).toFixed(0)}% of its excursion taken)`);
check(retained > 0.45, `…and not erased — it still reads as a bubble under glass (${(retained * 100).toFixed(0)}% kept)`);

// ---- 3. the working line's own band is where it was ---------------------------------------------
// 2.75:1 is what the pre-change page gives this line over the same bright bubble, measured by THIS
// script on that page rather than reasoned from the percentages — which is how the number in the
// first draft came out wrong (it was read off a probe that had killed `.work::before` instead of
// splitting it). It is a low figure on purpose: a --hint status line over a blue bubble is never
// going to be body text. The claim is that the split did not move it.
const lineContrast = ratio(over.hint, over.ground);
check(Math.abs(lineContrast - 2.75) < 0.12, `the working line's ground is unchanged by the split — ${lineContrast.toFixed(2)}:1 over a bright bubble, against the pre-change page's 2.75`);

// ---- geometry: the row sits close over the field -------------------------------------------------
// The row's RECT already includes its own 2px padding-bottom, so this gap is the composer's
// padding-top alone: 4, down from 8. Ink to capsule is those two together — 6px, down from 10.
const gap = over.wrapTop - over.row.bottom;
check(Math.abs(gap - 4) <= 0.5, `the working row's box sits ${gap.toFixed(1)}px above the capsule, its ink ${(gap + 2).toFixed(1)}px (4/6, down from 8/10)`);

await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
