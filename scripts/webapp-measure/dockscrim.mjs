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
//   2. a message passing under the strip is SHADED but barely: it keeps ~78% of its own excursion
//      above the page colour and NO blur, so its text is still readable as it passes under.
//   3. the WORKING LINE has its own ground and holds it ALONE. The strip's scrim starts at the
//      capsule's top (the owner's correction), so nothing sits under the pill but transcript — this
//      measures the line's contrast over a bright bubble and, against the same frame with the pill's
//      fill removed, says it is the pill and not the strip holding it up.
// Plus the geometry the owner asked for: the pill sits 6px above the capsule, not 10.
//
//   node dockscrim.mjs [page] [outdir]
//
// Pre-change control: node dockscrim.mjs /path/to/old.html — claim 2 and the geometry must FAIL on a
// page from before the strip had a scrim at all, while claim 1 passes on both (a scrim that is not
// there is trivially invisible over the page, which is why claim 1 alone proves nothing).

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
async function frame(feed, { killScrim = false, killPill = false, parkBubble = false, name }) {   // parkBubble: false | "row" | "strip"
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  if (killScrim) await p.addStyleTag({ content: ".composer::before{display:none!important}" });
  if (killPill) await p.addStyleTag({ content: ".work{background:none!important}" });
  await p.evaluate(({ feed, session }) => {
    window.api = async path => path.includes("session/feed") ? feed : path.includes("sessions") ? { sessions: [session] } : {};
    openDrill(session.sid, session.name);
  }, { feed, session: SESSION });
  await p.waitForTimeout(900);   // README rule 2
  const geo = await p.evaluate(park => {
    const dock = document.getElementById("ddock"), row = document.querySelector(".work");
    const wrap = document.querySelector(".inputwrap"), feed = document.getElementById("dfeed");
    if (park) {
      // A bubble's BODY behind the target, not the 16px margin between two of them — the single-point
      // probe that lands in a gap is bleed.mjs's lesson, and it reads as "no shading" here.
      // `park` names WHICH surface: the pill sits above the capsule and the strip starts at it, so
      // one scroll position cannot put a message behind both. Parking on the row while measuring the
      // strip is how this reported a 0% excursion for a scrim that was working.
      const msgs = [...feed.querySelectorAll(".msg")];
      const anchor = park === "strip" ? wrap.getBoundingClientRect().bottom : row.getBoundingClientRect().top;
      feed.scrollTop += msgs[msgs.length - 3].getBoundingClientRect().top - anchor + 6;
    }
    const rgb = s => s.match(/\d+/g).slice(0, 3).map(Number);
    const r = row ? row.getBoundingClientRect() : null, w = wrap.getBoundingClientRect();
    return {
      row: r && { top: r.top, bottom: r.bottom, h: r.height, left: r.left, w: r.width },
      wrapTop: w.top,
      // The strip BELOW the capsule — the composer's own bottom padding, full width, where the veil
      // is at full strength and the transcript still passes. The claim used to be measured at the
      // working row's band, which the scrim no longer reaches: it starts at the capsule's top now.
      strip: { top: w.bottom, h: Math.max(4, dock.getBoundingClientRect().bottom - w.bottom) },
      dockTop: dock.getBoundingClientRect().top,
      hint: rgb(getComputedStyle(row || document.body).color),
      bg: rgb(getComputedStyle(document.getElementById("drill")).backgroundColor),
    };
  }, parkBubble);
  await p.waitForTimeout(250);
  // TWO grounds, because the scrim and the pill cover different pixels now and each claim belongs to
  // one of them. Both reduce by MEDIAN, so a glyph — a minority of the sample — cannot move them.
  //   pill: across the pill's interior. Two earlier framings were wrong the same way: x=260 "to the
  //     right of the text" was right while the row's shading ran the full width of the screen, and
  //     the pill's own left padding sits in the feed's LEFT GUTTER, where a right-aligned user bubble
  //     never reaches — it read flat page colour and reported a 0% excursion with a straight face.
  //   strip: the composer's bottom padding, full width, BELOW the capsule. That is where the scrim is
  //     at full strength and the transcript still passes; sampling the working row instead measures a
  //     band the scrim deliberately no longer reaches, which is exactly the 0% this reported once.
  const shoot = async (clip, tag) => {
    const buf = await p.screenshot({ clip });
    if (name) writeFileSync(join(OUT, name + "-" + tag + ".png"), buf);
    return p.evaluate(async src => {
      const img = await new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + src });
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, img.width, img.height).data;
      const ch = k => { const v = []; for (let i = 0; i < d.length; i += 4) v.push(d[i + k]); return v.sort((a, b2) => a - b2)[v.length >> 1] };
      return [ch(0), ch(1), ch(2)];
    }, buf.toString("base64"));
  };
  const ground = geo.row ? await shoot({ x: Math.round(geo.row.left) + 2, y: Math.round(geo.row.top),
    width: Math.max(8, Math.round(geo.row.w) - 4), height: Math.round(geo.row.h) }, "pill") : null;
  const strip = await shoot({ x: 0, y: Math.round(geo.strip.top), width: 375, height: Math.round(geo.strip.h) }, "strip");
  await p.close();
  return { ...geo, ground, strip };
}

