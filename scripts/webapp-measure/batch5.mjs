import { chromium } from "/home/ubuntu/projects/taste/node_modules/playwright/index.mjs";
// The five-item batch of 2026-07-27, measured in one pass because four of the five touch the same
// screen and a shot of one is a shot of the others.
//
//   1  the paperclip opens a Photos / Files sheet instead of a picker
//   2  the composer tells the IME not to draw inline predictions
//   3  a single staged file says "1 attachment", not its filename
//   4  a slash command paints no optimistic bubble, and /clear paints no row at all
//   5  the chat title loses its capsule and keeps its legibility
//
// Run it TWICE — once on the shipped page, once on a pre-change copy:
//
//   node batch5.mjs                                  # the working tree
//   node batch5.mjs /path/to/before.html out-before  # the control: every item check must FAIL
//
// Item 5's contrast claim is finished by halo.py, which reads the shots this writes. The pixels are
// the claim; the CSS is not. Item 2 is the one item nothing here can close — see its section.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const PAGE = process.argv[2] || join(REPO, "webapp", "index.html");
const OUT = join(REPO, "scripts", "webapp-measure", process.argv[3] || "batch5");
mkdirSync(OUT, { recursive: true });

const PNG8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAG0lEQVR4nGNgYGD4z0AswKqQWMUM" +
  "o1YMKysAAP//NxUFvzs1LcYAAAAASUVORK5CYII=", "base64");
const PHOTO = join(mkdtempSync(join(tmpdir(), "b5-")), "Screenshot_20260727-124620_Telegram~2.png");
const PHOTO2 = join(mkdtempSync(join(tmpdir(), "b5b-")), "second.png");
writeFileSync(PHOTO, PNG8); writeFileSync(PHOTO2, PNG8);

const ts = 1785200000000;
const S = { sid: "abc", name: "Cc-bridge", alive: true, working: false, cwd: "~/projects/cc-bridge", model: "Opus 5", effort: "high" };
// A long transcript of USER bubbles, because item 5's worst case is the title over a bright fill and
// the user bubble is the only bright fill this app has.
const CHAT = Array.from({ length: 18 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user", uuid: `m${i}`, ts: ts + i * 1000,
  text: i % 2 ? "Reading the relevant sections and reporting back on what the parser does with it."
    : "Only shift the ones that are already high, and keep the rest where they are for now.",
}));
const F = { ...S, items: CHAT };

let bad = 0;
const check = (ok, l) => { console.log(`${ok ? "OK  " : "FAIL"}  ${l}`); if (!ok) bad++; };
const note = l => console.log(`  ..  ${l}`);
const click = async sel => { try { await p.click(sel, { timeout: 1500 }); return true; }
  catch { check(false, `could not click ${sel} — it is not there`); return false; } };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
p.on("pageerror", e => { console.log("PAGEERROR:", e.message); bad++; });
await p.goto("file://" + PAGE, { waitUntil: "domcontentloaded" });
await p.evaluate(({ feed, session }) => {
  // Every input.click() the page makes, recorded. "Tapping the paperclip no longer opens a picker"
  // is otherwise unmeasurable: a file dialog in headless Chromium is a silent no-op, so a page that
  // still fires one looks exactly like a page that does not.
  window.__picks = [];
  const realClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { window.__picks.push(this.id); return realClick.call(this); };
  window.__uploads = [];
  // Mutable, because item 4 has to serve a DIFFERENT feed part-way through — the one the daemon
  // returns for a cleared session. A captured constant here is re-served by the 3s poll a moment
  // later and overwrites whatever the check just set up, which is a check that cannot pass.
  window.__feed = feed;
  window.api = async path => path.includes("session/feed") ? window.__feed : path.includes("sessions") ? { sessions: [session] } : {};
  const realFetch = window.fetch;
  window.fetch = async (u, o) => {
    const url = String(u && u.url || u);
    if (url.includes("/api/session/attach")) { window.__uploads.push({}); return new Response(JSON.stringify({ ok: true, match: "m1" }), { headers: { "content-type": "application/json" } }); }
    if (url.includes("/api/session/act")) { window.__uploads.push({ act: JSON.parse(o.body || "{}") }); return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); }
    return realFetch(u, o);
  };
  openDrill(session.sid, session.name);
}, { feed: F, session: S });
await p.waitForTimeout(900);

