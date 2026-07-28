import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// The page takes the client's HEADER colour, and it has to reach EVERYTHING.
//
// The owner's requirement was "uniform throughout all the places where there are gradients and
// everything", so that is what this measures: every veil, scrim and fill in the file is a color-mix
// of --bg, and the check is that each one moves with it. Reading the stylesheet cannot answer this —
// a literal left behind in one gradient looks identical to a variable until the variable changes.
//
//   node headercolor.mjs [page]
//
// Two controls, because a colour test passes trivially in both directions:
//   · the LIGHT theme, which must be left entirely alone — the pin is a dark constant and applying
//     it to a light client would be a disaster rather than a mismatch;
//   · the COLLISION: --sec is every raised surface here (agent cards, dividers). It is reported
//     against the new --bg rather than asserted, because whether they are too close is the owner's
//     eye and not a threshold — but a run that flattens them should say so out loud.

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
// Deliberately not a plausible dark grey: a wrong answer has to be obvious in the printout.
const HEADER = "rgb(80, 20, 120)";
const CHAT = "rgb(33, 45, 59)";     // his client's actual bg_color, measured off the screenshot

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "OK  " : "FAIL"}  ${label}`); if (!ok) bad++; };
const rgb = s => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const near = (a, b, tol = 2) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);

const b = await chromium.launch();
async function open(headerColour) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  await p.evaluate(([chat, head]) => {
    const r = document.documentElement.style;
    r.setProperty("--tg-theme-bg-color", chat);
    if (head) r.setProperty("--tg-theme-header-bg-color", head);
  }, [CHAT, headerColour]);
  await p.evaluate(() => {
    const S = { sid: "abc", name: "cc", alive: true, working: true, cwd: "~/p", model: "Opus 5", effort: "high",
      status: { verb: "Incubating", elapsed: "2m", tokens: "4.7k tokens" } };
    window.api = async path => path.includes("session/feed")
      // A long ASSISTANT message, and both halves of that matter: the fold's veil is a ::after that
      // only exists on `.msg.clip` (a short one reads `none`), and only the unbubbled kind fades to
      // --bg — a user bubble's `--fold-to` is --btn, which is a different variable and would fail
      // this for the right reason at the wrong time. The user row after it is what keeps the
      // assistant reply from being the NEWEST one, which is never folded.
      ? { ...S, items: [{ role: "assistant", text: "x ".repeat(500), ts: 1785200000000 }, { role: "user", text: "hi", ts: 1785200000000 }, { role: "agent", text: "report", agent: "coder", status: "completed", ts: 1785200000000 }] }
      : path.includes("sessions") ? { sessions: [S] } : {};
    openDrill("abc", "cc");
  });
  await p.waitForTimeout(900);
  const out = await p.evaluate(() => {
    const cs = (el, pe) => getComputedStyle(el, pe);
    const drill = document.getElementById("drill");
    return {
      bg: cs(document.documentElement).getPropertyValue("--bg").trim(),
      body: cs(document.body).backgroundColor,
      // The three surfaces that are color-mixes of --bg, read where they are PAINTED rather than
      // where they are declared: the ceiling scrim's solid end, the composer strip's veil, the
      // working pill's fill. A literal left behind in any of them shows up here as the old colour.
      ceiling: cs(drill, "::before").backgroundImage,
      strip: cs(document.querySelector(".composer"), "::before").backgroundColor,
      pill: cs(document.querySelector(".work")).backgroundColor,
      fold: cs(document.querySelector(".msg.assistant.clip"), "::after").backgroundImage,
      chip: cs(document.getElementById("dback")).backgroundColor,
      sec: cs(document.documentElement).getPropertyValue("--sec").trim(),
      card: cs(document.querySelector(".msg.agent")).backgroundColor,
    };
  });
  await p.close();
  return out;
}

// ---- the PIN: a dark theme lands on the sampled hex, whatever the client reported ---------------
// header_bg_color is not Telegram's chrome colour — it reported #252D3A on the owner's client while
// the bar measured #1D2733 — so the page is pinned to the sampled value on any dark theme. Both
// frames below inject a DARK theme, so both must land there regardless of what they were told.
const CHROME = [29, 39, 51];
const plain = await open(null);
check(near(rgb(plain.body), CHROME), `a dark theme is pinned to the sampled chrome colour with no header param at all (${plain.body})`);

// ---- with it, every derived surface follows -----------------------------------------------------
const themed = await open(HEADER);
const want = CHROME;
console.log(`   --bg ${themed.bg} · body ${themed.body} · strip ${themed.strip} · pill ${themed.pill}`);
check(near(rgb(themed.body), CHROME), `…and with one, which the client reported wrong (${themed.body} against its ${HEADER})`);
// A color-mix renders as `color(srgb …)` with 0-1 channels — scaled here, never compared raw, which
// is halo.py's lesson about the same syntax.
const mix = s => { const n = (s.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/) || []).slice(1).map(Number); return n.length === 3 ? n.map(v => Math.round(v * 255)) : rgb(s) };
check(near(mix(themed.strip), want, 3), `the composer strip's veil is mixed from it (${themed.strip})`);
check(near(mix(themed.pill), want, 3), `the working pill's fill is mixed from it (${themed.pill})`);
check(themed.ceiling.includes("29, 39, 51") || near(mix(themed.ceiling), want, 3), `the ceiling scrim's ramp is mixed from it (${themed.ceiling.slice(0, 60)}…)`);
check(themed.fold.includes("29, 39, 51") || near(mix(themed.fold), want, 3), `the collapsed-message fold fades to it (${themed.fold.slice(0, 60)}…)`);
// The chips are 44% of --bg by design, so this asserts the PROPORTION rather than the colour: a chip
// that stopped following would read as the old page's 44%, which is a different hue entirely.
check(near(mix(themed.chip), want.map(v => Math.round(v * 0.44)), 3), `the header chips are tinted from it, at their own 44% (${themed.chip})`);

