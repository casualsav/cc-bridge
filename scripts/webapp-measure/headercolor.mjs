import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// The page OWNS its dark ground and tells Telegram to paint its chrome the same, and that ground has
// to reach EVERYTHING.
//
// The owner's requirement was "uniform throughout all the places where there are gradients and
// everything", so that is what this measures: every veil, scrim and fill in the file is a color-mix
// of --bg, and the check is that each one moves with it. Reading the stylesheet cannot answer this —
// a literal left behind in one gradient looks identical to a variable until the variable changes.
//
// 2026-08-11 INVERTED: the ground used to be a hex sampled off his screenshots because themeParams
// could not be asked for the chrome's colour. It is PAGE_DARK now, and the chrome is SET from it —
// so this file also measures the outbound half, with a recording stub in place of the SDK. Nothing
// else can see that call: a headless page has no client to paint a bar.
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
      // The TRAILING assistant row is load-bearing: the last reply is exempt from the fold (the
      // owner's 2026-07-29 ruling), so without a later reply the long message above never clips and
      // `.msg.assistant.clip` does not exist — which is how this file spent two weeks throwing on a
      // null element instead of measuring the fold's veil.
      ? { ...S, items: [{ role: "assistant", text: "x ".repeat(500), ts: 1785200000000 }, { role: "user", text: "hi", ts: 1785200000000 }, { role: "agent", text: "report", agent: "coder", status: "completed", ts: 1785200000000 }, { role: "assistant", text: "and that is the answer.", ts: 1785200000000 }] }
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
      // backgroundIMAGE: the strip is a gradient (5 stops of --bg from 0% to 22%), so its
      // backgroundColor is transparent and reading that measured nothing for as long as it has been one.
      strip: cs(document.querySelector(".composer"), "::before").backgroundImage,
      pill: cs(document.querySelector(".work")).backgroundColor,
      fold: cs(document.querySelector(".msg.assistant.clip"), "::after").backgroundImage,
      sec: cs(document.documentElement).getPropertyValue("--sec").trim(),
      card: cs(document.querySelector(".msg.agent")).backgroundColor,
    };
  });
  await p.close();
  return out;
}

// ---- the PIN: a dark theme lands on the sampled hex, whatever the client reported ---------------
// A dark theme lands on PAGE_DARK whatever the client reported: header_bg_color is not the chrome's
// colour (it reported #252D3A on the owner's client while the bar measured #1D2733), and the page no
// longer tries to match a value it cannot read. Both frames below inject a DARK theme.
const CHROME = [13, 17, 23];   // PAGE_DARK
const plain = await open(null);
check(near(rgb(plain.body), CHROME), `a dark theme lands on the page's own ground with no header param at all (${plain.body})`);

// ---- with it, every derived surface follows -----------------------------------------------------
const themed = await open(HEADER);
const want = CHROME;
console.log(`   --bg ${themed.bg} · body ${themed.body} · strip ${themed.strip} · pill ${themed.pill}`);
check(near(rgb(themed.body), CHROME), `…and with one, which the client reported wrong (${themed.body} against its ${HEADER})`);
// A color-mix renders as `color(srgb …)` with 0-1 channels — scaled here, never compared raw, which
// is halo.py's lesson about the same syntax.
const mix = s => { const n = (s.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/) || []).slice(1).map(Number); return n.length === 3 ? n.map(v => Math.round(v * 255)) : rgb(s) };
// Every stop of the strip is --bg at some alpha, so its FIRST is 0% — i.e. transparent black, which
// is a different triple from the ground and would report a strip that stopped following.
const mixLast = s => mix("color(srgb " + (s.match(/color\(srgb ([\d.]+ [\d.]+ [\d.]+)/g) || []).slice(-1)[0]?.replace("color(srgb ", ""));
check(near(mixLast(themed.strip), want, 3), `the composer strip's veil is mixed from it (${themed.strip.slice(0, 60)}…)`);
check(near(mix(themed.pill), want, 3), `the working pill's fill is mixed from it (${themed.pill})`);
check(themed.ceiling.includes("13, 17, 23") || near(mix(themed.ceiling), want, 3), `the ceiling scrim's ramp is mixed from it (${themed.ceiling.slice(0, 60)}…)`);
check(themed.fold.includes("13, 17, 23") || near(mix(themed.fold), want, 3), `the collapsed-message fold fades to it (${themed.fold.slice(0, 60)}…)`);

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
check(near(rgb(lightBg), [255, 255, 255]), `a LIGHT theme keeps its own ground — PAGE_DARK is a dark-theme answer (${lightBg})`);

// ---- the OUTBOUND half: the client is TOLD, in both themes ---------------------------------------
// A headless page has no Telegram to paint a bar, so the only measurable claim is the call itself —
// recorded by a stub SDK installed BEFORE the page's script, since `const tg` binds at parse time and
// a stub added afterwards would be read by nothing. The version gate is exercised too: below 6.9 the
// client refuses a hex, so an old client must be left with its own bar rather than a silent no-op we
// report as success.
async function told(theme, version) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  // The REAL SDK must not load: it assigns window.Telegram itself and would replace the stub, whose
  // recording is the only evidence there is here. (It cost a debugging round — with network up, every
  // recorded list came back empty and the page looked like it was calling nothing.)
  await p.route("**/telegram-web-app.js", r => r.abort());
  await p.addInitScript(v => {
    const noop = () => {};
    window.__told = [];
    window.Telegram = { WebApp: {
      initData: "", initDataUnsafe: {}, colorScheme: "dark", isFullscreen: false,
      safeAreaInset: { top: 0 }, contentSafeAreaInset: { top: 0 },
      ready: noop, expand: noop, onEvent: noop, openLink: noop, downloadFile: noop,
      showConfirm: noop, showPopup: noop,
      BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
      SettingsButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
      isVersionAtLeast: want => parseFloat(v) >= parseFloat(want),
      setHeaderColor: c => window.__told.push(["header", c]),
      setBackgroundColor: c => window.__told.push(["background", c]),
    } };
  }, version);
  await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
  const out = await p.evaluate(t => {
    window.__told = [];
    for (const [k, val] of Object.entries(t)) document.documentElement.style.setProperty("--tg-theme-" + k, val);
    pinChromeColour();
    return { told: window.__told, bg: getComputedStyle(document.body).backgroundColor };
  }, theme);
  await p.close();
  return out;
}
const DARK = { "bg-color": "#212d3b", "secondary-bg-color": "#232e3c", "text-color": "#ffffff" };
const LIGHT = { "bg-color": "#ffffff", "secondary-bg-color": "#f1f1f1", "text-color": "#000000" };
const darkTold = await told(DARK, "7.0");
const told2s = t => JSON.stringify(t.map(([k, c]) => [k, c.toLowerCase()]));   // the client is case-blind; the assertion is too
check(told2s(darkTold.told) === JSON.stringify([["header", "#0d1117"], ["background", "#0d1117"]]),
  `a dark theme tells the client BOTH surfaces, at the page's own ground (${JSON.stringify(darkTold.told)})`);
const lightTold = await told(LIGHT, "7.0");
check(told2s(lightTold.told) === JSON.stringify([["header", "#ffffff"], ["background", "#ffffff"]]),
  `a light theme tells it the theme's OWN ground, unaltered (${JSON.stringify(lightTold.told)})`);
const oldTold = await told(DARK, "6.1");
check(told2s(oldTold.told) === JSON.stringify([["background", "#0d1117"]]),
  `below 6.9 the header is left alone — a hex there is refused by the client (${JSON.stringify(oldTold.told)})`);

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
}, [CHAT, "rgb(13, 17, 23)"]);
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
