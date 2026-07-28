import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// FULLSCREEN ONLY: the header rides up into Telegram's own chrome row, the pause folds inside the
// capsule, and the transcript gets the row they vacate.
//
//   node headerup.mjs [page]
//
// Driven through the REAL SDK's `Telegram.WebView.receiveEvent` — the same entry point the native
// client posts through — because `isFullscreen` and both insets are what the whole layout is gated
// on, and a stubbed flag would prove nothing about the plumbing that reads them. Needs network for
// telegram-web-app.js, exactly like fullscreen.mjs.
//
// The half this CANNOT check, and it is the important half: whether the client actually swaps its
// ✕ Close pill for a ← when BackButton.show() is called in fullscreen, and where its buttons sit
// horizontally. The API exposes insets as top/bottom/left/right only — never the chrome buttons'
// x-extents — so --chrome-l/--chrome-r are measured off a screenshot and asserted here only to be
// what the stylesheet says. Live device check required.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const NOTCH = 47, CHROME = 46;   // the same pair fullscreen.mjs drives with

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const b = await chromium.launch();

async function open(fullscreen) {
  const p = await b.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 1 });
  p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(() => {
    const S = { sid: "abc", name: "cc-bridge", alive: true, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
    window.api = async path => path.includes("session/feed")
      ? { ...S, items: Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
          text: `Message ${i + 1}. ` + "Long enough to overflow the scroller a few times. ".repeat(2), ts: 1785200000000 })) }
      : path.includes("sessions") ? { sessions: [S] } : {};
  });
  await p.waitForTimeout(500);
  if (fullscreen) {
    await p.evaluate(([notch, chrome]) => {
      const R = window.Telegram.WebView.receiveEvent.bind(window.Telegram.WebView);
      R("safe_area_changed", { top: notch, bottom: 34, left: 0, right: 0 });
      R("content_safe_area_changed", { top: chrome, bottom: 0, left: 0, right: 0 });
      R("fullscreen_changed", { is_fullscreen: true });
    }, [NOTCH, CHROME]);
    await p.waitForTimeout(300);
  }
  await p.evaluate(() => openDrill("abc", "cc-bridge"));
  await p.waitForTimeout(900);
  return p;
}

const read = p => p.evaluate(() => {
  const r = el => el ? (({ top, bottom, left, right, width, height }) => ({ top, bottom, left, right, width, height }))(el.getBoundingClientRect()) : null;
  const q = s => document.querySelector(s);
  const stop = document.getElementById("dstop");
  return {
    fs: document.documentElement.classList.contains("fs"),
    head: r(q("#drill .vhead")), cap: r(q("#drill .dtitle")),
    back: r(document.getElementById("dback")), stop: r(stop),
    stopParent: stop && stop.parentElement.className,
    backShown: getComputedStyle(document.getElementById("dback")).display !== "none",
    feedPadTop: parseFloat(getComputedStyle(document.getElementById("dfeed")).paddingTop),
    scrimH: getComputedStyle(document.getElementById("drill"), "::before").height,
    chromeTop: getComputedStyle(document.documentElement).getPropertyValue("--chrome-top").trim(),
    chromeH: getComputedStyle(document.documentElement).getPropertyValue("--chrome-h").trim(),
    safeTop: getComputedStyle(document.documentElement).getPropertyValue("--safe-top").trim(),
    name: r(document.getElementById("dname")), sub: r(document.getElementById("dsub")),
    firstMsgTop: (() => { const f = document.getElementById("dfeed"); f.scrollTop = 0;
      const m = f.querySelector(".msg"); return m ? m.getBoundingClientRect().top : null; })(),
  };
});

// ── 1. NORMAL MODE IS UNTOUCHED. Measured first, and everything below is a delta from it.
const normal = await read(await open(false));
check(!normal.fs, "no .fs class outside fullscreen");
check(near(normal.head.top, 10), `the header still sits on its own row (top ${normal.head.top})`);
check(normal.backShown, "our back chip is still the way out");
check(normal.stopParent.includes("vhead"), `the pause is still its own chip (parent .${normal.stopParent})`);
check(normal.stop.left > normal.cap.right, "…to the RIGHT of the capsule, outside it");

// ── 2. FULLSCREEN: the header is in the client's band.
const fsPage = await open(true);
const fs = await read(fsPage);
check(fs.fs, "the .fs gate is on in fullscreen");
check(fs.chromeTop === NOTCH + "px" && fs.chromeH === CHROME + "px",
  `both inset halves are exposed separately (${fs.chromeTop} + ${fs.chromeH})`);
// Centred in the chrome band — that is what "between the two Telegram buttons" means vertically.
const bandMid = NOTCH + CHROME / 2, headMid = (fs.head.top + fs.head.bottom) / 2;
check(near(headMid, bandMid, 1.5), `the header is centred in the client's chrome row (${headMid} vs ${bandMid})`);
check(fs.head.left >= 60 && fs.head.right <= 300,
  `and inset clear of its buttons (${fs.head.left}…${fs.head.right} of 360)`);