// ---- the LIGHT control: the pin must not touch it ------------------------------------------------
const light = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
await light.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await light.evaluate(() => {
  for (const [k, v] of Object.entries({ "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1",
    "text-color": "#000000", "hint-color": "#707579", "button-color": "#2481cc", "button-text-color": "#ffffff" }))
    document.documentElement.style.setProperty("--tg-theme-" + k, v);
});
await light.evaluate(() => pinChromeColour());
const lightBg = await light.evaluate(() => getComputedStyle(document.body).backgroundColor);
await light.close();
check(near(rgb(lightBg), [255, 255, 255]), `a LIGHT theme is left alone — the pin is a dark constant (${lightBg})`);

// ---- the collision report, on the REAL colours rather than the synthetic probe -------------------
// The purple above is chosen to make a wrong answer obvious; it says nothing about whether raised
// surfaces survive. This frame uses the owner's own measured pair — his client's chat colour and the
// header colour read off his screenshot — with whatever --sec falls out. It is a report, not a
// check: how close is too close is his eye, and his real secondary_bg_color is not knowable here.
const real = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
await real.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await real.evaluate(([chat, head]) => {
  document.documentElement.style.setProperty("--tg-theme-bg-color", chat);
  document.documentElement.style.setProperty("--tg-theme-header-bg-color", head);
}, [CHAT, "rgb(29, 39, 51)"]);
const rep = await real.evaluate(() => ({
  bg: getComputedStyle(document.body).backgroundColor,
  sec: getComputedStyle(document.documentElement).getPropertyValue("--sec").trim(),
  secPainted: (() => { const d = document.createElement("div");
    d.style.cssText = "background:var(--sec)"; document.body.appendChild(d);
    const v = getComputedStyle(d).backgroundColor; d.remove(); return v })(),
}));
await real.close();
const secD = Math.max(...rgb(rep.secPainted).map((v, i) => Math.abs(v - rgb(rep.bg)[i])));
console.log(`   on the owner's own pair: page ${rep.bg}, raised surfaces ${rep.secPainted} — ${secD} channel units apart` +
  (secD < 10 ? "  <-- they will read as FLAT; --sec needs a lift or this trial reverts" : ""));

await b.close();
console.log(bad ? `${bad} FAILED` : "all checks passed");
process.exit(bad ? 1 : 0);