// ---- 1. invisible over the page ----------------------------------------------------------------
const bare = await frame(EMPTY, { name: "empty-with" });
const bareOff = await frame(EMPTY, { killScrim: true, name: "empty-without" });
const drift = Math.max(...[0, 1, 2].map(i => Math.abs(bare.strip[i] - bareOff.strip[i])));
check(drift <= 3, `with nothing behind it the dock's scrim is invisible (worst channel drift ${drift}/255 against the same frame with it killed)`);

// ---- 2. a message under it is shaded, not erased ------------------------------------------------
const over = await frame(LONG, { parkBubble: "strip", name: "message-with" });
const overOff = await frame(LONG, { parkBubble: "strip", killScrim: true, name: "message-without" });
// Per CHANNEL, not by luminance: this is asking what fraction of the composite survived, and the
// compositing happens in sRGB values. A luminance ratio puts gamma in the middle of it and reported
// 37% for a scrim that is 45% by construction and measures 55% in the numbers CSS actually mixed.
const retained = [0, 1, 2].reduce((a, i) => a + (over.strip[i] - over.bg[i]) / (overOff.strip[i] - overOff.bg[i]), 0) / 3;
console.log(`   strip with ${JSON.stringify(over.strip)} · without ${JSON.stringify(overOff.strip)} · page ${JSON.stringify(over.bg)}`);
check(retained < 0.9, `a message passing under the strip is SHADED (${(100 - retained * 100).toFixed(0)}% of its excursion taken)`);
// The floor is the owner's own calibration — "super subtle, barely noticeable, and text should still
// be readable as it passes under". 45% with a frost on it failed that in both halves; the frost is
// what made the text unreadable, so its absence is checked too, one line down.
check(retained > 0.7, `…and barely so — the message keeps ${(retained * 100).toFixed(0)}% of its own colour and stays readable`);

// ---- 3. the working line's own band is where it was ---------------------------------------------
// The pill's own contribution, measured against the SAME frame with its fill removed rather than
// against a number from a previous version. That cross-version constant (2.75, then 2.74) had to go
// when the shading became a pill: the sample region moved with it, so the two numbers stopped being
// about the same pixels — and a stale constant fails a correct page, which is how this was found.
// The floor is what the owner accepted the full-width band at; the delta is what says the pill and
// not the dock's strip is holding this line up.
const onRow = await frame(LONG, { parkBubble: "row", name: "message-row" });
const noPill = await frame(LONG, { parkBubble: "row", killPill: true, name: "message-nopill" });
const lineContrast = ratio(onRow.hint, onRow.ground), bareContrast = ratio(noPill.hint, noPill.ground);
check(lineContrast > 2.7, `the working line keeps its ground over a bright bubble (${lineContrast.toFixed(2)}:1)`);
check(lineContrast - bareContrast > 0.25, `…and it is the PILL holding it there, not the strip alone (${lineContrast.toFixed(2)} against ${bareContrast.toFixed(2)} with the pill's fill removed)`);

// ---- geometry: the row sits close over the field -------------------------------------------------
// The PILL's edge to the capsule, which is the distance the eye reads now that the row has a visible
// boundary of its own: the host's 2px plus the composer's 4px padding-top. It was 10px of ink-to-
// capsule before both changes, and the ink now sits 3px further in behind the pill's own padding.
const gap = over.wrapTop - over.row.bottom;
check(Math.abs(gap - 6) <= 0.5, `the working pill sits ${gap.toFixed(1)}px above the capsule (6, down from 10 of bare ink)`);

await b.close();
console.log(`\nshots: ${OUT}`);
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