// …with 10% of the band held back as clearance. The measured insets came off a screenshot, which
// shows the client's INK and not its touch targets, so the pill was clipping the ✕ and the kebab.
const band = fs.head.right - fs.head.left;
check(near(fs.cap.width, band * 0.9, 1.5),
  `the pill keeps 10% of the band clear of them (${fs.cap.width.toFixed(1)} of ${band.toFixed(1)})`);
check(near(fs.cap.left - fs.head.left, fs.head.right - fs.cap.right, 1),
  `…split evenly, so it stays centred (${(fs.cap.left - fs.head.left).toFixed(1)} / ${(fs.head.right - fs.cap.right).toFixed(1)})`);

// ── 3. The pause is folded IN.
check(fs.stopParent.includes("dtitle"), `the pause moved inside the capsule (parent .${fs.stopParent})`);
check(fs.stop.left > fs.cap.left && fs.stop.right <= fs.cap.right + 0.5,
  `…and is within its bounds (${fs.stop.left}…${fs.stop.right} inside ${fs.cap.left}…${fs.cap.right})`);
check(fs.name.width > 40 && fs.sub.width > 40,
  `the title column still has room (name ${fs.name.width.toFixed(0)}px, cwd ${fs.sub.width.toFixed(0)}px)`);

// ── 4. …and the row it vacated goes to the transcript. This is the whole point.
check(fs.feedPadTop < normal.feedPadTop + NOTCH + CHROME - 30,
  `the feed reclaims the header's row (top padding ${fs.feedPadTop} vs ${normal.feedPadTop} + ${NOTCH + CHROME} of chrome)`);
const reclaimed = (normal.feedPadTop + NOTCH + CHROME) - fs.feedPadTop;
check(reclaimed >= 40, `~${reclaimed.toFixed(0)}px of transcript reclaimed`);
// The scrim's SHAPE in fullscreen, measured the way bleed.mjs measures it in normal mode — through a
// white probe read beneath it — because the height equality this replaces could not tell two very
// different scrims apart. It asserted `height === the band`, which was true both when the ramp merely
// ENDED at the band's floor (the old shape: full --bg in the band's top quarter only, leaving the
// title on half-veiled transcript, which the deleted glyph stroke was covering for) and would be
// false for any shape that lands the ramp below the band, including the right one. What matters is
// the profile: solid where the title sits, still falling below it, gone by its own floor.
const alphas = await (async () => {
  const rect = await fsPage.evaluate(() => {
    const drill = document.getElementById("drill");
    const h = parseFloat(getComputedStyle(drill, "::before").height);
    // z-index 0 and a child of #drill: inside the scrim's own stacking context, above the feed and
    // below the scrim. On <body> the scrim never reaches it and the profile reads flat.
    const probe = document.createElement("div");
    probe.id = "scrimprobe";
    probe.style.cssText = "position:absolute;left:0;right:0;top:0;height:" + h + "px;background:#fff;z-index:0";
    drill.appendChild(probe);
    const r = probe.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const strip = await fsPage.screenshot({ clip: rect });
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("python3", ["-c", `
import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB")
px = im.load()
print(" ".join(str(px[8, y][0]) for y in range(im.size[1])))
`], { input: strip }).toString().trim().split(/\s+/).map(Number);
  await fsPage.evaluate(() => document.getElementById("scrimprobe")?.remove());
  return out;   // deviceScaleFactor is 1 here, so index === CSS px
})();
const atBandFloor = alphas[Math.min(alphas.length - 1, NOTCH + CHROME - 1)];
const jumps = alphas.slice(1).map((v, i) => Math.abs(v - alphas[i]));
check(parseFloat(fs.scrimH) > NOTCH + CHROME,
  `the scrim runs BELOW the band so its ramp has somewhere to land (${fs.scrimH} against ${NOTCH + CHROME}px of chrome)`);
check(atBandFloor < 60, `…and it is still at full strength where the title sits (${atBandFloor}/255 of the probe survives at the band's floor)`);
// SMOOTHNESS, scale-free — the absolute 12/255 this replaces was really measuring the ramp's
// LENGTH, and the owner has now shortened it twice ("one line of text distance beneath the name/cwd
// is all that's needed"). The same total drop over a third of the distance is three times as steep
// per pixel while being no less smooth. What a cliff actually looks like is one step far out of
// line with its neighbours, so that is what this asks: no step more than 3x the ramp's own mean.
const rampSteps = jumps.filter(j => j > 0);
const meanStep = rampSteps.reduce((a, c) => a + c, 0) / Math.max(1, rampSteps.length);
check(Math.max(...jumps) <= meanStep * 3, `no cliff anywhere down the ramp (biggest step ${Math.max(...jumps)}/255 against a ${meanStep.toFixed(1)} mean — a cliff is one step out of line, not a short ramp)`);
check(alphas[alphas.length - 1] > 245, `and it is back to nothing by its own floor (${alphas[alphas.length - 1]}/255)`);

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