const vis = s => p.evaluate(x => { const e = document.querySelector(x); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, s);
const css = (sel, prop) => p.evaluate(([s, k]) => { const e = document.querySelector(s); return e ? getComputedStyle(e)[k] : null; }, [sel, prop]);
const shot = (name, clip) => p.screenshot({ path: join(OUT, name + ".png"), ...(clip ? { clip } : {}) });

// ── 1. the attach sheet ─────────────────────────────────────────────────────────────────────────
console.log("\n1. Photos / Files");
check(!(await vis("#addctx .ctxcard")), "no sheet at rest");
await p.evaluate(() => { window.__picks.length = 0; });
await click("#datt"); await p.waitForTimeout(400);
const pickedOnTap = await p.evaluate(() => window.__picks.slice());
check(pickedOnTap.length === 0, `the paperclip opens no picker of its own (fired: ${JSON.stringify(pickedOnTap)})`);
check(await vis("#addctx .ctxcard"), "it opens the sheet");
const cards = await p.evaluate(() => [...document.querySelectorAll("#addctx .ctxcard")].map(c => ({
  label: c.querySelector("span")?.textContent || "", target: c.dataset.pick,
  w: +c.getBoundingClientRect().width.toFixed(2), h: +c.getBoundingClientRect().height.toFixed(2),
  hasGlyph: !!c.querySelector("svg"),
})));
check(cards.length === 2, `two cards (${cards.length})`);
check(cards.map(c => c.label).join(",") === "Photos,Files", `labelled Photos, Files (${cards.map(c => c.label).join(",")})`);
// The card that was measured on the owner's device and removed. Telegram's WebView intercepts the
// file chooser with its own picker, which reads `accept` and ignores `capture`, so a Camera card
// opened the photo library exactly like Photos did. This check is what stops it coming back on the
// reasoning that `capture` is in the spec — it is, and this client does not honour it.
check(!(await p.evaluate(() => !!document.getElementById("dfcam"))), "no camera input — `capture` is ignored by Telegram's picker, measured on-device");
// `.every` on an empty list is true, which on the pre-change page (no cards at all) is a check that
// cannot fail — the harness's own first rule. The length term is what makes it a claim.
check(cards.length === 2 && cards.every(c => c.hasGlyph), "each carries its glyph above the label");
check(cards.length === 2 && new Set(cards.map(c => c.w)).size === 1, `equal widths (${cards.map(c => c.w).join(" / ")})`);
note(`card box ${cards[0]?.w} x ${cards[0]?.h} (the reference's HEIGHT is 76; width divides the row)`);
// The ✕ leads and the title centres on the SHEET, not on the space the ✕ leaves — that is what the
// .dialhead::after mirror buys, and it is the reference's shape.
const head = await p.evaluate(() => {
  const s = document.querySelector("#addctx .ctxsheet"), t = document.querySelector("#addctx .dialhead .t"), x = document.querySelector("#addctx .dialhead .lead");
  if (!s || !t || !x) return null;
  const sr = s.getBoundingClientRect(), tr = t.getBoundingClientRect(), xr = x.getBoundingClientRect();
  return { title: t.textContent, drift: +((tr.left + tr.width / 2) - (sr.left + sr.width / 2)).toFixed(2), xLeftOfTitle: xr.right <= tr.left };
});
check(!!head && Math.abs(head.drift) < 1, `the title sits on the sheet's centre (drift ${head?.drift ?? "n/a"}px)`);
check(!!head && head.xLeftOfTitle, "the ✕ leads, top-left");
note(`title copy: "${head?.title}"`);
const inputs = await p.evaluate(() => ["dfpho", "dfile"].map(id => {
  const e = document.getElementById(id);
  return e ? { id, accept: e.getAttribute("accept") || "", multiple: e.multiple } : { id, missing: true };
}));
check(inputs[0].accept === "image/*" && inputs[0].multiple === true, `Photos' input is images, several (${JSON.stringify(inputs[0])})`);
check(inputs[1].accept === "" && inputs[1].multiple === true, `Files' input is anything, several (${JSON.stringify(inputs[1])})`);
await shot("1-sheet");
// Each card fires ITS OWN input and closes the sheet.
for (const c of cards) {
  await p.evaluate(() => { window.__picks.length = 0; });
  if (!(await vis("#addctx .ctxcard"))) await click("#datt"), await p.waitForTimeout(300);
  await click(`#addctx .ctxcard[data-pick="${c.target}"]`); await p.waitForTimeout(400);
  const fired = await p.evaluate(() => window.__picks.slice());
  check(fired.length === 1 && fired[0] === c.target, `${c.label} opens #${c.target} and nothing else (${JSON.stringify(fired)})`);
  check(!(await vis("#addctx .ctxcard")), `${c.label} closes the sheet on the tap`);
}

// ── 2. the composer's IME instruction ───────────────────────────────────────────────────────────
console.log("\n2. inline predictions");
const ime = await p.evaluate(() => {
  const e = document.getElementById("dtext"); if (!e) return null;
  return { autocomplete: e.getAttribute("autocomplete"), autocorrect: e.getAttribute("autocorrect"),
    writing: e.getAttribute("writingsuggestions"), spell: e.getAttribute("spellcheck"),
    font: getComputedStyle(e).fontFamily };
});
check(ime?.autocorrect === "off", `autocorrect="off" — the attribute Chromium maps to Android's TYPE_TEXT_FLAG_NO_SUGGESTIONS (${ime?.autocorrect})`);
check(ime?.writing === "false", `writingsuggestions="false" (${ime?.writing})`);
check(ime?.autocomplete === "off" && ime?.spell === "false", "the two that were already there are still there");
// The claim that geometry did not move. The composer's settled pill is derived from the mic and is
// what a font change would silently drag — see --pill-h-1.
const pill = await p.evaluate(() => +document.querySelector(".inputwrap").getBoundingClientRect().height.toFixed(2));
check(pill === 52, `the one-line capsule is still 52px (${pill})`);
note("NOT VERIFIABLE FROM THIS BOX: whether the keyboard stops drawing the prediction. No Android");
note("device here and headless Chromium has no IME. Needs one message typed on the owner's phone.");

// ── 3. one staged file ──────────────────────────────────────────────────────────────────────────
console.log("\n3. \"1 attachment\"");
await p.setInputFiles("#dfile", PHOTO); await p.waitForTimeout(400);
const one = await p.evaluate(() => document.querySelector("#dstage .nm")?.textContent ?? "");
check(one === "1 attachment", `one file reads "1 attachment" (got "${one}")`);
check(!one.includes(".png"), "the filename is not in the strip");
const title = await p.evaluate(() => document.querySelector("#dstage .x")?.getAttribute("aria-label") ?? "");
check(title.includes("Screenshot_20260727-124620_Telegram~2.png"), `…but it is still on the discard control (${JSON.stringify(title)})`);
await shot("3-stage-one", await p.evaluate(() => { const r = document.getElementById("ddock").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
await p.setInputFiles("#dfile", [PHOTO2]); await p.waitForTimeout(300);
const two = await p.evaluate(() => document.querySelector("#dstage .nm")?.textContent ?? "");
check(two === "2 attachments", `two files still read "2 attachments" (got "${two}")`);
await p.evaluate(() => clearStage()); await p.waitForTimeout(200);

// ── 4. slash commands ───────────────────────────────────────────────────────────────────────────
console.log("\n4. no double render");
const send = async text => {
  await p.evaluate(t => { document.getElementById("dtext").value = t; syncComposerMode(); }, text);
  await p.waitForTimeout(150);
  await click("#dsend"); await p.waitForTimeout(500);
  return p.evaluate(() => [...document.querySelectorAll("#dfeed .msg.user")].map(e => e.textContent.trim()));
};
const afterClear = await send("/clear");
check(!afterClear.some(t => t.startsWith("/clear")), `/clear paints no blue bubble (${JSON.stringify(afterClear.filter(t => t.startsWith("/")))})`);
// What the owner actually sees a second later: the daemon's feed for a cleared session, which
// carries no rows at all (the /clear entry is dropped in transcript.ts — see its own tests). The
// client half of the claim is that an empty payload renders the SAME empty state a new session
// shows, with no leftover optimistic bubble standing in it.
await p.evaluate(() => { window.__feed = { ...window.__feed, items: [] }; renderDrill(); });
await p.waitForTimeout(600);
const cleared = await p.evaluate(() => document.getElementById("dfeed").textContent.trim());
check(cleared === "No conversation yet.", `a cleared session shows the new-session empty state (got ${JSON.stringify(cleared.slice(0, 60))})`);
await shot("4-after-clear");
await p.evaluate(items => { window.__feed = { ...window.__feed, items }; renderDrill(); }, CHAT);
await p.waitForTimeout(500);
const afterCtx = await send("/context");
check(!afterCtx.some(t => t.startsWith("/context")), "…and neither does /context — the rule is the CLASS, not one command");
// The two controls that keep the rule narrow. Prose still gets its optimistic bubble, and a path
// that merely starts with a slash is prose.
const afterProse = await send("just a message");
check(afterProse.some(t => t.startsWith("just a message")), "ordinary prose still shows instantly");
const afterPath = await send("/tmp/foo is where I put it");
check(afterPath.some(t => t.startsWith("/tmp/foo")), "a PATH is prose and keeps its bubble — one segment, no second slash");
// The invocation line's type: prose, like the tool and thought lines beside it, not the grey chip.
const cmdType = await p.evaluate(() => {
  const feed = document.getElementById("dfeed");
  feed.innerHTML = '<div class="msg command"><div class="cn">/context</div><div class="co">Context: 42%</div></div>'
    + '<div class="msg activity">Read 3 files</div>';
  const cn = getComputedStyle(feed.querySelector(".cn")), act = getComputedStyle(feed.querySelector(".activity"));
  return { size: cn.fontSize, colour: cn.color, actSize: act.fontSize, actColour: act.color };
});
check(cmdType.size === cmdType.actSize, `the invocation is the tool line's size (${cmdType.size} vs ${cmdType.actSize})`);
check(cmdType.colour === cmdType.actColour, `…and its colour (${cmdType.colour} vs ${cmdType.actColour})`);
await shot("4-command-row", await p.evaluate(() => {
  const a = document.querySelector("#dfeed .msg.command").getBoundingClientRect();
  const b = document.querySelector("#dfeed .msg.activity").getBoundingClientRect();
  return { x: 0, y: Math.floor(a.top) - 8, width: 375, height: Math.ceil(b.bottom - a.top) + 16 };
}));
await p.evaluate(() => { feedSig = ""; paintFeed(); }); await p.waitForTimeout(300);

// ── 5. the chat title ───────────────────────────────────────────────────────────────────────────
console.log("\n5. the header loses its capsule");
const dt = await p.evaluate(() => {
  const e = document.querySelector("#drill .dtitle"), s = getComputedStyle(e);
  return { bg: s.backgroundColor, shadow: s.boxShadow, filter: s.backdropFilter || s.webkitBackdropFilter };
});
const clear = c => c === "rgba(0, 0, 0, 0)" || c === "transparent";
check(clear(dt.bg), `no fill (${dt.bg})`);
check(dt.shadow === "none", `no rim (${dt.shadow})`);
check(dt.filter === "none" || !dt.filter, `no frost (${dt.filter})`);
// …and the two side chips KEEP theirs. The owner scoped the ask to the pill.
const btn = await p.evaluate(() => { const s = getComputedStyle(document.getElementById("dback")); return { bg: s.backgroundColor, shadow: s.boxShadow }; });
check(!clear(btn.bg) && btn.shadow !== "none", `the back chip keeps its fill and rim (${btn.bg})`);
// Text formatting and the indicator, byte-for-byte.
const txt = await p.evaluate(() => {
  const n = getComputedStyle(document.getElementById("dname")), u = getComputedStyle(document.getElementById("dsub"));
  const dot = document.getElementById("ddot");
  const halo = s => s.webkitTextStrokeWidth + " / " + s.textShadow;
  return { nSize: n.fontSize, nWeight: n.fontWeight, uSize: u.fontSize, uColour: u.color,
    nShadow: halo(n), uShadow: halo(u), dot: !!dot && getComputedStyle(dot).width };
});
check(txt.nSize === "12px" && txt.nWeight === "600", `the name is unchanged: ${txt.nSize} / ${txt.nWeight}`);
check(txt.uSize === "11px", `the cwd is unchanged: ${txt.uSize}`);
check(txt.dot === "9px", `the status indicator is untouched (${txt.dot})`);
const bare = s => !s || /^0px \/ none$/.test(s);
check(!bare(txt.nShadow) && !bare(txt.uShadow), `both lines carry the halo (${txt.nShadow})`);
// Two identical "none"s are equal, which is a check that cannot fail. Both terms, so the pre-change
// page — where neither line carries anything — fails it.
check(!bare(txt.nShadow) && txt.nShadow === txt.uShadow, "…the SAME halo — one title in two sizes, never two treatments");

// The worst case, per the orchestrator: light theme, transcript scrolled so a bright bubble sits
// directly behind BOTH lines. Hit-tested, never rect-overlapped: a message clipped by the scroller
// still reports a rect spanning the header band, so overlap passes on a layout where nothing is
// actually behind the text.
const LIGHT = { "--tg-theme-bg-color": "#ffffff", "--tg-theme-secondary-bg-color": "#f1f1f1",
  "--tg-theme-text-color": "#000000", "--tg-theme-hint-color": "#707579",
  "--tg-theme-button-color": "#3390ec", "--tg-theme-button-text-color": "#ffffff" };
async function behindTitle() {
  return p.evaluate(() => {
    const feed = document.getElementById("dfeed");
    const probe = () => ["dname", "dsub"].every(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      const y = r.top + r.height / 2;
      // Scan a BAND across the line, not one point: a single probe lands in the gutter between two
      // messages and reports nothing behind a line that is fully covered.
      for (let x = r.left; x < r.right; x += 6)
        if (document.elementsFromPoint(x, y).some(e => e.classList && e.classList.contains("user"))) return true;
      return false;
    });
    for (let top = 0; top < feed.scrollHeight; top += 8) { feed.scrollTop = top; if (probe()) return top; }
    return -1;
  });
}
const band = await p.evaluate(() => { const h = document.querySelector("#drill .vhead").getBoundingClientRect(); return { x: 0, y: 0, width: 375, height: Math.ceil(h.bottom + 6) }; });
const inks = {};
for (const [theme, vars] of [["dark", null], ["light", LIGHT]]) {
  await p.evaluate(v => { const r = document.documentElement;
    if (v) for (const [k, val] of Object.entries(v)) r.style.setProperty(k, val);
    else for (const k of [...r.style].filter(k => k.startsWith("--tg-theme"))) r.style.removeProperty(k); }, vars);
  await p.waitForTimeout(250);
  // The ink colour halo.py measures AGAINST, read from the page per theme rather than restated in
  // the probe. Inferring ink from "the biggest excursion in the crop" is what a first version did,
  // and a halo breaks it by construction: the halo is itself an extreme excursion, so on the very
  // frames the halo is working the probe measured halo-against-bubble and reported the change as a
  // regression. The glyph's own colour is not a guess and is right on every frame.
  inks[theme] = await p.evaluate(() => ({
    name: getComputedStyle(document.getElementById("dname")).color,
    sub: getComputedStyle(document.getElementById("dsub")).color,
  }));
  // KNOWN-TRUTH CONTROL first: the same lines over flat --bg. The probe must return the design
  // contrast here, or no number it reports over a bubble means anything.
  await p.evaluate(() => { document.getElementById("dfeed").scrollTop = 0; }); await p.waitForTimeout(200);
  await shot(`5-${theme}-flat`, band);
  const at = await behindTitle();
  check(at >= 0, `${theme}: found a scroll position with a bubble behind both lines (${at})`);
  await p.waitForTimeout(200);
  await shot(`5-${theme}-bubble`, band);
  // …and the same frame with the halo switched off, which is the control that says the halo is
  // doing work the steeper scrim does not do on its own. BOTH halves come off: the stroke is the
  // dense part and the shadows are its falloff, so killing only one measures a third treatment
  // that does not ship.
  const off = await p.addStyleTag({ content: "#dname, #dsub { text-shadow: none !important; -webkit-text-stroke: 0 !important }" });
  await p.waitForTimeout(150);
  await shot(`5-${theme}-bubble-nohalo`, band);
  await off.evaluate(e => e.remove());
  await p.waitForTimeout(150);
  await shot(`5-${theme}-full`);
}
// ── 6. one plane ────────────────────────────────────────────────────────────────────────────────
// Everything in the transcript has to dissolve into the ceiling scrim at the same rate. The "tap to
// expand" bar did not: it carries `z-index: 1` so it sits above its own bubble's fold veil, and with
// #dfeed at `z-index: auto` that 1 landed in #drill's context beside the scrim's own 1, where tree
// order handed the label the win. It scrolled up behind the title at full strength.
//
// Measured as PIXELS, because nothing in the DOM says which of two equal z-indexes painted last:
// `elementsFromPoint` reports hit order, not paint order, and would have passed on the broken page.
// The claim is that the label's ink loses contrast under the scrim the way its neighbours do.
console.log("\n6. the fold label is in the transcript's plane");
// A message long enough to clip (LONG_MSG), so a real .more bar exists to measure.
await p.evaluate(items => { window.__feed = { ...window.__feed, items }; feedSig = ""; renderDrill(); },
  [{ role: "assistant", uuid: "big", ts: ts, text: "x ".repeat(700) }, ...CHAT]);
await p.waitForTimeout(700);
// Comparing the label's ink in the band against its ink lower down does NOT work, and the failed
// version is worth keeping in view: the label's rect, once it is inside the band, also contains the
// HEADER's glyphs painted on top of it, so the crop reported more contrast veiled than open. The
// question is not how much ink is in that strip. It is whether the SCRIM reaches the label at all.
//
// So: toggle the scrim and diff. `.more` carries an opaque `background: var(--bg)`, so a label under
// the scrim changes when the scrim goes away and a label over it does not — by construction, with no
// colour or theme assumption. The header paints identically in both shots and cancels out of the
// diff. A neighbouring message line at the same height is the control: it is unarguably in the
// transcript's plane, so it fixes the scale the label has to match.
const { execFileSync } = await import("node:child_process");
const diffAt = async sel => {
  const clip = await p.evaluate(s => {
    const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    if (r.height < 4 || r.width < 4) return null;
    return { x: Math.max(0, Math.round(r.x)), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }, sel);
  if (!clip) return null;
  const on = await p.screenshot({ clip });
  const off = await p.addStyleTag({ content: "#drill::before { display: none !important }" });
  await p.waitForTimeout(120);
  const bare = await p.screenshot({ clip });
  await off.evaluate(e => e.remove());
  await p.waitForTimeout(120);
  const b64 = [on, bare].map(x => x.toString("base64")).join("\n");
  return Number(execFileSync("python3", ["-c", `
import base64, io, sys
from PIL import Image
a, b = [Image.open(io.BytesIO(base64.b64decode(l))).convert("L") for l in sys.stdin.read().split()]
pa, pb = a.load(), b.load()
d = [abs(pa[x, y] - pb[x, y]) for y in range(a.size[1]) for x in range(a.size[0])]
print(round(sum(d) / len(d), 2))
`], { input: b64 }).toString().trim());
};
// Scroll until the label sits inside the band the scrim covers.
const landed = await p.evaluate(() => {
  const feed = document.getElementById("dfeed"), head = document.querySelector("#drill .vhead");
  const hb = head.getBoundingClientRect();
  for (let top = 0; top < feed.scrollHeight; top += 4) {
    feed.scrollTop = top;
    const r = document.querySelector("#dfeed .msg.clip .more")?.getBoundingClientRect();
    if (r && r.top >= hb.top && r.bottom <= hb.bottom) return top;
  }
  return -1;
});
check(landed >= 0, `found a scroll position with the fold label inside the header band (${landed})`);
await p.waitForTimeout(300);
await shot("6-fold-label-behind-header", band);
const labelDelta = await diffAt("#dfeed .msg.clip .more");
const peerDelta = await diffAt("#dfeed .msg.clip");
check(peerDelta !== null && peerDelta > 2, `the CONTROL moves when the scrim does — a message in the band is veiled (${peerDelta})`);
check(labelDelta !== null && peerDelta !== null && labelDelta > peerDelta * 0.5,
  `…and so does the fold label, at the same rate (${labelDelta} vs the message's ${peerDelta})`);
await p.evaluate(items => { window.__feed = { ...window.__feed, items }; feedSig = ""; renderDrill(); }, CHAT);
await p.waitForTimeout(400);

// The two line boxes, in page coordinates, so halo.py can crop exactly them out of a band shot
// rather than guessing where the text is. dpr is what turns them into pixels.
// …and it is the TEXT's box, via a Range over the node's contents, not the element's. #dsub is a
// block spanning the whole title while its text is short and centred, so its element box is mostly
// empty background — and an empty slice of background carrying nothing but the halo's outer bleed
// reported a 1.4:1 "worst case" on flat page colour, i.e. a failure the probe invented. Measuring
// the glyph run itself removes the problem at the source rather than filtering it downstream.
const rects = await p.evaluate(() => {
  const r = id => {
    const rng = document.createRange(); rng.selectNodeContents(document.getElementById(id));
    const b = rng.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  };
  return { name: r("dname"), sub: r("dsub") };
});
writeFileSync(join(OUT, "rects.json"), JSON.stringify({ rects, inks, dpr: 2, band }, null, 2));

await b.close();
console.log(bad ? `\n${bad} FAILED` : "\nall checks passed");
console.log(`shots + rects.json in ${OUT}`);
process.exit(bad ? 1 : 0);
